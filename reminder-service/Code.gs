/**
 * LoanBook reminder service
 * =========================
 * Sends LoanBook users their daily reminder email. It is deployed ONCE, from
 * the LoanBook developer's Google account. Users never see or touch it: they
 * only switch reminders on in LoanBook → Settings and pick the email, time
 * and how many days ahead.
 *
 * How it works. While a user has reminders switched on, LoanBook sends this
 * service their reminder settings and the short list of payments still owed
 * (borrower name, phone, loan reference, due date, amount). Every request must
 * carry a Google sign-in token issued to LoanBook; it is checked with Google
 * (and the account's address read from Drive when the token does not carry
 * it) and the list is filed under that Google account. The token itself is
 * not kept. Once an hour the service emails each user who has reached their
 * chosen time and has not had today's email. Switching reminders off deletes
 * the user's list.
 *
 * DEPLOY (once, about 5 minutes, signed in to the developer's Google account)
 *   1. https://script.google.com → New project. Name it "LoanBook reminders".
 *      Replace the sample code with this whole file and click Save.
 *   2. Choose "setup" next to Run and click Run. Allow the permissions.
 *   3. Deploy → New deployment → gear icon → Web app.
 *      Execute as: Me.  Who has access: Anyone.  Click Deploy.
 *   4. Copy the Web app URL (ends in /exec) and set it as
 *      REMINDER_SERVICE_URL near the top of index.html, then publish.
 * When this file changes: Deploy → Manage deployments → edit → New version.
 */

const CLIENT_ID = '108999565212-hm2sdqajqq3hos8mg5ids1aa36hgr35f.apps.googleusercontent.com';
const APP_URL = 'https://mpomowole.github.io/loanbook/';
const FOLDER_NAME = 'LoanBook reminder service';
const MAX_ITEMS = 2000;

/* Installs the hourly send. Safe to run again. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendDue').timeBased().everyHours(1).create();
  folder_();
}

function doGet() {
  return json_({ok: true, service: 'LoanBook reminders'});
}

/* Body (sent as text/plain JSON, so browsers need no preflight):
   {token, action: '' | 'test', settings: {enabled, email, hour, aheadDays,
    everyDay, timeZone}, items: [{name, phone, loanId, dueDate, amount}],
    owed, asOf} */
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ok: false, error: 'bad-request'}); }
  const owner = verify_(req && req.token);
  if (!owner) return json_({ok: false, error: 'not-signed-in'});
  const key = key_(owner);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!req.settings || !req.settings.enabled) {
      remove_(key);
      return json_({ok: true, enabled: false});
    }
    const rec = clean_(req, owner);
    save_(key, rec);
    if (req.action === 'test') {
      const tz = rec.settings.timeZone;
      send_(rec, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), true);
    }
    return json_({ok: true, enabled: true, items: rec.items.length});
  } catch (err) {
    console.error(err);
    return json_({ok: false, error: String((err && err.message) || err)});
  } finally {
    lock.releaseLock();
  }
}

/* Hourly: one email per user per day, at or after their chosen hour. */
function sendDue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const files = folder_().getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.isTrashed() || !/\.json$/.test(f.getName())) continue;
      let rec;
      try { rec = JSON.parse(f.getBlob().getDataAsString('UTF-8')); } catch (err) { continue; }
      if (!rec || !rec.settings || !rec.owner) continue;
      const key = f.getName().replace(/\.json$/, '');
      const now = new Date(), tz = rec.settings.timeZone;
      const day = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
      const hour = Number(Utilities.formatDate(now, tz, 'H'));
      if (hour < rec.settings.hour || props.getProperty('sent:' + key) === day) continue;
      try {
        send_(rec, day, false);
        props.setProperty('sent:' + key, day);
      } catch (err) { console.error('Reminder for one user failed', err); }
    }
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------------ */

function verify_(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), {muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) return null;
  const info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID && info.azp !== CLIENT_ID) return null;
  if (info.email && String(info.email_verified) === 'true') return String(info.email).trim().toLowerCase();
  /* LoanBook signs in with the Drive permission alone, so the token may not
     carry the email; Drive reports the signed-in account's address. */
  const about = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
    {headers: {Authorization: 'Bearer ' + token}, muteHttpExceptions: true});
  if (about.getResponseCode() !== 200) return null;
  const email = (JSON.parse(about.getContentText()).user || {}).emailAddress;
  return email ? String(email).trim().toLowerCase() : null;
}

