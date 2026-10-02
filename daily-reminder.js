/**
 * LoanBook — daily reminder email
 * ===============================
 * This runs in YOUR OWN Google account (Google Apps Script). Once an hour it
 * opens loanbook.json — the book LoanBook keeps in your Google Drive — and, at
 * the time you chose, emails you who is overdue, who owes today and what is
 * coming up. It only ever reads that one file and only ever emails the address
 * set in LoanBook.
 *
 * Switch reminders on or off at any time in LoanBook → Settings → Daily
 * reminder email. This script follows that switch; you never need to come
 * back here to turn it off.
 *
 * ONE-TIME SETUP
 *   1. Paste this whole file into a new project at https://script.google.com
 *   2. Click Save, choose "setup" next to the Run button, and click Run
 *   3. Allow the permissions Google asks for. A first summary arrives at once.
 *
 * TO REMOVE COMPLETELY: choose "stop" and click Run, or delete the project.
 */

const APP_URL = 'https://mpomowole.github.io/loanbook/';
const BOOK_FILE = 'loanbook.json';

/* Installs the hourly check and sends a first summary so you can see it works. */
function setup() {
  stop();
  ScriptApp.newTrigger('hourlyCheck').timeBased().everyHours(1).create();
  const book = readBook_();
  const r = settings_(book);
  let intro;
  if (!book) intro = 'Daily reminders are installed, but LoanBook’s book was not found in this Google account’s Drive. Set this up with the same Google account you use to sign in to LoanBook.';
  else if (r.enabled) intro = `Daily reminders are set up. You’ll get a summary like this every day at about ${hourLabel_(r.hour)}.`;
  else intro = 'Daily reminders are installed but switched off in LoanBook. Turn on “Email me a daily summary” in LoanBook → Settings and they start the next morning.';
  sendSummary_(book, r, intro, true);
}

/* Removes the hourly check. */
function stop() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

/* Sends today's summary straight away, whatever the settings say. */
function sendNow() {
  const book = readBook_();
  sendSummary_(book, settings_(book), '', true);
}

/* Runs every hour; sends at most one email a day, at or after the chosen hour. */
function hourlyCheck() {
  const book = readBook_();
  if (!book) return;
  const r = settings_(book);
  if (!r.enabled) return;
  const now = new Date();
  const day = Utilities.formatDate(now, r.timeZone, 'yyyy-MM-dd');
  const hour = Number(Utilities.formatDate(now, r.timeZone, 'H'));
  const props = PropertiesService.getUserProperties();
  if (hour < r.hour || props.getProperty('lastSentDay') === day) return;
  sendSummary_(book, r, '', false);
  props.setProperty('lastSentDay', day);
}

/* ------------------------------------------------------------------------ */

function readBook_() {
  const files = DriveApp.getFilesByName(BOOK_FILE);
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.isTrashed()) continue;
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
  if (!best) return null;
  const json = JSON.parse(best.getBlob().getDataAsString('UTF-8'));
  return (json && json.data) ? json.data : json;
}

function settings_(book) {
  const r = (book && book.reminders) || {};
  const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  return {
    enabled: !!r.enabled,
    email: String(r.email || '').trim() || Session.getEffectiveUser().getEmail(),
    hour: num(r.hour, 0, 23, 7),
    aheadDays: num(r.aheadDays, 1, 31, 7),
    everyDay: !!r.everyDay,
    timeZone: r.timeZone || Session.getScriptTimeZone() || 'Africa/Lagos'
  };
}

/* Same rule as the app: money received is applied to the schedule oldest
   month first, so a shortfall stays with the earliest unpaid month. */
