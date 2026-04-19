/**
 * db.js — Unified async database layer
 *
 * Priority: PostgreSQL (DATABASE_URL) → Turso → Local SQLite
 * All routes use: db.one(), db.all(), db.run(), db.exec()
 */
require('dotenv').config();
const path   = require('path');
const bcrypt = require('bcryptjs');

let db;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  console.log('🐘 Using PostgreSQL database');
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Test connection immediately on startup
  pool.query('SELECT 1').then(() => {
    console.log('✅ PostgreSQL connected successfully');
  }).catch(e => {
    console.error('❌ PostgreSQL connection FAILED:', e.message);
  });

  // Convert SQLite-style ? placeholders → $1, $2 ...
  function pgSql(sql) {
    let i = 0;
    return sql
      .replace(/\?/g, () => `$${++i}`)
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/CURRENT_DATE/gi, 'CURRENT_DATE')
      .replace(/INSERT OR IGNORE/gi, 'INSERT')
      .replace(/\bAUTOINCREMENT\b/gi, '')
      .replace(/strftime\('%Y-%m',\s*([^)]+)\)/gi, "TO_CHAR($1::date, 'YYYY-MM')")
      .replace(/strftime\('%Y',\s*([^)]+)\)/gi, "TO_CHAR($1::date, 'YYYY')")
      .replace(/substr\(([^,]+),\s*1,\s*7\)/gi, "LEFT($1, 7)")
      .replace(/COALESCE\(SUM\(([^)]+)\),0\)/gi, 'COALESCE(SUM($1), 0)');
  }

  async function query(sql, params = []) {
    const { rows, rowCount } = await pool.query(pgSql(sql), params);
    return { rows: coerceRows(rows), rowCount };
  }

  function coerceRows(rows) {
    // Coerce numeric/integer columns that pg returns as strings
    const numericFields = new Set(['amount','penalty','monthly_saving','saving_interest_pct',
      'share_amount','registration_fee','total_saved','eligibility','balance','rate',
      'interest_amount','total_pool','member_share','queue_position','share_qty',
      'age','share_paid','reg_fee_paid','third_party_signed','active','year']);
    return rows.map(row => {
      if (!row || typeof row !== 'object') return row;
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== undefined && typeof v === 'string' &&
            (numericFields.has(k) || /^(t|c|m)$/.test(k))) {
          const n = Number(v);
          out[k] = isNaN(n) ? v : n;
        } else {
          out[k] = v;
        }
      }
      return out;
    });
  }

  db = {
    _type: 'pg',
    query,  // expose raw query for routes that need it
    async one(sql, params = [])  { const r = await query(sql, params); return r.rows[0] || null; },
    async all(sql, params = [])  { const r = await query(sql, params); return r.rows; },
    async run(sql, params = [])  {
      const r = await query(sql, params);
      return { rowCount: r.rowCount, lastId: r.rows[0]?.id };
    },
    async exec(sql) {
      const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const s of stmts) {
        try { await query(s, []); } catch(e) {
          if (!e.message.includes('already exists') && !e.message.includes('duplicate')) {
            console.warn('[exec warn]', e.message.slice(0, 80));
          }
        }
      }
    },
    // Transaction support: runs callback(client) inside BEGIN/COMMIT, rolls back on error
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txDb = {
          _type: 'pg',
          async one(sql, params = [])  { const r = await client.query(pgSql(sql), params); const rows = coerceRows(r.rows); return rows[0] || null; },
          async all(sql, params = [])  { const r = await client.query(pgSql(sql), params); return coerceRows(r.rows); },
          async run(sql, params = [])  { const r = await client.query(pgSql(sql), params); return { rowCount: r.rowCount, lastId: r.rows[0]?.id }; },
          async exec(sql)              { await client.query(pgSql(sql)); },
        };
        const result = await fn(txDb);
        await client.query('COMMIT');
        return result;
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };

  // Initialize schema then seed admin + settings
  // Small delay lets the pool stabilize before running many queries
  setTimeout(() => {
    initPgSchema().then(() => seedPg()).catch(e => console.error('PG init error:', e.message));
  }, 2000);

  async function initPgSchema() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '',
        middle_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT,
        join_date TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'Regular',
        monthly_saving NUMERIC NOT NULL DEFAULT 500, saving_interest_pct NUMERIC NOT NULL DEFAULT 0,
        share_amount NUMERIC NOT NULL DEFAULT 1000, share_qty INTEGER NOT NULL DEFAULT 1,
        registration_fee NUMERIC NOT NULL DEFAULT 300, share_paid INTEGER NOT NULL DEFAULT 0,
        reg_fee_paid INTEGER NOT NULL DEFAULT 0, date_of_birth TEXT DEFAULT NULL,
        age INTEGER DEFAULT NULL, gender TEXT DEFAULT NULL, address TEXT DEFAULT NULL,
        photo_url TEXT DEFAULT NULL, id_document_url TEXT DEFAULT NULL,
        payment_receipt_url TEXT DEFAULT NULL, exit_reason TEXT DEFAULT NULL,
        exit_date TEXT DEFAULT NULL, exit_notes TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'active', password TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS savings (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
        month TEXT NOT NULL, amount NUMERIC NOT NULL, paid_date TEXT,
        status TEXT NOT NULL DEFAULT 'paid', penalty NUMERIC NOT NULL DEFAULT 0,
        receipt_url TEXT DEFAULT NULL,
        bank_name TEXT DEFAULT NULL, account_number TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(member_id, month)
      );
      CREATE TABLE IF NOT EXISTS loans (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
        amount NUMERIC NOT NULL, request_date TEXT NOT NULL, approve_date TEXT,
        status TEXT NOT NULL DEFAULT 'pending', queue_position INTEGER,
        third_party_ref TEXT, third_party_signed INTEGER DEFAULT 0,
        rejection_reason TEXT DEFAULT NULL, admin_note TEXT DEFAULT NULL,
        disbursement_date TEXT DEFAULT NULL, guarantor_name TEXT DEFAULT NULL,
        guarantor_phone TEXT DEFAULT NULL, guarantor_doc_url TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS repayments (
        id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id),
        month TEXT NOT NULL, amount NUMERIC NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        paid_date TEXT, penalty NUMERIC NOT NULL DEFAULT 0, receipt_url TEXT DEFAULT NULL,
        bank_name TEXT DEFAULT NULL, account_number TEXT DEFAULT NULL,
        UNIQUE(loan_id, month)
      );
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, label TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal', active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_savings_member   ON savings(member_id);
      CREATE INDEX IF NOT EXISTS idx_savings_month    ON savings(month);
      CREATE INDEX IF NOT EXISTS idx_loans_member     ON loans(member_id);
      CREATE INDEX IF NOT EXISTS idx_loans_status     ON loans(status);
      CREATE INDEX IF NOT EXISTS idx_repayments_loan  ON repayments(loan_id);
      CREATE INDEX IF NOT EXISTS idx_repayments_month ON repayments(month);
      CREATE TABLE IF NOT EXISTS payment_banks (
        id SERIAL PRIMARY KEY,
        bank_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        account_holder TEXT NOT NULL DEFAULT 'Wazema SCBC',
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS questionnaires (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        questions JSONB NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS questionnaire_responses (
        id SERIAL PRIMARY KEY,
        questionnaire_id INTEGER NOT NULL REFERENCES questionnaires(id),
        member_id TEXT NOT NULL REFERENCES members(id),
        answers JSONB NOT NULL DEFAULT '{}',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(questionnaire_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS member_notifications (
        id SERIAL PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        reference_id TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_member ON member_notifications(member_id);
      CREATE TABLE IF NOT EXISTS interest_accruals (
        id SERIAL PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
        month TEXT NOT NULL, balance NUMERIC NOT NULL, rate NUMERIC NOT NULL,
        interest_amount NUMERIC NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(member_id, month)
      );
      CREATE TABLE IF NOT EXISTS dividends (
        id SERIAL PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
        year INTEGER NOT NULL, share_qty INTEGER NOT NULL DEFAULT 1,
        total_pool NUMERIC NOT NULL DEFAULT 0, member_share NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', paid_date TEXT DEFAULT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(member_id, year)
      );
    `);
    console.log('✅ PostgreSQL schema ready');
    // Run column migrations for existing databases
    await runPgMigrations();
  }

  async function runPgMigrations() {
    const migrations = [
      // savings: bank columns
      `ALTER TABLE savings ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT NULL`,
      `ALTER TABLE savings ADD COLUMN IF NOT EXISTS account_number TEXT DEFAULT NULL`,
      // repayments: bank columns
      `ALTER TABLE repayments ADD COLUMN IF NOT EXISTS bank_name TEXT DEFAULT NULL`,
      `ALTER TABLE repayments ADD COLUMN IF NOT EXISTS account_number TEXT DEFAULT NULL`,
      // loans: third-party document
      `ALTER TABLE loans ADD COLUMN IF NOT EXISTS third_party_doc_url TEXT DEFAULT NULL`,
      // members: ensure all columns exist
      `ALTER TABLE members ADD COLUMN IF NOT EXISTS saving_interest_pct NUMERIC NOT NULL DEFAULT 0`,
      // new tables
      `CREATE TABLE IF NOT EXISTS questionnaires (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT, questions JSONB NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS questionnaire_responses (id SERIAL PRIMARY KEY, questionnaire_id INTEGER NOT NULL, member_id TEXT NOT NULL, answers JSONB NOT NULL DEFAULT '{}', submitted_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_unique ON questionnaire_responses(questionnaire_id, member_id)`,
      `CREATE TABLE IF NOT EXISTS member_notifications (id SERIAL PRIMARY KEY, member_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, reference_id TEXT DEFAULT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS idx_notif_member ON member_notifications(member_id)`,
    ];
    for (const sql of migrations) {
      try { await query(sql, []); } catch(e) {
        if (!e.message.includes('already exists')) console.warn('[migration warn]', e.message.slice(0, 80));
      }
    }
    console.log('✅ PostgreSQL migrations applied');
  }

  async function seedPg() {
    const adminRow = await db.one('SELECT COUNT(*) as c FROM admins');
    if (Number(adminRow.c) === 0) {
      const adminUser = process.env.ADMIN_USERNAME || 'admin';
      const adminPass = process.env.ADMIN_PASSWORD;
      if (!adminPass) {
        console.warn('⚠️  ADMIN_PASSWORD env var not set — using insecure default. Set it before deploying!');
      }
      const finalPass = adminPass || 'admin123';
      await db.run('INSERT INTO admins (username,password) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [adminUser, bcrypt.hashSync(finalPass, 10)]);
      console.log(`✅ Admin account created (${adminUser} / ${adminPass ? '********' : 'admin123 ⚠️ CHANGE THIS'})`);
    }
    await seedSettingsPg();
    await seedBanksPg();
  }

  async function seedBanksPg() {
    const row = await db.one('SELECT COUNT(*) as c FROM payment_banks');
    if (Number(row.c) > 0) return;
    const banks = [
      ['Commercial Bank of Ethiopia (CBE)', '1000000000000', 1],
      ['Awash Bank',                        '0123400000000', 2],
      ['Abyssinia Bank',                    '0987600000000', 3],
      ['Dashen Bank',                       '1234500000000', 4],
      ['Bank of Abyssinia',                 '9876500000000', 5],
    ];
    for (const [name, acc, order] of banks) {
      await db.run('INSERT INTO payment_banks (bank_name,account_number,account_holder,is_active,sort_order) VALUES ($1,$2,$3,1,$4)',
        [name, acc, 'Wazema SCBC', order]);
    }
    console.log('⚠️  Default payment banks seeded with PLACEHOLDER account numbers');
    console.log('   → Go to Admin → Settings → Banks to update with your real account numbers');
  }

  async function seedSettingsPg() {
    // Always upsert all settings (handles new keys added after initial seed)
    const settings = [
      ['org_name','Wazema Saving and Credit Basic Cooperative','Organization Name'],
      ['org_phone','+251911000000','Organization Phone'],
      ['org_email','admin@wazema-scbc.org','Organization Email'],
      ['org_address','Addis Ababa, Ethiopia','Organization Address'],
      ['savings_due_day','5','Savings Due Day (1-28)'],
      ['repayment_due_day','10','Loan Repayment Due Day (1-28)'],
      ['late_penalty_rate','0.02','Late Penalty Rate (e.g. 0.02 = 2%)'],
      ['loan_multiplier','3','Loan Eligibility Multiplier'],
      ['interest_rate','0.05','Default Loan Interest Rate'],
      ['repayment_months','12','Default Repayment Period (months)'],
      ['currency','ETB','Currency Symbol'],
      ['grace_period_days','3','Grace Period Before Penalty (days)'],
      ['savings_interest_enabled','0','Enable Savings Interest Accrual (1=yes)'],
    ];
    for (const [k,v,l] of settings) {
      await db.run('INSERT INTO settings (key,value,label) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label', [k,v,l]);
    }
    console.log('✅ Settings seeded');
  }

// ── Turso / SQLite ────────────────────────────────────────────────────────────
} else {
  const Database = require('better-sqlite3');
  let sqliteDb;

  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    console.log('🌐 Using Turso cloud database');
    const TursoClient = require('./turso');
    const turso = new TursoClient(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);
    sqliteDb = new Database(path.join(__dirname, 'wazema_replica.db'));
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    const origPrepare = sqliteDb.prepare.bind(sqliteDb);
    sqliteDb.prepare = function(sql) {
      const stmt = origPrepare(sql);
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = function(...args) {
          const result = origRun(...args);
          turso.execute(sql, args).catch(e => {
            if (!e.message.includes('UNIQUE constraint')) console.error('[Turso sync]', e.message);
          });
          return result;
        };
      }
      return stmt;
    };
  } else {
    console.log('💾 Using local SQLite database');
    sqliteDb = new Database(path.join(__dirname, 'wazema.db'));
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('synchronous = NORMAL');
  }

  db = {
    _type: 'sqlite',
    async one(sql, params = [])  { return sqliteDb.prepare(sql).get(...params) || null; },
    async all(sql, params = [])  { return sqliteDb.prepare(sql).all(...params); },
    async run(sql, params = [])  {
      const r = sqliteDb.prepare(sql).run(...params);
      return { rowCount: r.changes, lastId: r.lastInsertRowid };
    },
    async exec(sql) { sqliteDb.exec(sql); },
    // Transaction support for SQLite
    async transaction(fn) {
      const txDb = {
        _type: 'sqlite',
        async one(sql, params = [])  { return sqliteDb.prepare(sql).get(...params) || null; },
        async all(sql, params = [])  { return sqliteDb.prepare(sql).all(...params); },
        async run(sql, params = [])  { const r = sqliteDb.prepare(sql).run(...params); return { rowCount: r.changes, lastId: r.lastInsertRowid }; },
        async exec(sql)              { sqliteDb.exec(sql); },
      };
      return sqliteDb.transaction(() => fn(txDb))();
    },
  };

  initSqliteSchema(sqliteDb);
}

// ── SQLite schema + seed ──────────────────────────────────────────────────────
function initSqliteSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', middle_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT,
      join_date TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'Regular',
      monthly_saving REAL NOT NULL DEFAULT 500, saving_interest_pct REAL NOT NULL DEFAULT 0,
      share_amount REAL NOT NULL DEFAULT 1000, share_qty INTEGER NOT NULL DEFAULT 1,
      registration_fee REAL NOT NULL DEFAULT 300, share_paid INTEGER NOT NULL DEFAULT 0,
      reg_fee_paid INTEGER NOT NULL DEFAULT 0, date_of_birth TEXT, age INTEGER, gender TEXT, address TEXT,
      photo_url TEXT, id_document_url TEXT, payment_receipt_url TEXT,
      exit_reason TEXT, exit_date TEXT, exit_notes TEXT,
      status TEXT NOT NULL DEFAULT 'active', password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS savings (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
      month TEXT NOT NULL, amount REAL NOT NULL, paid_date TEXT,
      status TEXT NOT NULL DEFAULT 'paid', penalty REAL NOT NULL DEFAULT 0,
      receipt_url TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(member_id, month)
    );
    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
      amount REAL NOT NULL, request_date TEXT NOT NULL, approve_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending', queue_position INTEGER,
      third_party_ref TEXT, third_party_signed INTEGER DEFAULT 0,
      rejection_reason TEXT, admin_note TEXT, disbursement_date TEXT,
      guarantor_name TEXT, guarantor_phone TEXT, guarantor_doc_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS repayments (
      id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id),
      month TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      paid_date TEXT, penalty REAL NOT NULL DEFAULT 0, receipt_url TEXT, UNIQUE(loan_id, month)
    );
    CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, label TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_savings_member ON savings(member_id);
    CREATE INDEX IF NOT EXISTS idx_savings_month  ON savings(month);
    CREATE INDEX IF NOT EXISTS idx_loans_member   ON loans(member_id);
    CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);
    CREATE INDEX IF NOT EXISTS idx_repayments_loan  ON repayments(loan_id);
    CREATE INDEX IF NOT EXISTS idx_repayments_month ON repayments(month);
    CREATE TABLE IF NOT EXISTS interest_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
      month TEXT NOT NULL, balance REAL NOT NULL, rate REAL NOT NULL,
      interest_amount REAL NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(member_id, month)
    );
    CREATE TABLE IF NOT EXISTS dividends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
      year INTEGER NOT NULL, share_qty INTEGER NOT NULL DEFAULT 1,
      total_pool REAL NOT NULL DEFAULT 0, member_share REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', paid_date TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')), UNIQUE(member_id, year)
    );
    CREATE TABLE IF NOT EXISTS payment_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_name TEXT NOT NULL, account_number TEXT NOT NULL,
      account_holder TEXT NOT NULL DEFAULT 'Wazema SCBC',
      is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const migs = [
    ['SELECT share_qty FROM members LIMIT 1',          "ALTER TABLE members ADD COLUMN share_qty INTEGER NOT NULL DEFAULT 1"],
    ['SELECT date_of_birth FROM members LIMIT 1',      "ALTER TABLE members ADD COLUMN date_of_birth TEXT"],
    ['SELECT age FROM members LIMIT 1',                "ALTER TABLE members ADD COLUMN age INTEGER"],
    ['SELECT gender FROM members LIMIT 1',             "ALTER TABLE members ADD COLUMN gender TEXT"],
    ['SELECT address FROM members LIMIT 1',            "ALTER TABLE members ADD COLUMN address TEXT"],
    ['SELECT photo_url FROM members LIMIT 1',          "ALTER TABLE members ADD COLUMN photo_url TEXT"],
    ['SELECT id_document_url FROM members LIMIT 1',    "ALTER TABLE members ADD COLUMN id_document_url TEXT"],
    ['SELECT payment_receipt_url FROM members LIMIT 1',"ALTER TABLE members ADD COLUMN payment_receipt_url TEXT"],
    ['SELECT exit_reason FROM members LIMIT 1',        "ALTER TABLE members ADD COLUMN exit_reason TEXT"],
    ['SELECT exit_date FROM members LIMIT 1',          "ALTER TABLE members ADD COLUMN exit_date TEXT"],
    ['SELECT exit_notes FROM members LIMIT 1',         "ALTER TABLE members ADD COLUMN exit_notes TEXT"],
    ['SELECT guarantor_doc_url FROM loans LIMIT 1',    "ALTER TABLE loans ADD COLUMN guarantor_doc_url TEXT"],
    ['SELECT penalty FROM savings LIMIT 1',            "ALTER TABLE savings ADD COLUMN penalty REAL NOT NULL DEFAULT 0"],
    ['SELECT receipt_url FROM savings LIMIT 1',        "ALTER TABLE savings ADD COLUMN receipt_url TEXT"],
    ['SELECT penalty FROM repayments LIMIT 1',         "ALTER TABLE repayments ADD COLUMN penalty REAL NOT NULL DEFAULT 0"],
    ['SELECT receipt_url FROM repayments LIMIT 1',     "ALTER TABLE repayments ADD COLUMN receipt_url TEXT"],
    ['SELECT bank_name FROM savings LIMIT 1',          "ALTER TABLE savings ADD COLUMN bank_name TEXT"],
    ['SELECT account_number FROM savings LIMIT 1',     "ALTER TABLE savings ADD COLUMN account_number TEXT"],
    ['SELECT bank_name FROM repayments LIMIT 1',       "ALTER TABLE repayments ADD COLUMN bank_name TEXT"],
    ['SELECT account_number FROM repayments LIMIT 1',  "ALTER TABLE repayments ADD COLUMN account_number TEXT"],
  ];
  for (const [check, alter] of migs) {
    try { db.prepare(check).get(); } catch { try { db.exec(alter); } catch {} }
  }
  seedSqlite(db);
}

function seedSqlite(db) {
  if (db.prepare('SELECT COUNT(*) as c FROM admins').get().c === 0) {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) console.warn('⚠️  ADMIN_PASSWORD env var not set — using insecure default.');
    const finalPass = adminPass || 'admin123';
    db.prepare('INSERT OR IGNORE INTO admins (username,password) VALUES (?,?)').run(adminUser, bcrypt.hashSync(finalPass, 10));
    console.log(`✅ Admin account created (${adminUser} / ${adminPass ? '********' : 'admin123 ⚠️ CHANGE THIS'})`);
  }
  seedSettingsSqlite(db);
  seedBanksSqlite(db);
}

function seedBanksSqlite(db) {
  if (db.prepare('SELECT COUNT(*) as c FROM payment_banks').get().c > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO payment_banks (bank_name,account_number,account_holder,is_active,sort_order) VALUES (?,?,?,1,?)');
  [
    ['Commercial Bank of Ethiopia (CBE)', '1000000000000', 'Wazema SCBC', 1],
    ['Awash Bank',                        '0123400000000', 'Wazema SCBC', 2],
    ['Abyssinia Bank',                    '0987600000000', 'Wazema SCBC', 3],
    ['Dashen Bank',                       '1234500000000', 'Wazema SCBC', 4],
    ['Bank of Abyssinia',                 '9876500000000', 'Wazema SCBC', 5],
  ].forEach(([n,a,h,o]) => ins.run(n,a,h,o));
  console.log('⚠️  Default payment banks seeded with PLACEHOLDER account numbers');
  console.log('   → Go to Admin → Settings → Banks to update with your real account numbers');
}

function seedSettingsSqlite(db) {
  if (db.prepare('SELECT COUNT(*) as c FROM settings').get().c > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value,label) VALUES (?,?,?)');
  [['org_name','Wazema Saving and Credit Basic Cooperative','Organization Name'],['org_phone','+251911000000','Organization Phone'],['org_email','admin@wazema-scbc.org','Organization Email'],['org_address','Addis Ababa, Ethiopia','Organization Address'],['savings_due_day','5','Savings Due Day (1-28)'],['repayment_due_day','10','Loan Repayment Due Day (1-28)'],['late_penalty_rate','0.02','Late Penalty Rate (e.g. 0.02 = 2%)'],['loan_multiplier','3','Loan Eligibility Multiplier'],['interest_rate','0.05','Default Loan Interest Rate'],['repayment_months','12','Default Repayment Period (months)'],['currency','ETB','Currency Symbol'],['grace_period_days','3','Grace Period Before Penalty (days)'],['savings_interest_enabled','0','Enable Savings Interest Accrual (1=yes)']]
    .forEach(([k,v,l]) => ins.run(k,v,l));
}

module.exports = db;
