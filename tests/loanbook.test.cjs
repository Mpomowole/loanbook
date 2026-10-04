const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./harness.cjs');
const {createDrive} = require('./fake-drive.cjs');

const sum = (a,f)=>a.reduce((s,x)=>s+f(x),0);
const AUTH = {username:'Ade Martins', email:'ade@example.com'};
function fresh(){ const {api} = load(); api.setAuth(AUTH); api.state = api.freshState(); return api; }
const clone = o => JSON.parse(JSON.stringify(o));

/* ------------------------------ loan engine ------------------------------ */
test('interest-only: monthly interest, capital with the last month', ()=>{
  const {api} = load();
  const t = api.loanTerms(500000, 5, 'interest-only', 3, '2026-07-15');
  assert.deepEqual(clone(t.periods.map(p=>p.scheduled)), [25000,25000,525000]);
  assert.equal(t.interestTotal, 75000); assert.equal(t.totalRepayable, 575000);
  assert.deepEqual(clone(t.periods.map(p=>p.dueDate)), ['2026-07-15','2026-08-15','2026-09-15']);
});
test("reducing balance reproduces Ade's 15k/10k/5k example", ()=>{
  const {api} = load();
  const t = api.loanTerms(300000, 5, 'reducing', 3, '2026-06-28');
  assert.deepEqual(clone(t.periods.map(p=>p.interest)), [15000,10000,5000]);
  assert.deepEqual(clone(t.periods.map(p=>p.capital)), [100000,100000,100000]);
  assert.equal(t.totalRepayable, 330000);
});
test('equal instalments: parts always add up, even with awkward rates', ()=>{
  const {api} = load();
  for(const [P,r,m] of [[250000,4,2],[100000,3.33,3],[777777,2.5,7],[150000,0,4],[1000001,4.75,6]]){
    const t = api.loanTerms(P, r, 'equal', m, '2026-01-31');
    assert.equal(sum(t.periods,p=>p.capital), P, `capital sums ${P}/${r}/${m}`);
    assert.equal(t.interestTotal + P, t.totalRepayable, `interest+capital ${P}/${r}/${m}`);
    assert.equal(sum(t.periods,p=>p.interest), t.interestTotal);
    t.periods.forEach(p=>{ assert.ok(p.capital>=0 && p.interest>=0); assert.equal(p.interest+p.capital, p.scheduled); });
  }
});
test('month-end due dates clamp and do not drift', ()=>{
  const {api} = load();
  const t = api.loanTerms(100000, 5, 'interest-only', 4, '2026-01-31');
  assert.deepEqual(clone(t.periods.map(p=>p.dueDate)), ['2026-01-31','2026-02-28','2026-03-31','2026-04-30']);
});
test('0% loan: interest months show nothing due, capital at end', ()=>{
  const api = fresh();
  api.TODAY = '2026-09-15';
  const b = api.addBorrower({name:'Blessing Adeyemi'});
  const l = api.addLoan({borrowerId:b.id, principal:150000, rate:0, structure:'interest-only', months:2, startDate:'2026-07-30', firstPaymentDate:'2026-08-30'});
  const led = api.computeLedger(l);
  assert.equal(led.schedule[0].status, 'No Payment');
  assert.equal(led.status, 'Active');
  assert.equal(l.totalRepayable, 150000);
});