function clean_(req, owner) {
  const s = req.settings || {};
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const email = String(s.email || '').trim();
  const items = (Array.isArray(req.items) ? req.items : []).slice(0, MAX_ITEMS).map(x => ({
    name: str(x && x.name, 80), phone: str(x && x.phone, 30), loanId: str(x && x.loanId, 24),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(x && x.dueDate) ? x.dueDate : '',
    amount: Math.max(0, Math.round((Number(x && x.amount) || 0) * 100) / 100)
  })).filter(x => x.dueDate && x.amount > 0);
  return {
    owner,
    settings: {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 120) : owner,
      hour: int(s.hour, 0, 23, 7),
      aheadDays: int(s.aheadDays, 1, 31, 7),
      everyDay: !!s.everyDay,
      timeZone: timeZone_(s.timeZone)
    },
    items,
    owed: Math.max(0, Number(req.owed) || 0),
    asOf: Number(req.asOf) || Date.now(),
    updatedAt: Date.now()
  };
}

function timeZone_(tz) {
  try { if (tz) { Utilities.formatDate(new Date(), tz, 'H'); return tz; } } catch (err) {}
  return 'Africa/Lagos';
}

function folder_() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}
function key_(owner) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, owner)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}
function file_(key) {
  const it = folder_().getFilesByName(key + '.json');
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}
function save_(key, rec) {
  const f = file_(key), text = JSON.stringify(rec);
  if (f) f.setContent(text); else folder_().createFile(key + '.json', text, 'application/json');
}
/* The list is blanked before the file is trashed, so nothing lingers in the bin. */
function remove_(key) {
  const f = file_(key);
  if (f) { f.setContent('{}'); f.setTrashed(true); }
  PropertiesService.getScriptProperties().deleteProperty('sent:' + key);
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* Same rule as LoanBook: an amount still owed for a month whose due date has
   passed is overdue; lateness counts from the oldest unpaid month. */
function summarize_(rec, today) {
  const horizon = addDays_(today, rec.settings.aheadDays);
  const late = {}, out = {overdue: [], dueToday: [], upcoming: []};
  rec.items.forEach(x => {
    if (x.dueDate < today) {
      const g = late[x.loanId] || (late[x.loanId] = {name: x.name, phone: x.phone, loanId: x.loanId, amount: 0, oldest: x.dueDate});
      g.amount += x.amount;
      if (x.dueDate < g.oldest) g.oldest = x.dueDate;
    } else if (x.dueDate === today) out.dueToday.push(x);
    else if (x.dueDate <= horizon) out.upcoming.push(x);
  });
  out.overdue = Object.keys(late).map(k => Object.assign(late[k], {days: daysBetween_(late[k].oldest, today)}))
    .sort((a, b) => b.amount - a.amount);
  out.dueToday.sort((a, b) => a.name.localeCompare(b.name));
  out.upcoming.sort((a, b) => a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.name.localeCompare(b.name));
  return out;
}

function send_(rec, today, isTest) {
  const r = rec.settings, s = summarize_(rec, today);
  const nothing = !s.overdue.length && !s.dueToday.length && !s.upcoming.length;
  if (nothing && !r.everyDay && !isTest) return false;

  const sum = list => list.reduce((t, x) => t + x.amount, 0);
  const bits = [];
  if (s.overdue.length) bits.push(`${naira_(sum(s.overdue))} overdue`);
  if (s.dueToday.length) bits.push(`${s.dueToday.length} due today`);
  if (s.upcoming.length) bits.push(`${s.upcoming.length} coming up`);
  const subject = `${isTest ? 'Test · ' : ''}LoanBook · ${shortDate_(today)}: ${bits.length ? bits.join(' · ') : 'nothing due'}`;

  const tel = p => p ? `<a href="tel:${esc_(String(p).replace(/[^\d+]/g, ''))}" style="color:#2158A6;text-decoration:none;">${esc_(p)}</a>` : '—';
  const th = 'text-align:left;padding:8px 10px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#4C5C77;background:#EDF2FA;border-bottom:1px solid #DCE5F3;';
  const td = 'padding:9px 10px;border-bottom:1px solid #DCE5F3;font-size:14px;vertical-align:top;';
  const num = td + 'text-align:right;white-space:nowrap;font-family:Consolas,Menlo,monospace;';
  const table = (heads, rows) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #DCE5F3;margin:0 0 6px;">`
    + `<tr>${heads.map(h => `<th style="${th}${h.num ? 'text-align:right;' : ''}">${h.t}</th>`).join('')}</tr>${rows.join('')}</table>`;
  const who = x => `<b>${esc_(x.name)}</b><br><span style="color:#8B99B2;font-size:12px;">${esc_(x.loanId)}</span>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  let html = isTest ? `<p style="margin:0 0 18px;padding:12px 14px;background:#E3ECFB;color:#153E7B;border-radius:8px;">This is a test. Your daily summary will arrive like this every day at about ${hourLabel_(r.hour)}${r.everyDay ? '' : ' when something is due or overdue'}.</p>` : '';
  html += `<p style="margin:0 0 18px;color:#4C5C77;">Still owed across all running loans: <b style="color:#0F1D33;">${naira_(rec.owed)}</b></p>`;
  if (s.overdue.length) html += heading_(`Overdue · ${naira_(sum(s.overdue))}`, '#AD2E3E')
    + table([{t: 'Borrower'}, {t: 'Phone'}, {t: 'Overdue', num: true}, {t: 'Late', num: true}],
      s.overdue.map(x => `<tr><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.phone)}</td><td style="${num}color:#AD2E3E;">${naira_(x.amount)}</td><td style="${num}">${plural(x.days, 'day')}${x.days > 90 ? '<br><span style="font-size:11px;color:#AD2E3E;">defaulted</span>' : ''}</td></tr>`));
  if (s.dueToday.length) html += heading_(`Due today · ${naira_(sum(s.dueToday))}`, '#A9781F')
    + table([{t: 'Borrower'}, {t: 'Phone'}, {t: 'Amount', num: true}],
      s.dueToday.map(x => `<tr><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.phone)}</td><td style="${num}">${naira_(x.amount)}</td></tr>`));
  if (s.upcoming.length) html += heading_(`Coming up in the next ${plural(r.aheadDays, 'day')} · ${naira_(sum(s.upcoming))}`, '#0E7C86')
    + table([{t: 'Date'}, {t: 'Borrower'}, {t: 'Phone'}, {t: 'Amount', num: true}],
      s.upcoming.map(x => `<tr><td style="${td}white-space:nowrap;">${shortDate_(x.dueDate)}</td><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.phone)}</td><td style="${num}">${naira_(x.amount)}</td></tr>`));
  if (nothing) html += `<p style="margin:0 0 6px;">Nothing is overdue, nothing is due today, and nothing falls due in the next ${plural(r.aheadDays, 'day')}.</p>`;
  html += `<p style="margin:22px 0 0;"><a href="${APP_URL}" style="display:inline-block;background:#2158A6;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;">Open LoanBook</a></p>`;

  const line = x => `- ${x.name} (${x.loanId})${x.phone ? ', ' + x.phone : ''}: ${naira_(x.amount)}`;
  let text = (isTest ? 'This is a test of your LoanBook daily summary.\n\n' : '') + `Still owed across all running loans: ${naira_(rec.owed)}\n`;
  if (s.overdue.length) text += `\nOVERDUE\n` + s.overdue.map(x => line(x) + `, ${plural(x.days, 'day')} late`).join('\n') + '\n';
  if (s.dueToday.length) text += `\nDUE TODAY\n` + s.dueToday.map(line).join('\n') + '\n';
  if (s.upcoming.length) text += `\nCOMING UP\n` + s.upcoming.map(x => `${shortDate_(x.dueDate)} ` + line(x)).join('\n') + '\n';
  if (nothing) text += '\nNothing is overdue or due soon.\n';
  text += `\nOpen LoanBook: ${APP_URL}\n\nYou get this because daily reminders are on in LoanBook → Settings. Switch them off there at any time.`;

  MailApp.sendEmail({to: r.email, replyTo: rec.owner, name: 'LoanBook', subject, body: text, htmlBody: frame_(html, today, rec.asOf, r.timeZone)});
  return true;
}

function heading_(text, color) {
  return `<h3 style="margin:22px 0 8px;font-size:15px;color:${color};">${esc_(text)}</h3>`;
}
function frame_(inner, today, asOf, tz) {
  const asOfText = Utilities.formatDate(new Date(asOf), tz, 'd MMM yyyy, HH:mm');
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F1D33;background:#F4F7FC;padding:20px 12px;">`
    + `<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #DCE5F3;border-radius:12px;padding:22px 20px;">`
    + `<div style="font-size:19px;font-weight:700;margin:0 0 2px;">Loan<span style="color:#2158A6;">Book</span></div>`
    + `<div style="color:#8B99B2;font-size:13px;margin:0 0 18px;">Daily summary · ${longDate_(today)}</div>`
    + inner
    + `<p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #DCE5F3;color:#8B99B2;font-size:12px;">Figures from your book as of ${esc_(asOfText)}. You get this because daily reminders are switched on in LoanBook → Settings → Daily reminder email. Switch them off there at any time.</p>`
    + `</div></div>`;
}

const MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parts_(iso) { const [y, m, d] = iso.split('-').map(Number); return {y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay()}; }
function shortDate_(iso) { const p = parts_(iso); return `${DAYS_[p.dow]} ${p.d} ${MONTHS_[p.m - 1]}`; }
function longDate_(iso) { const p = parts_(iso); return `${DAYS_[p.dow]} ${p.d} ${MONTHS_[p.m - 1]} ${p.y}`; }
function addDays_(iso, n) { const p = parts_(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10); }
function daysBetween_(a, b) { const x = parts_(a), y = parts_(b); return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000); }
function hourLabel_(h) { return `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`; }
function naira_(n) { return '₦' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