function summarize_(book, today, aheadDays) {
  const people = {};
  (book.borrowers || []).forEach(b => { people[b.id] = b; });
  const paid = {};
  (book.payments || []).forEach(p => { paid[p.loanId] = (paid[p.loanId] || 0) + Number(p.amount || 0); });
  const horizon = addDays_(today, aheadDays);
  const out = {overdue: [], dueToday: [], upcoming: [], owed: 0};
  (book.loans || []).forEach(l => {
    const person = people[l.borrowerId] || {name: l.borrowerId, phone: ''};
    let left = paid[l.id] || 0, overdue = 0, oldest = null;
    (l.schedule || []).forEach(p => {
      const scheduled = Number(p.scheduled || 0);
      const applied = Math.max(0, Math.min(left, scheduled));
      left -= applied;
      const due = Math.round((scheduled - applied) * 100) / 100;
      if (due <= 0) return;
      if (p.dueDate < today) { overdue += due; if (!oldest) oldest = p.dueDate; }
      else if (p.dueDate === today) out.dueToday.push({person, loan: l, amount: due, period: p.period});
      else if (p.dueDate <= horizon) out.upcoming.push({person, loan: l, date: p.dueDate, amount: due, period: p.period});
    });
    out.owed += Math.max(0, Number(l.totalRepayable || 0) - (paid[l.id] || 0));
    if (overdue > 0) out.overdue.push({person, loan: l, amount: overdue, days: daysBetween_(oldest, today)});
  });
  out.overdue.sort((a, b) => b.amount - a.amount);
  out.dueToday.sort((a, b) => a.person.name.localeCompare(b.person.name));
  out.upcoming.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.person.name.localeCompare(b.person.name));
  return out;
}

