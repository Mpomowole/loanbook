// Tests for daily-reminder.js, the Google Apps Script that emails the daily
// summary. Google's services are replaced with small stand-ins so the script
// runs here exactly as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const {load} = require('./harness.cjs');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'daily-reminder.js'), 'utf8');
const clone = o => JSON.parse(JSON.stringify(o));

function partsIn(date, tz){
  const f = new Intl.DateTimeFormat('en-GB', {timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'});
  const o = {}; f.formatToParts(date).forEach(p=>{ o[p.type] = p.value; });
  return o;
}
function appsScript({book, now, owner='ade@example.com'}){
  const sent = [], props = new Map(), triggers = [];
  let current = now;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a){ if(a.length) super(...a); else super(current); } static now(){ return current; } }
  const file = book && {isTrashed:()=>false, getLastUpdated:()=>new RealDate(0), getBlob:()=>({getDataAsString:()=>JSON.stringify(book.wrapped)})};
  const ctx = {
    Date: FakeDate, Math, JSON, Number, String, Object, Array, isFinite, console,
    DriveApp:{getFilesByName:()=>{ const list = file ? [file] : []; let i = 0; return {hasNext:()=>i<list.length, next:()=>list[i++]}; }},
    MailApp:{sendEmail:m=>sent.push(m)},
    Utilities:{formatDate:(d, tz, fmt)=>{ const p = partsIn(d, tz); if(fmt==='yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`; if(fmt==='H') return String(Number(p.hour)); throw new Error(fmt); }},
    PropertiesService:{getUserProperties:()=>({getProperty:k=>props.has(k)?props.get(k):null, setProperty:(k,v)=>props.set(k,v), deleteProperty:k=>props.delete(k)})},
    Session:{getEffectiveUser:()=>({getEmail:()=>owner}), getScriptTimeZone:()=>'America/New_York'},
    ScriptApp:{getProjectTriggers:()=>triggers.slice(), deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),
      newTrigger:fn=>({timeBased:()=>({everyHours:n=>({create:()=>triggers.push({fn, everyHours:n})})})})}
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return {ctx, sent, triggers, props, setNow:t=>{ current = t; }};
}
// A Lagos-time instant
const lagos = (iso, hour) => Date.parse(`${iso}T${String(hour).padStart(2,'0')}:20:00+01:00`);

function sampleBook(today, reminders){
  const {api} = load();
  api.setAuth({username:'Ade', email:'ade@example.com'});
  api.state = api.freshState();
  api.TODAY = today;
  api.loadSampleData();
  api.addBorrower({name:'Bad <b>Name</b>', phone:'0800'});
  if(reminders) Object.assign(api.state.reminders, reminders);
  const data = clone(api.state);
  return {api, data, wrapped: api.wrapBook(api.state, null)};
}

test('the summary agrees with the app ledger to the naira', ()=>{
  const today = '2026-09-30';
  const {api, data} = sampleBook(today);
  const {ctx} = appsScript({book:null, now:lagos(today, 8)});
  for(const ahead of [3, 7, 30]){
    const s = ctx.summarize_(data, today, ahead);
    const loans = api.allLoans();
    const expectOverdue = clone(loans.filter(l=>l.ledger.overdueAmount>0).map(l=>[l.id, l.ledger.overdueAmount])).sort();
    assert.deepEqual(clone(s.overdue.map(x=>[x.loan.id, x.amount])).sort(), expectOverdue);
    const horizon = new Date(Date.UTC(...today.split('-').map((v,i)=>i===1?v-1:+v)) + ahead*86400000).toISOString().slice(0,10);
    const expectUpcoming = [];
    loans.forEach(l=>l.ledger.schedule.forEach(p=>{ if(p.outstanding>0 && p.dueDate>today && p.dueDate<=horizon) expectUpcoming.push([l.id, p.period, p.outstanding]); }));
    assert.deepEqual(clone(s.upcoming.map(x=>[x.loan.id, x.period, x.amount])).sort(), clone(expectUpcoming).sort());
    const expectToday = [];
    loans.forEach(l=>l.ledger.schedule.forEach(p=>{ if(p.outstanding>0 && p.dueDate===today) expectToday.push([l.id, p.outstanding]); }));
    assert.deepEqual(clone(s.dueToday.map(x=>[x.loan.id, x.amount])).sort(), clone(expectToday).sort());
    const owed = loans.reduce((t,l)=>t+l.ledger.totalOutstanding, 0);
    assert.equal(Math.round(s.owed), Math.round(owed));
  }
});

test('nothing is sent while reminders are switched off in LoanBook', ()=>{
  const today = '2026-10-01';
  const book = sampleBook(today, {enabled:false, hour:7, timeZone:'Africa/Lagos'});
  const g = appsScript({book, now:lagos(today, 9)});
  g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 0);
});

test('one email a day, at or after the chosen hour, in the owner\'s time zone', ()=>{
  const today = '2026-10-01';
  const book = sampleBook(today, {enabled:true, hour:7, timeZone:'Africa/Lagos', email:'ade@example.com'});
  const g = appsScript({book, now:lagos(today, 6)});
  g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 0, 'not before 7am Lagos');
  g.setNow(lagos(today, 7)); g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 1, 'sent at 7am');
  g.setNow(lagos(today, 8)); g.ctx.hourlyCheck();
  g.setNow(lagos(today, 22)); g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 1, 'only once that day');
  g.setNow(lagos('2026-10-02', 7)); g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 2, 'again the next morning');
  assert.equal(g.sent[0].to, 'ade@example.com');
});

