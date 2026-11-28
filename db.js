const path = require('path');
const fs = require('fs');

let db;
let isNativeSqlite = false;

// Normalize phone numbers for reliable duplicate check
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }
  return digits;
}

try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'crm.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  isNativeSqlite = true;
  console.log('✅ SQLite Database connected via native node:sqlite');
} catch (err) {
  console.warn('⚠️ node:sqlite not available on this Node runtime (' + process.version + '). Using resilient JSON/in-memory fallback database engine.');
  
  // Resilient fallback database mock for older Node.js versions on cloud hosts
  const fallbackStore = {
    users: [
      { id: 1, username: 'admin', name: 'Admin Master', role: 'admin', password: '1313', last_active: null },
      { id: 2, username: 'caller_a', name: 'Jumana Malekul', role: 'caller', password: '4132', last_active: null },
      { id: 3, username: 'caller_b', name: 'Sameena Rubab', role: 'caller', password: '2310', last_active: null }
    ],
    leads: [],
    call_logs: []
  };

  db = {
    exec(sql) {
      return this;
    },
    prepare(sql) {
      const s = sql.trim().toLowerCase();
      return {
        all(...args) {
          if (s.includes('from users')) {
            if (s.includes("role = 'caller'")) {
              return fallbackStore.users.filter(u => u.role === 'caller');
            }
            return fallbackStore.users;
          }
          if (s.includes('from leads')) {
            return fallbackStore.leads;
          }
          if (s.includes('from call_logs')) {
            return fallbackStore.call_logs;
          }
          if (s.includes('count(*)')) {
            return [{ count: fallbackStore.leads.length, 'count(*)': fallbackStore.leads.length }];
          }
          return [];
        },
        get(...args) {
          if (s.includes('from users')) {
            const queryArg = args[0];
            if (typeof queryArg === 'string') {
              return fallbackStore.users.find(u => u.username.toLowerCase() === queryArg.toLowerCase());
            }
            if (typeof queryArg === 'number') {
              return fallbackStore.users.find(u => u.id === queryArg);
            }
            return fallbackStore.users[0];
          }
          if (s.includes('from leads')) {
            if (s.includes('where id = ?')) {
              return fallbackStore.leads.find(l => l.id === Number(args[0]));
            }
            if (s.includes('where phone = ?')) {
              return fallbackStore.leads.find(l => l.phone === String(args[0]));
            }
            return fallbackStore.leads[0];
          }
          if (s.includes('count(*)')) {
            return { count: fallbackStore.leads.length, 'count(*)': fallbackStore.leads.length };
          }
          return null;
        },
        run(...args) {
          if (s.includes('update users set last_active')) {
            const userId = args[0];
            const u = fallbackStore.users.find(x => x.id === userId);
            if (u) u.last_active = new Date().toISOString();
          }
          return { changes: 1, lastInsertRowid: Date.now() };
        }
      };
    }
  };
}

function initDB() {
  if (!isNativeSqlite) return;
  try {
    // 1. Users table
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

    // 3. Call Logs table
    db.exec(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id),
        caller_id INTEGER NOT NULL REFERENCES users(id),
        caller_name TEXT NOT NULL,
        previous_status TEXT,
        new_status TEXT NOT NULL,
        remarks TEXT,
        followup_date TEXT,
        audio_recording_url TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(lead_id);
      CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_id);
    `);

    // Seed default users if empty
    const adminCheck = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!adminCheck) {
      const insertUser = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)');
      insertUser.run('admin', '1313', 'Achhar Sharma (Admin)', 'admin');
      insertUser.run('caller_a', '4132', 'Jumana Malekul', 'caller');
      insertUser.run('caller_b', '2310', 'Sameena Rubab', 'caller');
    }
  } catch (err) {
    console.warn('DB initialization error (non-fatal):', err.message);
  }
}

initDB();

module.exports = {
  db,
  normalizePhone
};
