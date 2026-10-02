// Tests for the daily reminder email: the app side (what LoanBook sends and
// when) and reminder-service/Code.gs (the Google Apps Script web app that
// stores each user's list and emails them). Google's services are replaced
// with small stand-ins so both run here exactly as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const {load} = require('./harness.cjs');

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'reminder-service', 'Code.gs'), 'utf8');
const CLIENT_ID = '108999565212-hm2sdqajqq3hos8mg5ids1aa36hgr35f.apps.googleusercontent.com';
const URL_ = 'https://script.google.com/macros/s/TEST/exec';
const clone = o => JSON.parse(JSON.stringify(o));
const lagos = (iso, hour) => Date.parse(`${iso}T${String(hour).padStart(2,'0')}:20:00+01:00`);

/* ---------------- a stand-in Google Apps Script runtime ---------------- */
function partsIn(date, tz){
  const f = new Intl.DateTimeFormat('en-GB', {timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
  const o = {}; f.formatToParts(date).forEach(p=>{ o[p.type] = p.value; }); return o;
}
function service(){
  const sent = [], scriptProps = new Map(), triggers = [], tokens = new Map(), files = [];
  let now = Date.now(), folderMade = 0;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a){ if(a.length) super(...a); else super(now); } static now(){ return now; } }
  const mkFile = (name, content)=>{ const f = {name, content, trashed:false,
    getName:()=>f.name, isTrashed:()=>f.trashed, setTrashed:v=>{ f.trashed = v; }, setContent:t=>{ f.content = t; },
    getBlob:()=>({getDataAsString:()=>f.content})}; files.push(f); return f; };
  const iter = list => { let i = 0; return {hasNext:()=>i<list.length, next:()=>list[i++]}; };
  const folder = {getFilesByName:n=>iter(files.filter(f=>f.name===n)), getFiles:()=>iter(files.slice()), createFile:(n,t)=>mkFile(n,t)};
  const ctx = {
    Date: FakeDate, Math, JSON, Number, String, Object, Array, isFinite, parseInt, console,
    UrlFetchApp:{fetch:url=>{ const t = decodeURIComponent(url.split('access_token=')[1]); const info = tokens.get(t);
      return {getResponseCode:()=>info?200:400, getContentText:()=>JSON.stringify(info||{error:'invalid_token'})}; }},
    DriveApp:{getFoldersByName:()=>iter(folderMade?[folder]:[]), createFolder:()=>{ folderMade++; return folder; }},
    Utilities:{
      DigestAlgorithm:{SHA_256:'sha256'},
      computeDigest:(alg, s)=>[...crypto.createHash('sha256').update(s,'utf8').digest()].map(b=>b>127?b-256:b),
      formatDate:(d, tz, fmt)=>{ const p = partsIn(d, tz);
        if(fmt==='yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
        if(fmt==='H') return String(Number(p.hour));
        if(fmt==='d MMM yyyy, HH:mm') return `${Number(p.day)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][p.month-1]} ${p.year}, ${p.hour}:${p.minute}`;
        throw new Error('format '+fmt); }},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>scriptProps.has(k)?scriptProps.get(k):null, setProperty:(k,v)=>scriptProps.set(k,v), deleteProperty:k=>scriptProps.delete(k)})},
    LockService:{getScriptLock:()=>({waitLock(){}, tryLock:()=>true, releaseLock(){}})},
    ContentService:{MimeType:{JSON:'json'}, createTextOutput:s=>({body:s, setMimeType(){ return this; }})},
    MailApp:{sendEmail:m=>sent.push(m)},
    ScriptApp:{getProjectTriggers:()=>triggers.slice(), deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),
      newTrigger:fn=>({timeBased:()=>({everyHours:n=>({create:()=>triggers.push({fn, everyHours:n})})})})}
  };
  vm.createContext(ctx);
  vm.runInContext(SERVICE, ctx);
  const svc = {ctx, sent, files, triggers, tokens,
    setNow:t=>{ now = t; },
    signIn:(email, aud=CLIENT_ID)=>{ const t = 'tok-'+Math.random().toString(36).slice(2); tokens.set(t, {aud, azp:aud, email, email_verified:'true'}); return t; },
    post:body=>JSON.parse(ctx.doPost({postData:{contents: typeof body==='string' ? body : JSON.stringify(body)}}).body),
    live:()=>files.filter(f=>!f.trashed)};
  // The app's fetch(), delivered straight to the service's doPost
  svc.fetch = async (url, opts)=>{ assert.equal(url, URL_); const out = ctx.doPost({postData:{contents:opts.body}}); return {json:async()=>JSON.parse(out.body)}; };
  return svc;
}
function app(svc, email, today){
  const {api} = load({reminderUrl:URL_, fetch:svc.fetch});
  api.setAuth({username:'Ade', email});
  api.loadLocal();
  api.state = api.freshState();
  api.TODAY = today;
  api.setToken(svc.signIn(email), Date.now()+3600e3);
  return api;
}

