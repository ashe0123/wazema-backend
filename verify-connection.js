/**
 * Quick database connection and admin verification script
 * Run: node verify-connection.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set in .env');
  process.exit(1);
}

console.log('🔍 Testing database connection...');
console.log('📍 Database URL:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000,
});

async function verify() {
  try {
    // Test connection
    console.log('\n1️⃣ Testing PostgreSQL connection...');
    const result = await pool.query('SELECT NOW() as time, version() as version');
    console.log('✅ Connected successfully!');
    console.log('   Server time:', result.rows[0].time);
    console.log('   PostgreSQL version:', result.rows[0].version.split(',')[0]);

    // Check if admins table exists
    console.log('\n2️⃣ Checking admins table...');
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'admins'
      ) as exists
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('❌ Admins table does not exist');
      console.log('   Run: node server.js (to initialize schema)');
      process.exit(1);
    }
    console.log('✅ Admins table exists');

    // Check admin users
    console.log('\n3️⃣ Checking admin users...');
    const admins = await pool.query('SELECT id, username FROM admins');
    
    if (admins.rows.length === 0) {
      console.log('❌ No admin users found');
      console.log('   Run: node reset-admin.js');
      process.exit(1);
    }

    console.log(`✅ Found ${admins.rows.length} admin(s):`);
    admins.rows.forEach(admin => {
      console.log(`   - ${admin.username} (ID: ${admin.id})`);
    });

    // Test admin password
    console.log('\n4️⃣ Testing admin password...');
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'greetingamerica1187';
    
    const admin = await pool.query('SELECT * FROM admins WHERE username = $1', [adminUsername]);
    
    if (admin.rows.length === 0) {
      console.log(`❌ Admin user "${adminUsername}" not found`);
      console.log('   Available users:', admins.rows.map(a => a.username).join(', '));
      process.exit(1);
    }

    const passwordMatch = bcrypt.compareSync(adminPassword, admin.rows[0].password);
    
    if (passwordMatch) {
      console.log(`✅ Password verified for "${adminUsername}"`);
    } else {
      console.log(`❌ Password does NOT match for "${adminUsername}"`);
      console.log('   Run: node reset-admin.js');
      process.exit(1);
    }

    // Check members table
    console.log('\n5️⃣ Checking members...');
    const members = await pool.query('SELECT COUNT(*) as count FROM members');
    console.log(`✅ Found ${members.rows[0].count} member(s)`);

    console.log('\n✅ ALL CHECKS PASSED!');
    console.log('\n📋 Summary:');
    console.log('   ✅ Database connection: OK');
    console.log('   ✅ Schema initialized: OK');
    console.log(`   ✅ Admin login: ${adminUsername} / ${adminPassword}`);
    console.log(`   ✅ Members: ${members.rows[0].count}`);
    console.log('\n🚀 Your system is ready to use!');
    console.log(`   Admin login: https://wazema-backend.onrender.com`);
    console.log(`   Frontend: https://wazema-frontend.vercel.app`);

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verify();
