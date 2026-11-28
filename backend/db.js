const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'crm.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency
db.exec('PRAGMA journal_mode = WAL;');

// Normalize phone numbers for reliable duplicate check
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  // If Indian 10 digits with leading 91 or 0
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }
  return digits;
}

function initDB() {
  // 1. Users table (Admin + Callers: Caller A, Caller B, Caller C)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'caller',
      last_active TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 2. Leads table
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT,
      phone TEXT UNIQUE NOT NULL,
      raw_phone TEXT,
      company_name TEXT,
      website TEXT,
      calling_hook TEXT,
      business_details TEXT,
      assigned_to INTEGER REFERENCES users(id),
      assigned_caller_name TEXT,
      status TEXT DEFAULT 'Not Called',
      followup_date TEXT,
      followup_timer_hours INTEGER DEFAULT 24,
      is_interested INTEGER DEFAULT 0,
      last_call_date TEXT,
      last_call_remark TEXT,
      total_calls INTEGER DEFAULT 0,
      sheet_source TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(followup_date);
    CREATE INDEX IF NOT EXISTS idx_leads_interested ON leads(is_interested);
  `);

  // 3. Call Logs table (audit trail & lead history)
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      caller_id INTEGER NOT NULL REFERENCES users(id),
      caller_name TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      remarks TEXT,
      followup_date TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_date ON call_logs(created_at);
  `);

  // Seed default users with specified passcodes
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (!existingUsers || existingUsers.count === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)
    `);

    insertUser.run('admin', '1313', 'Victor Growth Admin', 'admin');
    insertUser.run('caller_a', '0000', 'Jumana Malekul', 'caller');
    insertUser.run('caller_b', '0000', 'Sameena Rubab', 'caller');
    insertUser.run('caller_c', '0000', 'Sumaiya Manha', 'caller');

    console.log('✅ Seeded default users: Admin (1313), Jumana Malekul (0000), Sameena Rubab (0000), Sumaiya Manha (0000)');
  }
}

initDB();

module.exports = {
  db,
  normalizePhone
};