/* --------------------------------- ledger -------------------------------- */
test('interest earned counts interest-only payments as interest (was zero before)', ()=>{
  const api = fresh(); api.TODAY = '2026-09-01';
  const b = api.addBorrower({name:'Tunde Bakare'});
  const l = api.addLoan({borrowerId:b.id, principal:1000000, rate:5, structure:'interest-only', months:6, startDate:'2026-04-25', firstPaymentDate:'2026-05-25'});
  ['2026-05-25','2026-06-25','2026-07-25','2026-08-25'].forEach(d=>api.addPayment({loanId:l.id, borrowerId:b.id, date:d, amount:50000, method:'Cash'}));
  const led = api.computeLedger(api.getLoan(l.id));
  assert.equal(led.interestPaid, 200000);
  assert.equal(led.capitalRepaid, 0);
  assert.equal(led.capitalOutstanding, 1000000);
  assert.equal(led.status, 'Active');
  const m = api.metrics();
  assert.equal(m.interestEarned, 200000);
  assert.equal(m.capitalOut, 1000000);
  assert.equal(m.collectionRate, 100);
});
test('shortfall rolls forward, overpayment becomes advance credit, exact payment completes', ()=>{
  const api = fresh(); api.TODAY = '2026-08-10';
  const b = api.addBorrower({name:'Chinedu Okafor'});
  const l = api.addLoan({borrowerId:b.id, principal:300000, rate:5, structure:'reducing', months:3, startDate:'2026-05-28', firstPaymentDate:'2026-06-28'});
  api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-06-28', amount:115000, method:'Cash'});
  api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-07-30', amount:70000, method:'Cash'});
  let led = api.computeLedger(api.getLoan(l.id));
  assert.equal(led.overdueAmount, 40000);
  assert.equal(led.status, 'Overdue');
  assert.equal(led.totalOutstanding, 145000);
  const p3 = api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-08-10', amount:145000, method:'Cash'});
  led = api.computeLedger(api.getLoan(l.id));
  assert.equal(led.status, 'Completed'); assert.equal(led.totalOutstanding, 0);
  api.updatePayment(p3.id, {loanId:l.id, borrowerId:b.id, date:'2026-08-10', amount:150000, method:'Cash'});
  led = api.computeLedger(api.getLoan(l.id));
  assert.equal(led.advanceCredit, 5000);
  api.deletePayment(p3.id);
  led = api.computeLedger(api.getLoan(l.id));
  assert.equal(led.totalOutstanding, 145000, 'deleting a payment puts the balance back');
  assert.ok(api.state.tombstones[p3.uid], 'deletion leaves a tombstone');
});
test('defaulted after 90 days overdue', ()=>{
  const api = fresh(); api.TODAY = '2026-09-01';
  const b = api.addBorrower({name:'Emeka Nwosu'});
  const l = api.addLoan({borrowerId:b.id, principal:250000, rate:4, structure:'equal', months:2, startDate:'2026-04-20', firstPaymentDate:'2026-05-20'});
  assert.equal(api.computeLedger(api.getLoan(l.id)).status, 'Defaulted');
});
test('editing a loan recalculates the schedule and keeps its payments', ()=>{
  const api = fresh(); api.TODAY = '2026-10-01';
  const b = api.addBorrower({name:'Amaka Osu'});
  const b2 = api.addBorrower({name:'Ngozi Eze'});
  const l = api.addLoan({borrowerId:b.id, principal:500000, rate:5, structure:'interest-only', months:3, startDate:'2026-06-15', firstPaymentDate:'2026-07-15'});
  api.addPayment({loanId:l.id, borrowerId:b.id, date:'2026-07-15', amount:25000, method:'Cash'});
  api.updateLoan(l.id, {borrowerId:b2.id, principal:500000, rate:4, structure:'interest-only', months:2, startDate:'2026-06-15', firstPaymentDate:'2026-07-15'});
  const L = api.getLoan(l.id);
  assert.equal(L.totalRepayable, 540000);
  assert.equal(api.getLoanPayments(l.id).length, 1);
  assert.equal(api.getLoanPayments(l.id)[0].borrowerId, b2.id, 'payments follow the loan to its new borrower');
});
test('borrower IDs come from the name and never repeat', ()=>{
  const api = fresh();
  const a = api.addBorrower({name:'Amaka Osu'}), b = api.addBorrower({name:'Ade Ogun'}), c = api.addBorrower({name:'Tito'});
  assert.equal(a.id, 'AO-001'); assert.equal(b.id, 'AO-002'); assert.equal(c.id, 'TX-001');
});
test('a borrower with loans cannot be deleted', ()=>{
  const api = fresh();
  const b = api.addBorrower({name:'Amaka Osu'});
  api.addLoan({borrowerId:b.id, principal:1000, rate:0, structure:'interest-only', months:1, startDate:'2026-09-01', firstPaymentDate:'2026-10-01'});
  assert.throws(()=>api.deleteBorrower(b.id));
});