/* -------------------------------- tests -------------------------------- */
test('nothing is sent anywhere while reminders are off', async ()=>{
  const svc = service();
  const api = app(svc, 'ade@example.com', '2026-10-01');
  api.loadSampleData();
  assert.equal(await api.pushReminders(), 'same');
  assert.equal(svc.files.length, 0);
});

test('with no service configured the app does nothing', async ()=>{
  const {api} = load({fetch: async()=>{ throw new Error('should not be called'); }});
  api.setAuth({username:'Ade', email:'ade@example.com'}); api.loadLocal(); api.setToken('t', Date.now()+3600e3);
  api.state.reminders.enabled = true;
  assert.equal(await api.pushReminders(), 'skip');
});

test('switching on sends only the payments still owed, then only on change', async ()=>{
  const svc = service();
  const api = app(svc, 'ade@example.com', '2026-10-01');
  api.loadSampleData();
  Object.assign(api.state.reminders, {enabled:true, hour:7, aheadDays:7, timeZone:'Africa/Lagos'});
  const p = api.reminderPayload();
  assert.deepEqual(Object.keys(p.items[0]).sort(), ['amount','dueDate','loanId','name','phone']);
  const unpaid = api.allLoans().reduce((n,l)=>n + l.ledger.schedule.filter(x=>x.outstanding>0).length, 0);
  assert.equal(p.items.length, unpaid);
  assert.equal(await api.pushReminders(), 'ok');
  assert.equal(svc.live().length, 1);
  assert.equal(await api.pushReminders(), 'same', 'unchanged list is not sent again');
  const l = api.state.loans[0];
  api.addPayment({loanId:l.id, borrowerId:l.borrowerId, date:'2026-10-01', amount:25000, method:'Cash'});
  assert.equal(await api.pushReminders(), 'ok', 'a new payment updates the list');
  const stored = JSON.parse(svc.live()[0].content);
  assert.equal(stored.owner, 'ade@example.com');
  assert.ok(!('token' in stored), 'the sign-in token is not kept');
});

test('switching off deletes the list from the service', async ()=>{
  const svc = service();
  const api = app(svc, 'ade@example.com', '2026-10-01');
  api.loadSampleData();
  Object.assign(api.state.reminders, {enabled:true, timeZone:'Africa/Lagos'});
  await api.pushReminders();
  assert.equal(svc.live().length, 1);
  api.state.reminders.enabled = false;
  assert.equal(await api.pushReminders(), 'ok');
  assert.equal(svc.live().length, 0);
  assert.ok(svc.files.every(f=>f.content==='{}'), 'blanked before going to the bin');
  assert.equal(await api.pushReminders(), 'same');
});

test('requests without a valid LoanBook sign-in are refused', ()=>{
  const svc = service();
  const body = {settings:{enabled:true, email:'victim@example.com'}, items:[{name:'X', loanId:'L', dueDate:'2026-10-01', amount:5}]};
  assert.deepEqual(svc.post(Object.assign({token:'forged'}, body)), {ok:false, error:'not-signed-in'});
  assert.deepEqual(svc.post(Object.assign({token:svc.signIn('a@b.com', 'some-other-app')}, body)), {ok:false, error:'not-signed-in'});
  assert.deepEqual(svc.post('not json'), {ok:false, error:'bad-request'});
  assert.equal(svc.files.length, 0);
});