test('the email lists overdue borrowers with phone links, and escapes names', ()=>{
  const today = '2026-10-01';
  const book = sampleBook(today, {enabled:true, hour:7, timeZone:'Africa/Lagos'});
  const g = appsScript({book, now:lagos(today, 7)});
  g.ctx.hourlyCheck();
  const m = g.sent[0];
  assert.match(m.subject, /^LoanBook · Thu 1 Oct: ₦[\d,]+ overdue/);
  assert.match(m.htmlBody, /Emeka Nwosu/);
  assert.match(m.htmlBody, /href="tel:07019876543"/);
  assert.match(m.htmlBody, /defaulted/);
  assert.match(m.body, /OVERDUE/);
  assert.match(m.htmlBody, /mpomowole\.github\.io\/loanbook/);
  assert.ok(!m.htmlBody.includes('<b>Name</b>'), 'borrower names are escaped');
});

test('quiet days are skipped unless "also email when nothing is due" is on', ()=>{
  const {api} = load();
  api.setAuth({username:'Ade', email:'ade@example.com'});
  api.state = api.freshState(); api.TODAY = '2026-10-01';
  const b = api.addBorrower({name:'Paid Up'});
  const l = api.addLoan({borrowerId:b.id, principal:100000, rate:5, structure:'interest-only', months:1, startDate:'2026-08-01', firstPaymentDate:'2026-09-01'});
  api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-09-01', amount:105000, method:'Cash'});
  Object.assign(api.state.reminders, {enabled:true, hour:7, timeZone:'Africa/Lagos'});
  const quiet = {wrapped: api.wrapBook(api.state, null)};
  let g = appsScript({book:quiet, now:lagos('2026-10-01', 7)});
  g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 0);
  api.state.reminders.everyDay = true;
  g = appsScript({book:{wrapped: api.wrapBook(api.state, null)}, now:lagos('2026-10-01', 7)});
  g.ctx.hourlyCheck();
  assert.equal(g.sent.length, 1);
  assert.match(g.sent[0].subject, /nothing due/);
});

test('setup installs exactly one hourly check and sends a first summary at once', ()=>{
  const today = '2026-10-01';
  const book = sampleBook(today, {enabled:true, hour:7, timeZone:'Africa/Lagos'});
  const g = appsScript({book, now:lagos(today, 15)});
  g.ctx.setup(); g.ctx.setup();
  assert.equal(g.triggers.length, 1);
  assert.deepEqual(clone(g.triggers[0]), {fn:'hourlyCheck', everyHours:1});
  assert.equal(g.sent.length, 2);
  assert.match(g.sent[0].htmlBody, /Daily reminders are set up/);
  g.ctx.stop();
  assert.equal(g.triggers.length, 0);
});

test('setup with a different Google account says the book was not found', ()=>{
  const g = appsScript({book:null, now:lagos('2026-10-01', 9), owner:'someone@else.com'});
  g.ctx.setup();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].to, 'someone@else.com');
  assert.match(g.sent[0].subject, /book not found/);
});

test('Drive switched off in Google Cloud gives a plain message, not Google\'s raw text', async ()=>{
  const body = JSON.stringify({error:{code:403, message:'Google Drive API has not been used in project 108999565212 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=108999565212 then retry.', status:'PERMISSION_DENIED', details:[{reason:'SERVICE_DISABLED'}]}});
  const {api} = load({fetch: async()=>({ok:false, status:403, text:async()=>body})});
  api.setAuth({username:'Ade', email:'ade@example.com'});
  api.loadLocal();
  api.setToken('t', Date.now()+3600e3);
  assert.equal(await api.syncNow(), 'error');
  assert.match(api.sync.message, /Google Drive is not switched on for LoanBook yet/);
  assert.ok(!api.sync.message.includes('console.developers'));
});

test('reminder settings sync between devices; the later change wins', async ()=>{
  const {api} = load();
  api.setAuth({username:'Ade', email:'ade@example.com'});
  const a = api.freshState(), b = api.freshState();
  a.reminders = Object.assign(a.reminders, {enabled:true, hour:6, _u:1000});
  b.reminders = Object.assign(b.reminders, {enabled:false, hour:9, _u:2000});
  assert.deepEqual([api.mergeBooks(a, b).book.reminders.enabled, api.mergeBooks(b, a).book.reminders.enabled], [false, false]);
  assert.equal(api.mergeBooks(a, b).book.reminders.hour, 9);
  const legacy = api.normalizeBook({borrowers:[], loans:[]});
  assert.equal(legacy.reminders.enabled, false, 'off unless switched on');
  assert.equal(api.normalizeBook({borrowers:[], loans:[], reminders:{enabled:true, hour:'99', aheadDays:0}}).reminders.hour, 23);
});
