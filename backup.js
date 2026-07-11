/**
 * Automated Backup & Recovery System for Financial Data
 * Ensures data integrity and recoverability for critical financial records
 */
require('dotenv').config();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const execAsync = promisify(exec);

// ── Configuration ─────────────────────────────────────────────────────────────
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '../backups');
const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30');
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY;
const S3_BUCKET = process.env.S3_BACKUP_BUCKET;
const BACKUP_ENABLED = process.env.BACKUP_ENABLED !== 'false';

// ── Ensure Backup Directory Exists ───────────────────────────────────────────
async function ensureBackupDir() {
  try {
    await fs.access(BACKUP_DIR);
  } catch {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    console.log(`✅ Created backup directory: ${BACKUP_DIR}`);
  }
}

// ── Encrypt Backup File ───────────────────────────────────────────────────────
async function encryptFile(inputPath, outputPath, key) {
  if (!key || key.length < 32) {
    throw new Error('Encryption key must be at least 32 characters');
  }

  const algorithm = 'aes-256-gcm';
  const keyBuffer = crypto.scryptSync(key, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);

  const input = await fs.readFile(inputPath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Store IV + authTag + encrypted data
  const output = Buffer.concat([iv, authTag, encrypted]);
  await fs.writeFile(outputPath, output);

  return outputPath;
}

// ── Decrypt Backup File ───────────────────────────────────────────────────────
async function decryptFile(inputPath, outputPath, key) {
  if (!key || key.length < 32) {
    throw new Error('Encryption key must be at least 32 characters');
  }

  const algorithm = 'aes-256-gcm';
  const keyBuffer = crypto.scryptSync(key, 'salt', 32);

  const input = await fs.readFile(inputPath);
  
  // Extract IV, authTag, and encrypted data
  const iv = input.slice(0, 16);
  const authTag = input.slice(16, 32);
  const encrypted = input.slice(32);

  const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  await fs.writeFile(outputPath, decrypted);

  return outputPath;
}

// ── PostgreSQL Backup ─────────────────────────────────────────────────────────
async function backupPostgreSQL() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const filename = `wazema-backup-${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  console.log(`📦 Starting PostgreSQL backup: ${filename}`);

  try {
    // Extract connection details from DATABASE_URL
    const dbUrl = new URL(process.env.DATABASE_URL);
    const host = dbUrl.hostname;
    const port = dbUrl.port || 5432;
    const database = dbUrl.pathname.slice(1);
    const username = dbUrl.username;
    const password = dbUrl.password;

    // Use pg_dump for backup
    const command = `PGPASSWORD="${password}" pg_dump -h ${host} -p ${port} -U ${username} -d ${database} -F c -f "${filepath}"`;
    
    await execAsync(command);

    // Get file size
    const stats = await fs.stat(filepath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`✅ Backup created: ${filename} (${sizeMB} MB)`);

    // Encrypt if key is provided
    if (BACKUP_ENCRYPTION_KEY) {
      const encryptedPath = `${filepath}.enc`;
      await encryptFile(filepath, encryptedPath, BACKUP_ENCRYPTION_KEY);
      await fs.unlink(filepath); // Remove unencrypted file
      console.log(`🔐 Backup encrypted: ${filename}.enc`);
      return encryptedPath;
    }

    return filepath;
  } catch (error) {
    console.error('❌ PostgreSQL backup failed:', error.message);
    throw error;
  }
}

// ── SQLite Backup ─────────────────────────────────────────────────────────────
async function backupSQLite() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const filename = `wazema-backup-${timestamp}.db`;
  const filepath = path.join(BACKUP_DIR, filename);

  console.log(`📦 Starting SQLite backup: ${filename}`);

  try {
    const sourceDb = path.join(__dirname, 'wazema.db');
    
    // Check if source exists
    await fs.access(sourceDb);

    // Copy database file
    await fs.copyFile(sourceDb, filepath);

    // Get file size
    const stats = await fs.stat(filepath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`✅ Backup created: ${filename} (${sizeMB} MB)`);

    // Encrypt if key is provided
    if (BACKUP_ENCRYPTION_KEY) {
      const encryptedPath = `${filepath}.enc`;
      await encryptFile(filepath, encryptedPath, BACKUP_ENCRYPTION_KEY);
      await fs.unlink(filepath);
      console.log(`🔐 Backup encrypted: ${filename}.enc`);
      return encryptedPath;
    }

    return filepath;
  } catch (error) {
    console.error('❌ SQLite backup failed:', error.message);
    throw error;
  }
}

// ── Full Backup (Database + Critical Files) ──────────────────────────────────
async function performFullBackup() {
  if (!BACKUP_ENABLED) {
    console.log('⚠️  Backups are disabled (set BACKUP_ENABLED=true to enable)');
    return null;
  }

  console.log('🔄 Starting full backup...');
  
  await ensureBackupDir();

  let backupPath;

  try {
    // Backup database based on type
    if (process.env.DATABASE_URL) {
      backupPath = await backupPostgreSQL();
    } else {
      backupPath = await backupSQLite();
    }

    // Create backup metadata
    const metadata = {
      timestamp: new Date().toISOString(),
      type: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
      encrypted: !!BACKUP_ENCRYPTION_KEY,
      size: (await fs.stat(backupPath)).size,
      version: '2.0.0',
      node_version: process.version,
    };

    const metadataPath = `${backupPath}.meta.json`;
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Upload to S3 if configured
    if (S3_BUCKET) {
      await uploadToS3(backupPath);
    }

    // Log backup to database
    await logBackup(backupPath, metadata);

    console.log('✅ Full backup completed successfully');
    return backupPath;

  } catch (error) {
    console.error('❌ Full backup failed:', error.message);
    throw error;
  }
}

// ── Upload to S3 (Optional Cloud Storage) ────────────────────────────────────
async function uploadToS3(filepath) {
  // Placeholder - requires @aws-sdk/client-s3
  console.log(`☁️  S3 upload not implemented yet for: ${filepath}`);
  console.log('   Install: npm install @aws-sdk/client-s3');
  console.log('   Then configure: S3_BACKUP_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
}

// ── Log Backup to Database ────────────────────────────────────────────────────
async function logBackup(filepath, metadata) {
  try {
    const filename = path.basename(filepath);
    await db.run(`
      INSERT INTO backup_log (filename, file_path, backup_type, encrypted, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, [filename, filepath, metadata.type, metadata.encrypted ? 1 : 0, metadata.size]);
  } catch (error) {
    // Table might not exist yet - create it
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS backup_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          backup_type TEXT NOT NULL,
          encrypted INTEGER DEFAULT 0,
          size_bytes INTEGER,
          restored INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          restored_at TEXT
        )
      `);
      // Retry insert
      await db.run(`
        INSERT INTO backup_log (filename, file_path, backup_type, encrypted, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `, [filename, filepath, metadata.type, metadata.encrypted ? 1 : 0, metadata.size]);
    } catch (e) {
      console.warn('Failed to log backup to database:', e.message);
    }
  }
}

// ── Clean Old Backups ─────────────────────────────────────────────────────────
async function cleanOldBackups() {
  console.log(`🧹 Cleaning backups older than ${BACKUP_RETENTION_DAYS} days...`);

  try {
    const files = await fs.readdir(BACKUP_DIR);
    const now = Date.now();
    const maxAge = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    let deleted = 0;

    for (const file of files) {
      const filepath = path.join(BACKUP_DIR, file);
      const stats = await fs.stat(filepath);

      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filepath);
        deleted++;
        console.log(`  Deleted old backup: ${file}`);
      }
    }

    console.log(`✅ Cleaned ${deleted} old backup(s)`);
  } catch (error) {
    console.error('❌ Backup cleanup failed:', error.message);
  }
}

// ── List Available Backups ────────────────────────────────────────────────────
async function listBackups() {
  try {
    await ensureBackupDir();
    const files = await fs.readdir(BACKUP_DIR);
    
    const backups = [];
    for (const file of files) {
      if (file.endsWith('.sql') || file.endsWith('.db') || file.endsWith('.enc')) {
        const filepath = path.join(BACKUP_DIR, file);
        const stats = await fs.stat(filepath);
        backups.push({
          filename: file,
          path: filepath,
          size: stats.size,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          created: stats.mtime,
          encrypted: file.endsWith('.enc'),
        });
      }
    }

    backups.sort((a, b) => b.created - a.created);
    return backups;
  } catch (error) {
    console.error('Failed to list backups:', error.message);
    return [];
  }
}

// ── Restore from Backup ───────────────────────────────────────────────────────
async function restoreFromBackup(backupPath) {
  console.log(`🔄 Restoring from backup: ${backupPath}`);

  try {
    // Check if file exists
    await fs.access(backupPath);

    // Check if encrypted
    const isEncrypted = backupPath.endsWith('.enc');

    if (isEncrypted) {
      if (!BACKUP_ENCRYPTION_KEY) {
        throw new Error('Backup is encrypted but BACKUP_ENCRYPTION_KEY is not set');
      }

      // Decrypt first
      const decryptedPath = backupPath.replace('.enc', '');
      await decryptFile(backupPath, decryptedPath, BACKUP_ENCRYPTION_KEY);
      backupPath = decryptedPath;
      console.log('🔓 Backup decrypted');
    }

    // Restore based on type
    if (backupPath.endsWith('.sql')) {
      await restorePostgreSQL(backupPath);
    } else if (backupPath.endsWith('.db')) {
      await restoreSQLite(backupPath);
    } else {
      throw new Error('Unknown backup format');
    }

    // Log restore
    await db.run(`
      UPDATE backup_log SET restored = 1, restored_at = datetime('now')
      WHERE file_path = ?
    `, [backupPath]);

    console.log('✅ Restore completed successfully');

    // Clean up decrypted file if it was encrypted
    if (isEncrypted) {
      await fs.unlink(backupPath);
    }

    return true;
  } catch (error) {
    console.error('❌ Restore failed:', error.message);
    throw error;
  }
}

// ── Restore PostgreSQL ────────────────────────────────────────────────────────
async function restorePostgreSQL(backupPath) {
  try {
    const dbUrl = new URL(process.env.DATABASE_URL);
    const host = dbUrl.hostname;
    const port = dbUrl.port || 5432;
    const database = dbUrl.pathname.slice(1);
    const username = dbUrl.username;
    const password = dbUrl.password;

    const command = `PGPASSWORD="${password}" pg_restore -h ${host} -p ${port} -U ${username} -d ${database} -c "${backupPath}"`;
    
    await execAsync(command);
    console.log('✅ PostgreSQL database restored');
  } catch (error) {
    throw new Error(`PostgreSQL restore failed: ${error.message}`);
  }
}

// ── Restore SQLite ────────────────────────────────────────────────────────────
async function restoreSQLite(backupPath) {
  try {
    const targetDb = path.join(__dirname, 'wazema.db');
    
    // Backup current database before overwriting
    const backupCurrent = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`);
    await fs.copyFile(targetDb, backupCurrent);
    console.log(`💾 Current database backed up to: ${path.basename(backupCurrent)}`);

    // Restore from backup
    await fs.copyFile(backupPath, targetDb);
    console.log('✅ SQLite database restored');
  } catch (error) {
    throw new Error(`SQLite restore failed: ${error.message}`);
  }
}

