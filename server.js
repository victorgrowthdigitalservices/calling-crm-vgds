try { require('dotenv').config(); } catch(e) {}
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { db, normalizePhone } = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Upload directory setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadDir));

// Helper: Authentication Middleware (Simple & rock solid)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const username = req.headers['x-user'] || (authHeader ? authHeader.replace('Bearer ', '').trim() : null);

  if (!username) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }

  const user = db.prepare('SELECT id, username, name, role, last_active FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid user session.' });
  }

  // Update caller's last_active timestamp
  db.prepare("UPDATE users SET last_active = datetime('now', 'localtime') WHERE id = ?").run(user.id);
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Admin only.' });
  }
  next();
}


// Audio Call Recording Upload
app.post('/api/recordings/upload', upload.single('recording'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio recording file uploaded' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size
  });
});

// -------------------------------------------------------------

// -------------------------------------------------------------
// Universal State Synchronization for Multi-Device Telecalling CRM
// -------------------------------------------------------------
const CRM_STATE_FILE = path.join(__dirname, 'crm_state.json');

app.get('/api/sync/state', (req, res) => {
  try {
    if (fs.existsSync(CRM_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CRM_STATE_FILE, 'utf8'));
      return res.json({ success: true, ...data });
    }
    return res.json({ success: true, empty: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read sync state: ' + err.message });
  }
});

app.post('/api/sync/state', (req, res) => {
  try {
    const { leads, recordings, shifts, skippedLogs, skippedLeads } = req.body;
    let current = {};
    if (fs.existsSync(CRM_STATE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CRM_STATE_FILE, 'utf8')); } catch(e){}
    }
    const updated = {
      leads: leads || current.leads || [],
      recordings: recordings || current.recordings || [],
      shifts: shifts || current.shifts || {},
      skippedLogs: skippedLogs || current.skippedLogs || [],
      skippedLeads: skippedLeads || current.skippedLeads || [],
      updatedAt: Date.now()
    };
    fs.writeFileSync(CRM_STATE_FILE, JSON.stringify(updated, null, 2), 'utf8');
    res.json({ success: true, updatedAt: updated.updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save sync state: ' + err.message });
  }
});

// 1. AUTH ROUTES & PORTAL PASSCODES
// -------------------------------------------------------------
app.post('/api/auth/portal-login', (req, res) => {
  const { portal, passcode } = req.body;
  const usernameMap = {
    'admin': 'admin',
    'a': 'caller_a',
    'b': 'caller_b'
  };
  const targetUsername = usernameMap[portal ? portal.toLowerCase() : ''];
  if (!targetUsername) {
    return res.status(400).json({ error: 'Galat Portal select kiya gaya hai.' });
  }

  const user = db.prepare('SELECT id, username, name, role, last_active, password FROM users WHERE username = ?').get(targetUsername);
  if (!user || user.password !== String(passcode || '').trim()) {
    return res.status(401).json({ error: 'Galat Passcode! Kripya sahi passcode darj karein.' });
  }

  db.prepare("UPDATE users SET last_active = datetime('now', 'localtime') WHERE id = ?").run(user.id);

  res.json({
    success: true,
    token: user.username,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username aur Password required hain.' });
  }

  const user = db.prepare('SELECT id, username, name, role, last_active FROM users WHERE username = ? AND password = ?').get(username.trim(), password.trim());
  if (!user) {
    return res.status(401).json({ error: 'Galat username ya password. Kripya check karein.' });
  }

  db.prepare("UPDATE users SET last_active = datetime('now', 'localtime') WHERE id = ?").run(user.id);

  res.json({
    success: true,
    token: user.username,
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// List all callers (for Admin sheets allocation)
app.get('/api/callers', authMiddleware, (req, res) => {
  const callers = db.prepare("SELECT id, username, name, role, last_active FROM users WHERE role = 'caller' ORDER BY id ASC").all();
  res.json({ success: true, callers });
});

// -------------------------------------------------------------
// 2. CENTRAL DATA SHEET UPLOAD & DUPLICATE PREVENT
// -------------------------------------------------------------
app.post('/api/leads/upload', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Kripya Excel (.xlsx) ya CSV file select karein.' });
  }

  try {
    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ error: 'Uploaded sheet khaali (empty) hai.' });
    }

    // Target allocation option from admin: specific caller username ('prachi', 'renu', 'aarush') or 'divide' or null
    const targetCallerUsername = req.body.target_caller || 'divide';

    const callers = db.prepare("SELECT id, username, name FROM users WHERE role = 'caller' ORDER BY id ASC").all();
    const callerMap = {};
    callers.forEach(c => {
      callerMap[c.username.toLowerCase()] = c;
      if (c.username === 'caller_a') callerMap['a'] = c;
      if (c.username === 'caller_b') callerMap['b'] = c;
    });

    let assignedCaller = null;
    if (targetCallerUsername !== 'divide' && callerMap[targetCallerUsername.toLowerCase()]) {
      assignedCaller = callerMap[targetCallerUsername.toLowerCase()];
    }

    let insertedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    const skippedDuplicates = [];

    const checkPhoneStmt = db.prepare('SELECT id, phone, contact_name, assigned_caller_name FROM leads WHERE phone = ?');
    const insertLeadStmt = db.prepare(`
      INSERT INTO leads (
        contact_name, phone, raw_phone, company_name, website, calling_hook, business_details,
        assigned_to, assigned_caller_name, status, sheet_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Not Called', ?)
    `);

    // Process row by row
    let divideIndex = 0;
    for (const row of rawData) {
      // Find matching keys dynamically
      const keys = Object.keys(row);
      const getKey = (...names) => {
        const found = keys.find(k => names.some(n => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(n.toLowerCase().replace(/[^a-z0-9]/g, ''))));
        return found ? String(row[found]).trim() : '';
      };

      const rawPhone = getKey('phone', 'mobile', 'contact', 'number', 'calling number', 'cell');
      const contactName = getKey('name', 'contact person', 'person', 'designer', 'owner', 'client') || 'Unknown Contact';
      const companyName = getKey('company', 'business', 'firm', 'studio', 'agency', 'brand') || '';
      const website = getKey('website', 'site', 'url', 'web', 'link') || '';
      const callingHook = getKey('hook', 'calling hook', 'intro', 'pitch', 'opening') || 'Hello! Calling regarding interior design collaboration & client referrals.';
      const businessDetails = getKey('details', 'business details', 'city', 'address', 'category', 'notes', 'experience', 'location') || '';

      const normalizedPhone = normalizePhone(rawPhone);

      if (!normalizedPhone || normalizedPhone.length < 7) {
        invalidCount++;
        continue;
      }

      // 1. Duplicate check
      const existing = checkPhoneStmt.get(normalizedPhone);
      if (existing) {
        duplicateCount++;
        if (skippedDuplicates.length < 20) {
          skippedDuplicates.push({ phone: normalizedPhone, contact: contactName, company: companyName });
        }
        continue;
      }

      // 2. Determine caller allocation
      let callerToAssign = null;
      if (assignedCaller) {
        callerToAssign = assignedCaller;
      } else if (targetCallerUsername === 'divide' && callers.length > 0) {
        callerToAssign = callers[divideIndex % callers.length];
        divideIndex++;
      }

      insertLeadStmt.run(
        contactName,
        normalizedPhone,
        rawPhone,
        companyName,
        website,
        callingHook,
        businessDetails,
        callerToAssign ? callerToAssign.id : null,
        callerToAssign ? callerToAssign.name : 'Unassigned',
        req.file.originalname
      );

      insertedCount++;
    }

    // Clean up uploaded file
    try { fs.unlinkSync(filePath); } catch (e) {}

    res.json({
      success: true,
      message: `Sheet process ho gayi: ${insertedCount} nayi leads import hui, ${duplicateCount} duplicate phone numbers skip huye.`,
      summary: {
        total_rows: rawData.length,
        imported: insertedCount,
        duplicates_skipped: duplicateCount,
        invalid_rows: invalidCount,
        allocated_to: assignedCaller ? assignedCaller.name : 'Distributed Equally (Jumana, Sameena)',
        sample_duplicates: skippedDuplicates
      }
    });
  } catch (err) {
    console.error('Sheet upload error:', err);
    res.status(500).json({ error: 'Sheet parse karne mein error: ' + err.message });
  }
});

// Bulk assign leads to a specific caller (Admin)
app.post('/api/leads/assign', authMiddleware, adminOnly, (req, res) => {
  const { caller_id, count, lead_ids } = req.body;

  const caller = db.prepare('SELECT id, name FROM users WHERE id = ?').get(caller_id);
  if (!caller) {
    return res.status(404).json({ error: 'Caller nahi mila.' });
  }

  if (lead_ids && Array.isArray(lead_ids) && lead_ids.length > 0) {
    const updateStmt = db.prepare('UPDATE leads SET assigned_to = ?, assigned_caller_name = ? WHERE id = ?');
    for (const id of lead_ids) {
      updateStmt.run(caller.id, caller.name, id);
    }
    return res.json({ success: true, message: `${lead_ids.length} leads ${caller.name} ko assign ho gayi.` });
  }

  if (count && count > 0) {
    const unassigned = db.prepare('SELECT id FROM leads WHERE assigned_to IS NULL ORDER BY id ASC LIMIT ?').all(Number(count));
    const updateStmt = db.prepare('UPDATE leads SET assigned_to = ?, assigned_caller_name = ? WHERE id = ?');
    for (const l of unassigned) {
      updateStmt.run(caller.id, caller.name, l.id);
    }
    return res.json({ success: true, message: `${unassigned.length} leads ${caller.name} ko assign ho gayi.` });
  }

  res.status(400).json({ error: 'Invalid assign request: provide lead_ids ya count.' });
});

// -------------------------------------------------------------
// 3. LEADS LISTING & ROLE-BASED ACCESS
// -------------------------------------------------------------
app.get('/api/leads', authMiddleware, (req, res) => {
  const { tab, status, search, caller_id, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let whereClauses = [];
  let params = [];

  // Caller isolation: A caller ONLY sees their own leads
  if (req.user.role === 'caller') {
    whereClauses.push('assigned_to = ?');
    params.push(req.user.id);
  } else if (caller_id) {
    whereClauses.push('assigned_to = ?');
    params.push(Number(caller_id));
  }

  // Tab filtering
  if (tab === 'calling') {
    whereClauses.push("status = 'Not Called'");
  } else if (tab === 'followups') {
    whereClauses.push("status IN ('Interested but Busy – Call Back Later', 'Follow-Up Required')");
  } else if (tab === 'interested') {
    whereClauses.push("(is_interested = 1 OR status = 'Interested/Serious Client')");
  }

  if (status && status !== 'all') {
    whereClauses.push('status = ?');
    params.push(status);
  }

  if (search) {
    whereClauses.push('(contact_name LIKE ? OR phone LIKE ? OR company_name LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  // Order by
  let orderSQL = 'ORDER BY id ASC';
  if (tab === 'followups') {
    orderSQL = 'ORDER BY followup_date ASC, id ASC';
  } else if (tab === 'interested') {
    orderSQL = 'ORDER BY updated_at DESC, id DESC';
  }

  const countQuery = `SELECT COUNT(*) as total FROM leads ${whereSQL}`;
  const total = db.prepare(countQuery).get(...params)?.total || 0;

  const dataQuery = `SELECT * FROM leads ${whereSQL} ${orderSQL} LIMIT ? OFFSET ?`;
  const leads = db.prepare(dataQuery).all(...params, Number(limit), Number(offset));

  // Compute countdown & reminder metadata for followups
  const now = new Date();
  const leadsWithMeta = leads.map(lead => {
    let reminder_due = false;
    let hours_remaining = null;
    let minutes_remaining = null;

    if (lead.followup_date) {
      const fDate = new Date(lead.followup_date);
      const diffMs = fDate - now;
      minutes_remaining = Math.round(diffMs / 60000);
      hours_remaining = Math.round(diffMs / 3600000);
      // Remind if within 60 minutes or already overdue
      if (diffMs <= 60 * 60 * 1000) {
        reminder_due = true;
      }
    }

    return {
      ...lead,
      reminder_due,
      hours_remaining,
      minutes_remaining
    };
  });

  res.json({
    success: true,
    total,
    page: Number(page),
    limit: Number(limit),
    leads: leadsWithMeta
  });
});

// Single lead with full history
app.get('/api/leads/:id', authMiddleware, (req, res) => {
  const leadId = req.params.id;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);

  if (!lead) {
    return res.status(404).json({ error: 'Lead nahi mili.' });
  }

  // Caller privacy check
  if (req.user.role === 'caller' && lead.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Access Denied: Yeh lead aapko assign nahi hai.' });
  }

  const logs = db.prepare('SELECT * FROM call_logs WHERE lead_id = ? ORDER BY created_at DESC').all(leadId);

  res.json({
    success: true,
    lead,
    history: logs
  });
});

// -------------------------------------------------------------
// 4. RECORD CALL & AUTO FOLLOW-UP TIMER / ADMIN INTERESTED SYNC
// -------------------------------------------------------------
app.post('/api/leads/:id/call', authMiddleware, (req, res) => {
  const leadId = req.params.id;
  const { status, remarks = '', followup_date, followup_hours = 24 } = req.body;

  const validStatuses = [
    'Not Called',
    'Call Not Received',
    'Number Not Reachable',
    'Interested/Serious Client',
    'Interested but Busy – Call Back Later',
    'Not Interested',
    'Follow-Up Required'
  ];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid call status selected.' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) {
    return res.status(404).json({ error: 'Lead nahi mili.' });
  }

  // Caller isolation
  if (req.user.role === 'caller' && lead.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'Aap sirf apni assigned lead update kar sakte hain.' });
  }

  const prevStatus = lead.status;
  const isInterested = (status === 'Interested/Serious Client') ? 1 : (status === 'Not Interested' ? 0 : lead.is_interested);

  // If callback or followup: default 1 day (24h) timer if no specific date given
  let calculatedFollowupDate = null;
  if (status === 'Interested but Busy – Call Back Later' || status === 'Follow-Up Required') {
    if (followup_date) {
      calculatedFollowupDate = followup_date;
    } else {
      // 24 hours (1 day) from now
      const d = new Date(Date.now() + (Number(followup_hours) || 24) * 60 * 60 * 1000);
      calculatedFollowupDate = d.toISOString().replace('T', ' ').substring(0, 19);
    }
  }

  // 1. Update Lead
  db.prepare(`
    UPDATE leads SET 
      status = ?,
      is_interested = ?,
      followup_date = ?,
      followup_timer_hours = ?,
      last_call_date = datetime('now', 'localtime'),
      last_call_remark = ?,
      total_calls = total_calls + 1,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    status,
    isInterested,
    calculatedFollowupDate,
    Number(followup_hours) || 24,
    remarks,
    leadId
  );

  // 2. Add to Call Logs (History)
  db.prepare(`
    INSERT INTO call_logs (
      lead_id, caller_id, caller_name, previous_status, new_status, remarks, followup_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    leadId,
    req.user.id,
    req.user.name,
    prevStatus,
    status,
    remarks,
    calculatedFollowupDate
  );

  // 3. Update Caller's last_active
  db.prepare("UPDATE users SET last_active = datetime('now', 'localtime') WHERE id = ?").run(req.user.id);

  res.json({
    success: true,
    message: 'Call update save ho gaya!',
    lead_id: leadId,
    new_status: status,
    is_interested: isInterested,
    followup_date: calculatedFollowupDate
  });
});

// -------------------------------------------------------------
// 5. ADMIN DEDICATED TAB: HOT / INTERESTED CLIENTS
// -------------------------------------------------------------
app.get('/api/admin/interested-leads', authMiddleware, adminOnly, (req, res) => {
  const query = `
    SELECT l.*, 
      (SELECT remarks FROM call_logs WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) as latest_remark
    FROM leads l
    WHERE (l.is_interested = 1 OR l.status = 'Interested/Serious Client')
    ORDER BY l.updated_at DESC
  `;
  const leads = db.prepare(query).all();
  res.json({ success: true, count: leads.length, leads });
});

// -------------------------------------------------------------
// 6. ADMIN LIVE MONITORING & CALLER PERFORMANCE TRACKING
// -------------------------------------------------------------
app.get('/api/admin/live-monitoring', authMiddleware, adminOnly, (req, res) => {
  const callers = db.prepare("SELECT id, username, name, last_active FROM users WHERE role = 'caller' ORDER BY id ASC").all();
  const now = new Date();

  const callerStats = callers.map(caller => {
    // Online check: active within last 15 minutes
    let is_online = false;
    let last_active_human = 'Never';
    if (caller.last_active) {
      const lastActiveDate = new Date(caller.last_active);
      const diffMinutes = Math.round((now - lastActiveDate) / 60000);
      is_online = diffMinutes <= 15;
      last_active_human = diffMinutes <= 1 ? 'Just now' : `${diffMinutes} mins ago`;
    }

    // Lead assignment & progress
    const totalAssigned = db.prepare('SELECT COUNT(*) as c FROM leads WHERE assigned_to = ?').get(caller.id)?.c || 0;
    const remainingUncalled = db.prepare("SELECT COUNT(*) as c FROM leads WHERE assigned_to = ? AND status = 'Not Called'").get(caller.id)?.c || 0;
    const completedCalls = totalAssigned - remainingUncalled;

    // Today's calls by this caller
    const todayCalls = db.prepare(`
      SELECT COUNT(*) as c FROM call_logs 
      WHERE caller_id = ? AND date(created_at) = date('now', 'localtime')
    `).get(caller.id)?.c || 0;

    // Today's interested clients by this caller
    const todayInterested = db.prepare(`
      SELECT COUNT(*) as c FROM call_logs 
      WHERE caller_id = ? AND new_status = 'Interested/Serious Client' AND date(created_at) = date('now', 'localtime')
    `).get(caller.id)?.c || 0;

    // Last action by this caller
    const lastLog = db.prepare(`
      SELECT cl.*, l.contact_name, l.phone, l.company_name 
      FROM call_logs cl
      JOIN leads l ON cl.lead_id = l.id
      WHERE cl.caller_id = ?
      ORDER BY cl.created_at DESC LIMIT 1
    `).get(caller.id);

    return {
      caller_id: caller.id,
      name: caller.name,
      username: caller.username,
      is_online,
      last_active: caller.last_active,
      last_active_human,
      total_assigned: totalAssigned,
      completed_calls: completedCalls,
      remaining_uncalled: remainingUncalled,
      completion_percentage: totalAssigned > 0 ? Math.round((completedCalls / totalAssigned) * 100) : 0,
      today_calls: todayCalls,
      today_interested: todayInterested,
      last_activity: lastLog ? {
        contact: lastLog.contact_name,
        company: lastLog.company_name,
        phone: lastLog.phone,
        status: lastLog.new_status,
        remarks: lastLog.remarks,
        time: lastLog.created_at
      } : null
    };
  });

  // Recent live activity feed across all callers (last 25 calls)
  const liveFeed = db.prepare(`
    SELECT cl.id, cl.lead_id, cl.caller_name, cl.previous_status, cl.new_status, cl.remarks, cl.created_at,
           l.contact_name, l.phone, l.company_name
    FROM call_logs cl
    JOIN leads l ON cl.lead_id = l.id
    ORDER BY cl.created_at DESC LIMIT 25
  `).all();

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    callers: callerStats,
    live_feed: liveFeed
  });
});