test('the daily email matches the app ledger to the naira, once a day at the chosen time', async ()=>{
  const svc = service();
  const today = '2026-10-01';
  const api = app(svc, 'ade@example.com', today);
  api.loadSampleData();
  api.addBorrower({name:'Bad <b>Name</b>'});
  Object.assign(api.state.reminders, {enabled:true, hour:7, aheadDays:30, timeZone:'Africa/Lagos', email:'ade@example.com'});
  await api.pushReminders();
  svc.ctx.setup();
  assert.deepEqual(clone(svc.triggers), [{fn:'sendDue', everyHours:1}]);

  svc.setNow(lagos(today, 6)); svc.ctx.sendDue();
  assert.equal(svc.sent.length, 0, 'not before 7am Lagos time');
  svc.setNow(lagos(today, 7)); svc.ctx.sendDue();
  svc.setNow(lagos(today, 12)); svc.ctx.sendDue();
  assert.equal(svc.sent.length, 1, 'once that day');
  svc.setNow(lagos('2026-10-02', 8)); svc.ctx.sendDue();
  assert.equal(svc.sent.length, 2, 'again the next morning');

  const m = svc.sent[0];
  assert.equal(m.to, 'ade@example.com'); assert.equal(m.replyTo, 'ade@example.com'); assert.equal(m.name, 'LoanBook');
  const loans = api.allLoans();
  const overdue = loans.reduce((s,l)=>s+l.ledger.overdueAmount, 0);
  const fmt = n=>'₦'+Math.round(n).toLocaleString('en-US');
  assert.ok(m.subject.includes(`${fmt(overdue)} overdue`), m.subject);
  for(const l of loans.filter(l=>l.ledger.overdueAmount>0)) assert.ok(m.htmlBody.includes(fmt(l.ledger.overdueAmount)), `overdue amount for ${l.id}`);
  const owed = loans.reduce((s,l)=>s+l.ledger.totalOutstanding, 0);
  assert.ok(m.htmlBody.includes(fmt(owed)), 'total still owed');
  assert.match(m.htmlBody, /href="tel:07019876543"/);
  assert.match(m.htmlBody, /defaulted/);
  assert.ok(!m.htmlBody.includes('<b>Name</b>'), 'names are escaped');
});

test('quiet days are skipped unless asked for; the test email always goes', async ()=>{
  const svc = service();
  const api = app(svc, 'ade@example.com', '2026-10-01');
  const b = api.addBorrower({name:'Paid Up'});
  const l = api.addLoan({borrowerId:b.id, principal:100000, rate:5, structure:'interest-only', months:1, startDate:'2026-08-01', firstPaymentDate:'2026-09-01'});
  api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-09-01', amount:105000, method:'Cash'});
  Object.assign(api.state.reminders, {enabled:true, hour:7, timeZone:'Africa/Lagos'});
  await api.pushReminders();
  svc.setNow(lagos('2026-10-01', 9)); svc.ctx.sendDue();
  assert.equal(svc.sent.length, 0);
  assert.equal(await api.pushReminders({test:true}), 'ok');
  assert.equal(svc.sent.length, 1);
  assert.match(svc.sent[0].subject, /^Test · LoanBook/);
  api.state.reminders.everyDay = true;
  await api.pushReminders();
  svc.setNow(lagos('2026-10-02', 9)); svc.ctx.sendDue();
  assert.equal(svc.sent.length, 2);
  assert.match(svc.sent[1].subject, /nothing due/);
});

test('each Google account has its own list', async ()=>{
  const svc = service();
  const a = app(svc, 'ade@example.com', '2026-10-01'); a.loadSampleData();
  const b = app(svc, 'other@example.com', '2026-10-01'); b.addBorrower({name:'Someone'});
  Object.assign(a.state.reminders, {enabled:true, timeZone:'Africa/Lagos', hour:7});
  Object.assign(b.state.reminders, {enabled:true, timeZone:'Africa/Lagos', hour:7, everyDay:true});
  await a.pushReminders(); await b.pushReminders();
  assert.equal(svc.live().length, 2);
  svc.setNow(lagos('2026-10-01', 7)); svc.ctx.sendDue();
  assert.deepEqual(svc.sent.map(m=>m.to).sort(), ['ade@example.com','other@example.com']);
  assert.ok(!svc.sent.find(m=>m.to==='other@example.com').htmlBody.includes('Amaka'), 'nobody sees another account\'s borrowers');
});

test('a bad time zone or address falls back safely', ()=>{
  const svc = service();
  const tok = svc.signIn('ade@example.com');
  assert.equal(svc.post({token:tok, settings:{enabled:true, timeZone:'Not/AZone', email:'nope', hour:99}, items:[]}).ok, true);
  const rec = JSON.parse(svc.live()[0].content);
  assert.equal(rec.settings.timeZone, 'Africa/Lagos');
  assert.equal(rec.settings.email, 'ade@example.com');
  assert.equal(rec.settings.hour, 23);
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

test('reminder settings sync between devices; the later change wins', ()=>{
  const {api} = load();
  const a = api.freshState(), b = api.freshState();
  a.reminders = Object.assign(a.reminders, {enabled:true, hour:6, _u:1000});
  b.reminders = Object.assign(b.reminders, {enabled:false, hour:9, _u:2000});
  assert.equal(api.mergeBooks(a, b).book.reminders.enabled, false);
  assert.equal(api.mergeBooks(b, a).book.reminders.hour, 9);
  assert.equal(api.normalizeBook({borrowers:[], loans:[]}).reminders.enabled, false, 'off unless switched on');
  assert.equal(api.normalizeBook({borrowers:[], loans:[], reminders:{enabled:true, hour:'99'}}).reminders.hour, 23);
});