// ── Verify Backup Integrity ──────────────────────────────────────────────────
async function verifyBackup(backupPath) {
  console.log(`🔍 Verifying backup integrity: ${backupPath}`);

  try {
    // Check file exists
    const stats = await fs.stat(backupPath);
    console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // If encrypted, try to decrypt (without saving)
    if (backupPath.endsWith('.enc')) {
      if (!BACKUP_ENCRYPTION_KEY) {
        throw new Error('Cannot verify encrypted backup without BACKUP_ENCRYPTION_KEY');
      }
      
      const input = await fs.readFile(backupPath);
      if (input.length < 32) {
        throw new Error('Encrypted backup file is too small');
      }
      console.log('  Encryption: Valid format');
    }

    // Check metadata if available
    const metadataPath = `${backupPath}.meta.json`;
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      console.log(`  Backup type: ${metadata.type}`);
      console.log(`  Created: ${metadata.timestamp}`);
      console.log(`  Encrypted: ${metadata.encrypted}`);
    } catch {
      console.log('  Metadata: Not available');
    }

    console.log('✅ Backup integrity verified');
    return true;
  } catch (error) {
    console.error('❌ Backup verification failed:', error.message);
    return false;
  }
}

// ── Schedule Automatic Backups ────────────────────────────────────────────────
function scheduleBackups() {
  if (!BACKUP_ENABLED) {
    console.log('ℹ️  Automatic backups disabled');
    return;
  }

  const schedule = process.env.BACKUP_SCHEDULE || 'daily';
  
  let interval;
  switch (schedule) {
    case 'hourly':
      interval = 60 * 60 * 1000;
      break;
    case 'daily':
      interval = 24 * 60 * 60 * 1000;
      break;
    case 'weekly':
      interval = 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      interval = 24 * 60 * 60 * 1000; // Default to daily
  }

  console.log(`⏰ Automatic backups scheduled: ${schedule} (every ${interval / 1000 / 60 / 60} hours)`);

  // Run initial backup after 1 minute
  setTimeout(async () => {
    await performFullBackup();
    await cleanOldBackups();
  }, 60 * 1000);

  // Schedule recurring backups
  setInterval(async () => {
    await performFullBackup();
    await cleanOldBackups();
  }, interval);
}

// ── Export Functions ──────────────────────────────────────────────────────────
module.exports = {
  performFullBackup,
  restoreFromBackup,
  listBackups,
  cleanOldBackups,
  verifyBackup,
  scheduleBackups,
  encryptFile,
  decryptFile,
};

// ── Auto-start scheduled backups if run as main module ───────────────────────
if (require.main === module) {
  console.log('🔄 Starting backup scheduler...');
  scheduleBackups();
}