// Comprehensive Admin Dashboard Reports (Daily, Weekly, Comparison, Conversion Rate)
app.get('/api/admin/reports', authMiddleware, adminOnly, (req, res) => {
  const { date_filter = 'today' } = req.query; // 'today', 'week', 'month', 'all'

  let dateSQL = "date(created_at) = date('now', 'localtime')";
  if (date_filter === 'week') {
    dateSQL = "created_at >= datetime('now', '-7 days', 'localtime')";
  } else if (date_filter === 'month') {
    dateSQL = "created_at >= datetime('now', '-30 days', 'localtime')";
  } else if (date_filter === 'all') {
    dateSQL = '1=1';
  }

  const callers = db.prepare("SELECT id, username, name FROM users WHERE role = 'caller' ORDER BY id ASC").all();

  const callerBreakdown = callers.map(caller => {
    const totalAssigned = db.prepare('SELECT COUNT(*) as c FROM leads WHERE assigned_to = ?').get(caller.id)?.c || 0;
    const remaining = db.prepare("SELECT COUNT(*) as c FROM leads WHERE assigned_to = ? AND status = 'Not Called'").get(caller.id)?.c || 0;

    const totalCalls = db.prepare(`SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND ${dateSQL}`).get(caller.id)?.c || 0;
    const uniqueLeads = db.prepare(`SELECT COUNT(DISTINCT lead_id) as c FROM call_logs WHERE caller_id = ? AND ${dateSQL}`).get(caller.id)?.c || 0;

    const interested = db.prepare(`SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status = 'Interested/Serious Client' AND ${dateSQL}`).get(caller.id)?.c || 0;
    const callbacks = db.prepare(`SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status IN ('Interested but Busy – Call Back Later', 'Follow-Up Required') AND ${dateSQL}`).get(caller.id)?.c || 0;
    const notInterested = db.prepare(`SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status = 'Not Interested' AND ${dateSQL}`).get(caller.id)?.c || 0;
    const notReceived = db.prepare(`SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status IN ('Call Not Received', 'Number Not Reachable') AND ${dateSQL}`).get(caller.id)?.c || 0;

    const conversionRate = uniqueLeads > 0 ? ((interested / uniqueLeads) * 100).toFixed(1) : 0;

    return {
      caller_id: caller.id,
      name: caller.name,
      username: caller.username,
      total_assigned: totalAssigned,
      remaining_uncalled: remaining,
      total_calls: totalCalls,
      unique_contacted: uniqueLeads,
      interested,
      callbacks,
      not_interested: notInterested,
      not_received: notReceived,
      conversion_rate_percent: Number(conversionRate)
    };
  });

  // Overall totals
  const overallTotals = {
    total_assigned: callerBreakdown.reduce((s, c) => s + c.total_assigned, 0),
    total_remaining: callerBreakdown.reduce((s, c) => s + c.remaining_uncalled, 0),
    total_calls: callerBreakdown.reduce((s, c) => s + c.total_calls, 0),
    total_unique_contacted: callerBreakdown.reduce((s, c) => s + c.unique_contacted, 0),
    total_interested: callerBreakdown.reduce((s, c) => s + c.interested, 0),
    total_callbacks: callerBreakdown.reduce((s, c) => s + c.callbacks, 0),
    total_not_interested: callerBreakdown.reduce((s, c) => s + c.not_interested, 0),
    total_not_received: callerBreakdown.reduce((s, c) => s + c.not_received, 0)
  };
  overallTotals.overall_conversion_rate = overallTotals.total_unique_contacted > 0 
    ? ((overallTotals.total_interested / overallTotals.total_unique_contacted) * 100).toFixed(1) 
    : 0;

  res.json({
    success: true,
    filter: date_filter,
    totals: overallTotals,
    caller_breakdown: callerBreakdown
  });
});

