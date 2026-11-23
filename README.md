# 📞 Telecalling CRM - Calling Team Management System

Production-ready, high-speed Telecalling CRM tailored for **3 Calling Persons (Prachi, Renu, Aarush)** and **1 Admin**.

---

## 🚀 Quick Start (Backend)

```bash
cd backend
npm install
npm start
```

Backend will run on: `http://localhost:5000`

---

## 👥 Default Logins (Role-Based Partitioning)

| Role | Name | Username | Password | Access |
|---|---|---|---|---|
| **Admin** | Admin (You) | `admin` | `admin123` | Full Master Panel, Upload Sheet, Allocate, Live Monitoring, Interested Tab, Reports, Excel Export |
| **Caller 1** | Prachi | `prachi` | `prachi123` | Prachi's Assigned Leads, Line-by-Line Calling, Follow-ups with 1-Day Timer |
| **Caller 2** | Renu | `renu` | `renu123` | Renu's Assigned Leads, Line-by-Line Calling, Follow-ups with 1-Day Timer |
| **Caller 3** | Aarush | `aarush` | `aarush123` | Aarush's Assigned Leads, Line-by-Line Calling, Follow-ups with 1-Day Timer |

*Note: Strict Data Isolation is enforced at the database level. Callers can NEVER see each other's leads or phone numbers.*

---

## ⚡ Core Features Implemented in Backend

1. **Central Data Sheet & Duplicate Prevention (`POST /api/leads/upload`)**:
   - Accepts `.xlsx`, `.xls`, `.csv`.
   - Normalizes phone numbers (strips spaces, dashes, +91, leading 0).
   - Skips duplicate phone numbers automatically with duplicate report.
   - Allocates to specific caller (`prachi`, `renu`, `aarush`) or divides equally.

2. **Caller Partitioning & Line-by-Line Queue (`GET /api/leads`)**:
   - `tab=calling`: Next uncalled leads.
   - Shows Contact Name, Phone, Company, Website, Calling Hook / Pitch, Business Details.

3. **Admin Dedicated Interested / Hot Leads Tab (`GET /api/admin/interested-leads`)**:
   - Whenever any caller marks a lead as `Interested/Serious Client`, it instantly reflects in Admin's Hot Leads tab.

4. **Follow-Up & 1-Day Timer Reminder (`GET /api/leads?tab=followups`)**:
   - If marked `Interested but Busy – Call Back Later` or `Follow-Up Required`, sets an automatic 24-hour (1-day) timer.
   - Alerts caller when due or overdue.

5. **Live Admin Monitoring (`GET /api/admin/live-monitoring`)**:
   - Real-time online/active status of Prachi, Renu, Aarush.
   - Total assigned, remaining, today's calls, completion %.
   - Live activity stream (last 25 calls made).

6. **Performance Reports & Caller Comparison (`GET /api/admin/reports`)**:
   - Daily / Weekly / Monthly filters.
   - Total calls, unique leads contacted, answered vs unreachable, conversion rate %.
   - Side-by-side caller comparison.

7. **Excel Export (`GET /api/admin/export/performance` & `/api/admin/export/leads`)**:
   - Instant `.xlsx` download.

8. **Zero C++ Dependencies (Render Ready)**:
   - Built on native `node:sqlite` in Node.js v24. Runs directly on Render with zero build failures.