function sendSummary_(book, r, intro, force) {
  if (!book) {
    MailApp.sendEmail({to: r.email, name: 'LoanBook', subject: 'LoanBook reminders: book not found',
      body: intro, htmlBody: frame_(`<p style="margin:0;">${esc_(intro)}</p>`)});
    return;
  }
  const today = Utilities.formatDate(new Date(), r.timeZone, 'yyyy-MM-dd');
  const s = summarize_(book, today, r.aheadDays);
  const nothing = !s.overdue.length && !s.dueToday.length && !s.upcoming.length;
  if (nothing && !r.everyDay && !force) return;

  const sum = list => list.reduce((t, x) => t + x.amount, 0);
  const parts = [];
  if (s.overdue.length) parts.push(`${naira_(sum(s.overdue))} overdue`);
  if (s.dueToday.length) parts.push(`${s.dueToday.length} due today`);
  if (s.upcoming.length) parts.push(`${s.upcoming.length} coming up`);
  const subject = `LoanBook · ${shortDate_(today)}: ${parts.length ? parts.join(' · ') : 'nothing due'}`;

  const tel = p => p ? `<a href="tel:${esc_(String(p).replace(/[^\d+]/g, ''))}" style="color:#2158A6;text-decoration:none;">${esc_(p)}</a>` : '—';
  const th = 'text-align:left;padding:8px 10px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#4C5C77;background:#EDF2FA;border-bottom:1px solid #DCE5F3;';
  const td = 'padding:9px 10px;border-bottom:1px solid #DCE5F3;font-size:14px;vertical-align:top;';
  const num = td + 'text-align:right;white-space:nowrap;font-family:Consolas,Menlo,monospace;';
  const table = (heads, rows) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #DCE5F3;margin:0 0 6px;">`
    + `<tr>${heads.map(h => `<th style="${th}${h.num ? 'text-align:right;' : ''}">${h.t}</th>`).join('')}</tr>${rows.join('')}</table>`;
  const who = x => `<b>${esc_(x.person.name)}</b><br><span style="color:#8B99B2;font-size:12px;">${esc_(x.loan.id)}</span>`;

  let html = intro ? `<p style="margin:0 0 18px;padding:12px 14px;background:#E3ECFB;color:#153E7B;border-radius:8px;">${esc_(intro)}</p>` : '';
  html += `<p style="margin:0 0 18px;color:#4C5C77;">Still owed across all running loans: <b style="color:#0F1D33;">${naira_(s.owed)}</b></p>`;
  if (s.overdue.length) html += heading_(`Overdue · ${naira_(sum(s.overdue))}`, '#AD2E3E')
    + table([{t: 'Borrower'}, {t: 'Phone'}, {t: 'Overdue', num: true}, {t: 'Late', num: true}],
      s.overdue.map(x => `<tr><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.person.phone)}</td><td style="${num}color:#AD2E3E;">${naira_(x.amount)}</td><td style="${num}">${x.days} day${x.days === 1 ? '' : 's'}${x.days > 90 ? '<br><span style="font-size:11px;color:#AD2E3E;">defaulted</span>' : ''}</td></tr>`));
  if (s.dueToday.length) html += heading_(`Due today · ${naira_(sum(s.dueToday))}`, '#A9781F')
    + table([{t: 'Borrower'}, {t: 'Phone'}, {t: 'Amount', num: true}],
      s.dueToday.map(x => `<tr><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.person.phone)}</td><td style="${num}">${naira_(x.amount)}</td></tr>`));
  if (s.upcoming.length) html += heading_(`Coming up in the next ${r.aheadDays} days · ${naira_(sum(s.upcoming))}`, '#0E7C86')
    + table([{t: 'Date'}, {t: 'Borrower'}, {t: 'Phone'}, {t: 'Amount', num: true}],
      s.upcoming.map(x => `<tr><td style="${td}white-space:nowrap;">${shortDate_(x.date)}</td><td style="${td}">${who(x)}</td><td style="${td}">${tel(x.person.phone)}</td><td style="${num}">${naira_(x.amount)}</td></tr>`));
  if (nothing) html += `<p style="margin:0 0 6px;">Nothing is overdue, nothing is due today, and nothing falls due in the next ${r.aheadDays} days.</p>`;
  html += `<p style="margin:22px 0 0;"><a href="${APP_URL}" style="display:inline-block;background:#2158A6;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;">Open LoanBook</a></p>`;

  const line = x => `- ${x.person.name} (${x.loan.id})${x.person.phone ? ', ' + x.person.phone : ''}: ${naira_(x.amount)}`;
  let text = (intro ? intro + '\n\n' : '') + `Still owed across all running loans: ${naira_(s.owed)}\n`;
  if (s.overdue.length) text += `\nOVERDUE\n` + s.overdue.map(x => line(x) + `, ${x.days} day${x.days === 1 ? '' : 's'} late`).join('\n') + '\n';
  if (s.dueToday.length) text += `\nDUE TODAY\n` + s.dueToday.map(line).join('\n') + '\n';
  if (s.upcoming.length) text += `\nCOMING UP\n` + s.upcoming.map(x => `${shortDate_(x.date)} ` + line(x)).join('\n') + '\n';
  if (nothing) text += '\nNothing is overdue or due soon.\n';
  text += `\nOpen LoanBook: ${APP_URL}\n\nYou get this because daily reminders are on in LoanBook → Settings. Switch them off there at any time.`;

  MailApp.sendEmail({to: r.email, name: 'LoanBook', subject, body: text, htmlBody: frame_(html, today)});
}

function heading_(text, color) {
  return `<h3 style="margin:22px 0 8px;font-size:15px;color:${color};">${esc_(text)}</h3>`;
}
function frame_(inner, today) {
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F1D33;background:#F4F7FC;padding:20px 12px;">`
    + `<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #DCE5F3;border-radius:12px;padding:22px 20px;">`
    + `<div style="font-size:19px;font-weight:700;margin:0 0 2px;">Loan<span style="color:#2158A6;">Book</span></div>`
    + (today ? `<div style="color:#8B99B2;font-size:13px;margin:0 0 18px;">Daily summary · ${longDate_(today)}</div>` : '<div style="height:14px;"></div>')
    + inner
    + `<p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #DCE5F3;color:#8B99B2;font-size:12px;">You get this because daily reminders are switched on in LoanBook → Settings → Daily reminder email. Switch them off there at any time.</p>`
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