/* ---------------------------------- input -------------------------------- */
test('amounts can be typed with commas and the naira sign', ()=>{
  const {api} = load();
  assert.equal(api.parseAmount('500,000'), 500000);
  assert.equal(api.parseAmount('₦ 25,000'), 25000);
  assert.equal(api.parseAmount('N25000'), 25000);
  assert.ok(Number.isNaN(api.parseAmount('abc')));
  assert.ok(Number.isNaN(api.parseAmount('')));
  assert.ok(Number.isNaN(api.parseAmount('-5')));
  assert.equal(api.parseRate('4.5%'), 4.5);
  assert.ok(Number.isNaN(api.parseRate('')));
});
test('a phone number is found however it is typed', ()=>{
  const {api} = load();
  assert.ok(api.phoneMatches('0803 456 7890', '08034567890'));
  assert.ok(api.phoneMatches('0803-456-7890', '456 78'));
  assert.ok(api.phoneMatches('+234 803 456 7890', '803456'));
  assert.ok(!api.phoneMatches('0803 456 7890', '12'), 'too short to mean anything');
  assert.ok(!api.phoneMatches('0803 456 7890', 'amaka 0803'), 'a name search is not a phone search');
});

test("the borrower page shows the next payment due, not an overdue one, and notes on their loans", ()=>{
  const api = fresh(); api.TODAY = '2026-08-01';
  const b = api.addBorrower({name:'Amaka Osu'});
  const l = api.addLoan({borrowerId:b.id, principal:500000, rate:5, structure:'interest-only', months:3, startDate:'2026-06-15', firstPaymentDate:'2026-07-15'});
  api.addNote({loanId:l.id, text:'Promised to pay on Friday'});
  api.addNote({borrowerId:b.id, text:'Reliable customer'});
  const html = api.pageBorrower(b.id);
  const next = /Next payment<\/div><div class="st-value">([^<]*)</.exec(html)[1];
  assert.equal(next, '15 Aug 2026', 'July is overdue; the next payment due is August');
  assert.match(html, /Promised to pay on Friday/);
  assert.match(html, /Reliable customer/);
  assert.ok(html.includes(`on <a href="#/loans/${l.id}">${l.id}</a>`), 'a loan note says which loan');
});

test("a loan's history keeps payments that were later deleted", ()=>{
  const api = fresh(); api.TODAY = '2026-08-01';
  const b = api.addBorrower({name:'Amaka Osu'});
  const l1 = api.addLoan({borrowerId:b.id, principal:500000, rate:5, structure:'interest-only', months:3, startDate:'2026-06-15', firstPaymentDate:'2026-07-15'});
  const l10 = api.addLoan({borrowerId:b.id, principal:1000, rate:0, structure:'interest-only', months:1, startDate:'2026-06-15', firstPaymentDate:'2026-07-15'});
  const p = api.addPayment({loanId:l1.id, borrowerId:b.id, date:'2026-07-15', amount:25000, method:'Cash'});
  api.deletePayment(p.id);
  const html = api.pageLoan(l1.id);
  assert.match(html, /₦25,000 dated 15 Jul 2026 on LN-0001 from Amaka Osu deleted/);
  assert.ok(!api.pageLoan(l10.id).includes('₦25,000 dated'), 'another loan is not shown it');
});

test('a book with no creation time reads the same every time', ()=>{
  const {api} = load();
  const legacy = {borrowers:[], loans:[], payments:[]};
  assert.equal(api.canonical(api.normalizeBook(clone(legacy))), api.canonical(api.normalizeBook(clone(legacy))));
});