// -------------------------------------------------------------
// 7. EXCEL EXPORT (REPORTS & LEADS)
// -------------------------------------------------------------
app.get('/api/admin/export/performance', authMiddleware, adminOnly, (req, res) => {
  try {
    const callers = db.prepare("SELECT id, name FROM users WHERE role = 'caller' ORDER BY id ASC").all();

    const reportData = callers.map(caller => {
      const totalAssigned = db.prepare('SELECT COUNT(*) as c FROM leads WHERE assigned_to = ?').get(caller.id)?.c || 0;
      const remaining = db.prepare("SELECT COUNT(*) as c FROM leads WHERE assigned_to = ? AND status = 'Not Called'").get(caller.id)?.c || 0;
      const todayCalls = db.prepare("SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND date(created_at) = date('now', 'localtime')").get(caller.id)?.c || 0;
      const allTimeCalls = db.prepare('SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ?').get(caller.id)?.c || 0;
      const interested = db.prepare("SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status = 'Interested/Serious Client'").get(caller.id)?.c || 0;
      const callbacks = db.prepare("SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status IN ('Interested but Busy – Call Back Later', 'Follow-Up Required')").get(caller.id)?.c || 0;
      const notInterested = db.prepare("SELECT COUNT(*) as c FROM call_logs WHERE caller_id = ? AND new_status = 'Not Interested'").get(caller.id)?.c || 0;

      return {
        'Caller Name': caller.name,
        'Total Assigned': totalAssigned,
        'Remaining Uncalled': remaining,
        'Calls Made Today': todayCalls,
        'Total Calls (All Time)': allTimeCalls,
        'Interested / Serious Clients': interested,
        'Follow-Ups / Callbacks': callbacks,
        'Not Interested': notInterested,
        'Conversion Rate %': allTimeCalls > 0 ? ((interested / allTimeCalls) * 100).toFixed(1) + '%' : '0%'
      };
    });

    const ws = xlsx.utils.json_to_sheet(reportData);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Calling Performance');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Calling_Team_Performance_Report.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Export all leads
app.get('/api/admin/export/leads', authMiddleware, adminOnly, (req, res) => {
  try {
    const leads = db.prepare(`
      SELECT id as 'Lead ID', contact_name as 'Contact Name', phone as 'Phone', company_name as 'Company Name',
             website as 'Website', assigned_caller_name as 'Assigned Caller', status as 'Status',
             followup_date as 'Followup Date', last_call_date as 'Last Call Date', last_call_remark as 'Last Remark',
             total_calls as 'Total Calls', created_at as 'Created At'
      FROM leads ORDER BY id ASC
    `).all();

    const ws = xlsx.utils.json_to_sheet(leads);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'All Leads');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="All_CRM_Leads.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Serve frontend static files robustly from public/ or root directory
const publicPath = path.join(__dirname, 'public');
const hasPublic = fs.existsSync(publicPath) && fs.existsSync(path.join(publicPath, 'index.html'));
const rootIndex = path.join(__dirname, 'index.html');
const hasRootIndex = fs.existsSync(rootIndex);

if (hasPublic) {
  app.use(express.static(publicPath));
}
app.use(express.static(__dirname));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  if (hasPublic) {
    return res.sendFile(path.join(publicPath, 'index.html'));
  }
  if (hasRootIndex) {
    return res.sendFile(rootIndex);
  }
  res.status(404).send('index.html not found. Ensure index.html or public/index.html is present.');
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Telecalling CRM Backend running on http://localhost:${PORT}`);
  console.log(`📊 Mode: Production ready | Database: SQLite (Built-in node:sqlite)`);
});