test("inline handler arguments survive quotes (O'Brien)", ()=>{
  const {api} = load();
  const attr = api.jsArg("O'Brien \"Jr\" </script>");
  const decoded = attr.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  assert.equal(JSON.parse(decoded), "O'Brien \"Jr\" </script>");
  assert.ok(!/["'<>]/.test(attr));
});
test('CSV cells cannot smuggle spreadsheet formulas', ()=>{
  const {api} = load();
  assert.equal(api.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(api.csvCell(-5000), '-5000');
  assert.equal(api.csvCell('a,b'), '"a,b"');
});

/* ---------------------------------- merge -------------------------------- */
function baseBook(){
  const api = fresh(); api.TODAY = '2026-10-01';
  api.loadSampleData();
  return clone(api.state);
}
function deviceFrom(book){
  const api = fresh(); api.TODAY = '2026-10-01';
  api.state = api.normalizeBook(clone(book));
  return api;
}
test('normalizing is idempotent', ()=>{
  const b = baseBook();
  const {api} = load();
  const n1 = api.normalizeBook(clone(b)), n2 = api.normalizeBook(clone(n1));
  assert.equal(api.canonical(n1), api.canonical(n2));
});
test('changes made on two devices are combined, not overwritten', ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const amaka = A.state.borrowers.find(b=>b.name==='Amaka Osu');
  const lA = A.state.loans.find(l=>l.borrowerId===amaka.id);
  A.addPayment({loanId:lA.id, borrowerId:amaka.id, date:'2026-09-15', amount:525000, method:'Cash'});
  const kemi = B.addBorrower({name:'Kemi Adebayo'});
  B.addLoan({borrowerId:kemi.id, principal:80000, rate:3, structure:'interest-only', months:1, startDate:'2026-09-20', firstPaymentDate:'2026-10-20'});
  const ab = A.mergeBooks(A.state, B.state).book, ba = A.mergeBooks(B.state, A.state).book;
  for(const m of [ab, ba]){
    assert.equal(m.payments.length, base.payments.length+1);
    assert.equal(m.loans.length, base.loans.length+1);
    assert.ok(m.borrowers.some(b=>b.name==='Kemi Adebayo'));
  }
});
test('same next number on both devices: the unsynced record is renumbered and its links follow', ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const bA = A.state.borrowers[0], bB = B.state.borrowers[1];
  const lA = A.addLoan({borrowerId:bA.id, principal:111000, rate:5, structure:'interest-only', months:1, startDate:'2026-09-01', firstPaymentDate:'2026-10-01'});
  const pA = A.addPayment({loanId:lA.id, borrowerId:bA.id, date:'2026-09-20', amount:5550, method:'Cash'});
  const lB = B.addLoan({borrowerId:bB.id, principal:222000, rate:4, structure:'interest-only', months:2, startDate:'2026-09-02', firstPaymentDate:'2026-10-02'});
  assert.equal(lA.id, lB.id, 'precondition: both devices picked the same loan number');
  const m = A.mergeBooks(A.state, B.state).book;
  const ids = m.loans.map(l=>l.id);
  assert.equal(new Set(ids).size, ids.length, 'loan ids are unique');
  const keptB = m.loans.find(l=>l.uid===lB.uid), movedA = m.loans.find(l=>l.uid===lA.uid);
  assert.equal(keptB.id, lB.id, 'the record already in Drive keeps its number');
  assert.notEqual(movedA.id, lA.id);
  const pay = m.payments.find(p=>p.uid===pA.uid);
  assert.equal(pay.loanId, movedA.id, "A's payment follows its loan to the new number");
  assert.equal(pay.amount, 5550);
  const m2 = A.mergeBooks(B.state, m).book;
  assert.equal(A.canonical(m2), A.canonical(m));
});
test('two new borrowers with the same initials on different devices both survive', ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const ka = A.addBorrower({name:'Kemi Ade'}), kb = B.addBorrower({name:'Kunle Akin'});
  assert.equal(ka.id, kb.id);
  const la = A.addLoan({borrowerId:ka.id, principal:5000, rate:0, structure:'interest-only', months:1, startDate:'2026-09-01', firstPaymentDate:'2026-10-01'});
  const m = A.mergeBooks(A.state, B.state).book;
  const KA = m.borrowers.find(b=>b.uid===ka.uid), KB = m.borrowers.find(b=>b.uid===kb.uid);
  assert.ok(KA && KB); assert.notEqual(KA.id, KB.id);
  assert.equal(m.loans.find(l=>l.uid===la.uid).borrowerId, KA.id);
});
test('deleted records stay deleted whichever way the merge runs', ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const p = A.state.payments[0];
  A.deletePayment(p.id);
  for(const m of [A.mergeBooks(A.state, B.state).book, A.mergeBooks(B.state, A.state).book]){
    assert.ok(!m.payments.some(x=>x.uid===p.uid));
  }
  const loan = A.state.loans[2];
  A.deleteLoan(loan.id);
  B.addNote({loanId:loan.id, text:'called'});
  const m = A.mergeBooks(B.state, A.state).book;
  assert.ok(!m.loans.some(l=>l.uid===loan.uid));
  assert.ok(!m.payments.some(x=>x.loanId===loan.id));
});
test('the later edit to the same record wins', async ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const id = A.state.borrowers[0].id;
  A.updateBorrower(id, Object.assign({}, A.getBorrower(id), {phone:'0800 000 0001'}));
  await new Promise(r=>setTimeout(r, 5));
  B.updateBorrower(id, Object.assign({}, B.getBorrower(id), {phone:'0800 000 0002'}));
  for(const m of [A.mergeBooks(A.state, B.state).book, A.mergeBooks(B.state, A.state).book])
    assert.equal(m.borrowers.find(b=>b.id===id).phone, '0800 000 0002');
});
test('clearing or restoring replaces the book on every device', ()=>{
  const base = baseBook();
  const A = deviceFrom(base), B = deviceFrom(base);
  const reset = A.freshState(); reset.resetAt = Date.now();
  const r = A.mergeBooks(B.state, reset);
  assert.equal(r.reset, 'remote');
  assert.equal(r.book.loans.length, 0);
  const r2 = A.mergeBooks(reset, B.state);
  assert.equal(r2.reset, 'local'); assert.equal(r2.book.loans.length, 0);
});
test('a new, empty device adopts the Drive book without needing to upload', ()=>{
  const base = baseBook();
  const {api} = load();
  const remote = api.normalizeBook(clone(base));
  const m = api.mergeBooks(api.freshState(), remote).book;
  assert.equal(api.canonical(m), api.canonical(remote));
});
test('books saved by the previous version (no uids) load and merge cleanly', ()=>{
  const base = baseBook();
  const legacy = clone(base);
  for(const c of ['borrowers','loans','payments','notes','audit']) legacy[c].forEach(r=>{ delete r.uid; delete r._u; });
  delete legacy.tombstones; delete legacy.resetAt; delete legacy.schema; legacy.lastBackup = Date.now();
  const {api} = load();
  const a = api.normalizeBook(clone(legacy)), b = api.normalizeBook(clone(legacy));
  assert.equal(api.canonical(a), api.canonical(b), 'two devices derive the same identities');
  const m = api.mergeBooks(a, b).book;
  assert.equal(m.loans.length, base.loans.length);
  assert.equal(m.payments.length, base.payments.length);
  assert.equal(api.canonical(m), api.canonical(a));
});
test('hand-damaged ids are repaired and links follow', ()=>{
  const base = baseBook();
  const bad = clone(base);
  const old = bad.loans[0].id;
  bad.loans[0].id = `LN'0001"`;
  bad.payments.filter(p=>p.loanId===old).forEach(p=>p.loanId = `LN'0001"`);
  const {api} = load();
  const n = api.normalizeBook(bad);
  const L = n.loans.find(l=>l.uid===base.loans[0].uid);
  assert.match(L.id, /^LN-\d{4}$/);
  assert.ok(n.payments.filter(p=>p.loanId===L.id).length >= 1);
});

/* ------------------------------ full sync loop ----------------------------- */
async function device(drive, email){
  const {api, store} = load({fetch: drive.fetchFor()});
  api.setAuth({username:'Ade', email});
  api.loadLocal();
  api.setToken(drive.issueToken(email), Date.now()+3600e3);
  api.TODAY = '2026-10-01';
  return {api, store};
}
test('end to end: laptop and phone stay in step through Drive', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api:laptop} = await device(drive, email);
  laptop.loadSampleData();
  assert.equal(await laptop.syncNow(), 'ok');
  assert.equal(laptop.meta.dirty, false);
  assert.ok(drive.book(email), 'file created in Drive');

  const {api:phone} = await device(drive, email);
  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(phone.state.loans.length, laptop.state.loans.length, 'phone gets the whole book');

  const l = phone.state.loans[0];
  phone.addPayment({loanId:l.id, borrowerId:l.borrowerId, date:'2026-09-30', amount:12345, method:'Cash'});
  const nb = laptop.addBorrower({name:'Fola Bello'});
  laptop.addLoan({borrowerId:nb.id, principal:90000, rate:4, structure:'interest-only', months:1, startDate:'2026-09-30', firstPaymentDate:'2026-10-30'});
  const del = laptop.state.payments[0]; laptop.deletePayment(del.id);

  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(await laptop.syncNow(), 'ok');
  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(laptop.canonical(laptop.state), phone.canonical(phone.state), 'both devices hold the same book');
  assert.ok(phone.state.payments.some(p=>p.amount===12345));
  assert.ok(phone.state.borrowers.some(b=>b.name==='Fola Bello'));
  assert.ok(!phone.state.payments.some(p=>p.uid===del.uid));
  const remote = phone.extractBook(drive.book(email));
  assert.equal(phone.canonical(remote), phone.canonical(phone.state), 'Drive holds the same book');
  assert.equal([...drive.files.values()].filter(f=>f.name==='loanbook.json').length, 1);
  assert.equal([...drive.files.values()].filter(f=>/^loanbook-\d{4}-\d{2}-\d{2}\.json$/.test(f.name)).length, 1, 'one daily copy');
});
test('end to end: a new device that cannot reach Drive does not wipe the Drive book', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api:laptop} = await device(drive, email);
  laptop.loadSampleData();
  await laptop.syncNow();
  const {api:phone} = await device(drive, email);
  drive.fail.offline = 1;
  assert.equal(await phone.syncNow(), 'offline');
  phone.addBorrower({name:'Offline Person'});
  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(phone.state.loans.length, laptop.state.loans.length, 'nothing from Drive was lost');
  assert.ok(phone.extractBook(drive.book(email)).borrowers.some(b=>b.name==='Offline Person'));
});
test('end to end: expired access never uploads and leaves changes marked unsaved', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api} = await device(drive, email);
  api.loadSampleData(); await api.syncNow();
  drive.expireAll();
  api.addBorrower({name:'Late Entry'});
  assert.equal(await api.syncNow(), 'auth');
  assert.equal(api.meta.dirty, true);
  assert.equal(api.sync.state, 'auth');
  api.setToken(drive.issueToken(email), Date.now()+3600e3);
  assert.equal(await api.syncNow(), 'ok');
  assert.equal(api.meta.dirty, false);
  assert.ok(api.extractBook(drive.book(email)).borrowers.some(b=>b.name==='Late Entry'));
});
test('end to end: two devices that each created a file are merged into one', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api:a} = await device(drive, email); const {api:b} = await device(drive, email);
  a.addBorrower({name:'Only On A'}); b.addBorrower({name:'Only On B'});
  await a.syncNow();
  const fid = [...drive.files.values()].find(f=>f.name==='loanbook.json').id;
  drive.files.get(fid).name = 'hidden-during-race';
  await b.syncNow();
  drive.files.get(fid).name = 'loanbook.json';
  assert.equal([...drive.files.values()].filter(f=>f.name==='loanbook.json').length, 2);
  assert.equal(await a.syncNow(), 'ok');
  const books = [...drive.files.values()].filter(f=>f.name==='loanbook.json');
  assert.equal(books.length, 1, 'spare copy set aside');
  const names = clone(a.extractBook(JSON.parse(books[0].content)).borrowers.map(x=>x.name).sort());
  assert.deepEqual(names, ['Only On A','Only On B']);
  assert.ok([...drive.files.values()].some(f=>/^loanbook-merged-/.test(f.name)), 'spare kept, renamed, not deleted');
});
test('end to end: server errors retry and a corrupt Drive file is set aside', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api} = await device(drive, email);
  api.addBorrower({name:'Someone'});
  drive.fail.next = 2; drive.fail.status = 503;
  assert.equal(await api.syncNow(), 'ok', 'transient 503s are retried');
  const f = [...drive.files.values()].find(x=>x.name==='loanbook.json');
  f.content = '{not json';
  assert.equal(await api.syncNow(), 'ok');
  assert.ok([...drive.files.values()].some(x=>/^loanbook-unreadable-/.test(x.name)));
  assert.ok(api.extractBook(drive.book(email)).borrowers.some(b=>b.name==='Someone'));
});
test('end to end: a change made while the upload is in flight is not lost', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api} = await device(drive, email);
  api.loadSampleData(); await api.syncNow();
  api.addBorrower({name:'Before Upload'});
  drive.onUpload = ()=>{ drive.onUpload = null; api.addBorrower({name:'Mid Upload'}); };
  assert.equal(await api.syncNow(), 'ok');
  assert.ok(api.state.borrowers.some(b=>b.name==='Mid Upload'), 'still on this device');
  assert.equal(api.meta.dirty, true, 'still marked as not yet in Drive');
  assert.ok(!api.extractBook(drive.book(email)).borrowers.some(b=>b.name==='Mid Upload'));
  assert.equal(await api.syncNow(), 'ok');
  assert.equal(api.meta.dirty, false);
  assert.ok(api.extractBook(drive.book(email)).borrowers.some(b=>b.name==='Mid Upload'));
});
test('end to end: restore on one device replaces the book everywhere', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api:a} = await device(drive, email); const {api:b} = await device(drive, email);
  a.loadSampleData(); await a.syncNow(); await b.syncNow();
  const reset = a.freshState(); reset.resetAt = Date.now();
  a.state = reset; a.addBorrower({name:'After Reset'});
  assert.equal(await a.syncNow(), 'ok');
  b.addBorrower({name:'Stale Edit'});
  assert.equal(await b.syncNow(), 'ok');
  assert.deepEqual(clone(b.state.borrowers.map(x=>x.name)), ['After Reset']);
  // both books that were replaced are kept in Drive's copies folder
  const safety = [...drive.files.values()].filter(f=>/-before-reset\.json$/.test(f.name)).map(f=>a.extractBook(JSON.parse(f.content)));
  assert.ok(safety.some(s=>s.loans.length===7), 'the book that was cleared is saved first');
  assert.ok(safety.some(s=>s.borrowers.some(x=>x.name==='Stale Edit')), "the other device's unsaved work is saved too");
});
test('end to end: the daily copy is the book as it was before the day\'s first change', async ()=>{
  const drive = createDrive();
  const email = 'ade@example.com';
  const {api} = await device(drive, email);
  api.TODAY = '2026-09-30';
  api.loadSampleData(); await api.syncNow();
  assert.equal([...drive.files.values()].filter(f=>/^loanbook-\d{4}-\d{2}-\d{2}\.json$/.test(f.name)).length, 0, 'nothing to copy on a brand-new book');
  api.TODAY = '2026-10-01';
  api.addBorrower({name:'First Of The Day'});
  await api.syncNow();
  const daily = [...drive.files.values()].filter(f=>f.name==='loanbook-2026-10-01.json');
  assert.equal(daily.length, 1);
  const copy = api.extractBook(JSON.parse(daily[0].content));
  assert.equal(copy.loans.length, 7);
  assert.ok(!copy.borrowers.some(b=>b.name==='First Of The Day'));
  api.addBorrower({name:'Second'}); await api.syncNow();
  assert.equal([...drive.files.values()].filter(f=>/^loanbook-2026-10-01/.test(f.name)).length, 1, 'one per day');
});

test('the dashboard counts borrowers who owe now, not everyone on the register', ()=>{
  const api = fresh(); api.TODAY = '2026-10-01';
  const owes = api.addBorrower({name:'Owes Now'}), paid = api.addBorrower({name:'Paid Up'}); api.addBorrower({name:'No Loan Yet'});
  api.addLoan({borrowerId:owes.id, principal:100000, rate:5, structure:'interest-only', months:3, startDate:'2026-09-01', firstPaymentDate:'2026-10-01'});
  api.addLoan({borrowerId:owes.id, principal:50000, rate:5, structure:'interest-only', months:3, startDate:'2026-09-15', firstPaymentDate:'2026-10-15'});
  const done = api.addLoan({borrowerId:paid.id, principal:100000, rate:5, structure:'interest-only', months:1, startDate:'2026-08-01', firstPaymentDate:'2026-09-01'});
  api.addPayment({loanId:done.id, borrowerId:paid.id, date:'2026-09-01', amount:105000, method:'Cash'});
  const m = api.metrics();
  assert.equal(m.activeBorrowers, 1, 'two loans, one person');
  assert.equal(m.openLoans, 2);
  assert.equal(m.borrowers, 3);
});
