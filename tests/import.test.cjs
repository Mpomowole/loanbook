// Spreadsheet import: reading cells the way people actually type them,
// matching columns by heading, checking rows, importing, re-importing and undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./harness.cjs');
const {createDrive} = require('./fake-drive.cjs');

const clone = o => JSON.parse(JSON.stringify(o));
function fresh(){
  const {api} = load();
  api.setAuth({username:'Ade Martins', email:'ade@example.com'});
  api.state = api.freshState();
  api.TODAY = '2026-10-01';
  api.sync.remoteKnown = true;
  return api;
}
/* A sheet as the reader hands it over: raw values and the text Excel shows.
   A cell written [v, w] has a raw value and different display text (a % cell). */
function sheet(name, rows){
  return {name, rowBase:0, colBase:0,
    rows: rows.map(r=>r.map(c=>Array.isArray(c) ? c[0] : c)),
    text: rows.map(r=>r.map(c=>Array.isArray(c) ? c[1] : String(c)))};
}
const cell = (v, w) => ({v, w: w==null ? String(v) : w});

// Excel day numbers: 46188 is 15 Jun 2026, 46249 is 15 Aug 2026.
const LOANS = [
  ['Ade Martins — loans 2026'],
  [],
  ['S/N','Customer Name','Phone No','Amount Given (₦)','Interest Rate','Tenor','Date Given','Repayment','Total Paid','Date of last payment','Remarks'],
  [1,'Amaka Osu','0803 456 7890',500000,[0.05,'5%'],'3 months',46188,'Interest only',50000,46249,'Fabric'],
  [2,'Tunde Bakare','','₦300,000','5%','3','28/05/2026','Reducing balance','','','Shop'],
  [3,'  amaka   osu ','',200000,5,2,'2026-09-01','','','',''],
  [4,'Bad Row','','abc',5,3,'2026-06-01','','','',''],
  [5,'No Date','',100000,5,3,'','','','',''],
  ['','TOTAL','',1100000,'','','','','','',''],
  []
];
const PAYMENTS = [
  ['Date','Customer','Amount Paid','Mode','Teller'],
  ['28/06/2026','Tunde Bakare',115000,'Cash','C1'],
  ['30/07/2026','Tunde Bakare','70,000','transfer',''],
  ['15/09/2026','Amaka Osu',20000,'cash',''],
  ['01/07/2026','Nobody Here',1000,'',''],
  ['','','','','']
];
function start(api, loans, payments){
  api.imp = {step:'map', fileName:'ade.xlsx', sheets:[sheet('Loans', loans||LOANS), ...(payments===null ? [] : [sheet('Payments', payments||PAYMENTS)])], date1904:false, dayFirst:true};
  api.guessSheets();
  return api.imp;
}

test('CSV: quotes, commas and line breaks inside cells, a BOM, and semicolons', ()=>{
  const api = fresh();
  assert.deepEqual(clone(api.parseCSV('﻿Name,Amount\r\n"Osu, Amaka","500,000"\r\n"Said ""hi""\nthen left",3\r\n')),
    [['Name','Amount'],['Osu, Amaka','500,000'],['Said "hi"\nthen left','3']]);
  assert.deepEqual(clone(api.parseCSV('Name;Amount;Rate\nAmaka;500000;5\n')), [['Name','Amount','Rate'],['Amaka','500000','5']]);
});

test('dates: Excel day numbers, both date systems, and the ways people type them', ()=>{
  const api = fresh();
  const d = (v, dayFirst=true, d1904=false) => api.impDate(cell(v), dayFirst, d1904);
  assert.equal(d(45658), '2025-01-01');
  assert.equal(d(45658.75), '2025-01-01', 'a time of day does not move the date');
  assert.equal(d(45658 - 1462, true, true), '2025-01-01', 'Mac 1904 date system');
  assert.equal(d('15/06/2026'), '2026-06-15');
  assert.equal(d('06/15/2026'), '2026-06-15', 'a day over 12 settles the order');
  assert.equal(d('05/06/2026'), '2026-06-05', 'day first by default');
  assert.equal(d('05/06/2026', false), '2026-05-06', 'month first when asked');
  assert.equal(d('15/06/26'), '2026-06-15');
  assert.equal(d('15-Jun-2026'), '2026-06-15');
  assert.equal(d('15 June 2026'), '2026-06-15');
  assert.equal(d('15th June, 2026'), '2026-06-15');
  assert.equal(d('June 15, 2026'), '2026-06-15');
  assert.equal(d('2026-06-15'), '2026-06-15');
  assert.equal(d('15.06.2026'), '2026-06-15');
  assert.equal(d('31/02/2026'), '', 'no such day');
  assert.equal(d('soon'), '');
  assert.equal(d(12), '', 'a small number is not a date');
});

test('amounts, rates, tenors and repayment types as people write them', ()=>{
  const api = fresh();
  assert.equal(api.impAmount(cell('₦500,000')), 500000);
  assert.equal(api.impAmount(cell('N500,000')), 500000);
  assert.equal(api.impAmount(cell('NGN 250,000.00')), 250000);
  assert.equal(api.impAmount(cell('500k')), 500000);
  assert.equal(api.impAmount(cell('1.5m')), 1500000);
  assert.equal(api.impAmount(cell(300000, '₦300,000')), 300000);
  assert.ok(isNaN(api.impAmount(cell('abc'))));
  assert.ok(isNaN(api.impAmount(cell('-500'))));

  assert.equal(api.impRate(cell(0.05, '5%')).rate, 5, 'an Excel % cell holds 0.05');
  assert.equal(api.impRate(cell(0.035, '3.5%')).rate, 3.5);
  assert.equal(api.impRate(cell(1, '100%')).rate, 100);
  assert.equal(api.impRate(cell('5%')).rate, 5);
  assert.equal(api.impRate(cell(5)).rate, 5);
  assert.equal(api.impRate(cell('10% monthly')).rate, 10);
  assert.equal(api.impRate(cell(0)).rate, 0, 'interest-free');
  const frac = api.impRate(cell(0.05));
  assert.equal(frac.rate, 5); assert.match(frac.note, /read as 5%/);

  assert.equal(api.impMonths(cell('3 months')), 3);
  assert.equal(api.impMonths(cell('three months')), 3);
  assert.equal(api.impMonths(cell('1 year')), 12);
  assert.equal(api.impMonths(cell(6)), 6);

});

test('repayment types: spelling slips are matched, anything unclear is left for the person to choose', ()=>{
  const api = fresh();
  const s = api.guessStructure;
  // the template's drop-down choices and the app's own labels
  assert.equal(s('Interest only (capital at end)'), 'interest-only');
  assert.equal(s('Interest monthly, capital at end'), 'interest-only');
  assert.equal(s('Equal monthly instalments'), 'equal');
  assert.equal(s('Reducing balance'), 'reducing');
  // the way people actually type them
  for(const t of ['intrest only', 'INTEREST', 'Int only', 'interst monthly', 'bullet']) assert.equal(s(t), 'interest-only', t);
  for(const t of ['equal', 'Eqaul instalments', 'installment', 'instalmnt', 'Installmental', 'amortized']) assert.equal(s(t), 'equal', t);
  for(const t of ['reducing', 'Reducin balance', 'redusing', 'reduc. bal', 'diminishing', 'declining balance']) assert.equal(s(t), 'reducing', t);
  // too vague to guess: the person decides
  for(const t of ['flat', 'monthly', 'weekly thing', 'normal', 'x']) assert.equal(s(t), '', t);

  // in an import: an unclear type holds its rows back until chosen
  const loans = [['Name','Amount','Rate','Months','Date','Type'],
    ['A B',100000,5,2,'01/06/2026','flat'], ['C D',100000,5,2,'01/06/2026','Flat'], ['E F',100000,5,2,'01/06/2026','reducin'], ['G H',100000,5,2,'01/06/2026','']];
  start(api, loans, null);
  let plan = api.buildImportPlan();
  assert.equal(plan.counts.loans, 2);
  assert.match(plan.loans[0].errors.join(), /repayment type “flat” not recognised/);
  assert.deepEqual(clone([...plan.structValues.entries()].map(([k,v])=>[k, v.count])), [['flat',2], ['reducin',1], ['',1]]);
  assert.equal(plan.loans[2].structure, 'reducing');
  assert.equal(plan.loans[3].structure, 'interest-only', 'blank is the usual arrangement');
  api.imp.structMap = {flat:'equal'};          // chosen once, applies to every row that says it
  api.imp.structDefault = 'reducing';          // and blanks can be set too
  plan = api.buildImportPlan();
  assert.equal(plan.counts.loans, 4);
  assert.deepEqual(clone(plan.loans.map(e=>e.structure)), ['equal', 'equal', 'reducing', 'reducing']);
  api.imp.step = 'preview';
  assert.match(api.pageImport(), /Repayment types[\s\S]*“flat”[\s\S]*2 loans/);
  // a sheet with no type column: one choice covers every loan
  start(api, [['Name','Amount','Rate','Months','Date'], ['A B',100000,5,2,'01/06/2026']], null);
  api.imp.structDefault = 'equal'; api.imp.step = 'preview';
  assert.equal(api.buildImportPlan().loans[0].structure, 'equal');
  assert.match(api.pageImport(), /no repayment type column/);
});

test('columns are matched by heading, in any order, and the headings row is found under a title', ()=>{
  const api = fresh();
  const s = sheet('Loans', LOANS);
  assert.equal(api.findHeaderRow(s), 2);
  const m = api.autoMap(s.text[2], api.IMPORT_FIELDS.loans);
  assert.deepEqual({...m}, {name:1, principal:3, rate:4, months:5, startDate:6, firstPaymentDate:-1, structure:7, paid:8, lastPaid:9, phone:2, purpose:10, ref:-1});
  // "Amount paid" goes to what was paid, so "Amount" is left for the loan
  const m2 = api.autoMap(['Name','Amount Paid','Amount','Rate','Months','Date'], api.IMPORT_FIELDS.loans);
  assert.equal(m2.paid, 1); assert.equal(m2.principal, 2); assert.equal(m2.startDate, 5);
  const pm = api.autoMap(PAYMENTS[0], api.IMPORT_FIELDS.payments);
  assert.deepEqual({...pm}, {name:1, ref:-1, date:0, amount:2, method:3, reference:4, note:-1});
});

test('the check: every row is read, problems are named, nothing is saved yet', ()=>{
  const api = fresh();
  const imp = start(api);
  assert.equal(imp.loans.sheet, 0); assert.equal(imp.payments.sheet, 1);
  const before = clone(api.state);
  const plan = api.buildImportPlan();
  assert.deepEqual(clone(api.state), before, 'checking changes nothing');
  assert.deepEqual({...plan.counts}, {loans:3, borrowers:2, newBorrowers:2, payments:4, skippedDup:0, problems:3});
  const [amaka, tunde, amaka2, bad, nodate] = plan.loans;
  assert.equal(plan.loans.length, 5, 'the TOTAL row and blank rows are not loans');
  assert.equal(amaka.row, 4, 'row numbers match the spreadsheet');
  assert.deepEqual([amaka.principal, amaka.rate, amaka.months, amaka.startDate, amaka.firstPaymentDate, amaka.structure, amaka.paid, amaka.lastPaid],
    [500000, 5, 3, '2026-06-15', '2026-07-15', 'interest-only', 50000, '2026-08-15']);
  assert.deepEqual([tunde.principal, tunde.startDate, tunde.structure], [300000, '2026-05-28', 'reducing']);
  assert.equal(amaka2.name, 'amaka osu');
  assert.match(bad.errors.join(), /amount “abc” is not a number/);
  assert.match(nodate.errors.join(), /no date given/);
  const [p1, p2, p3, nobody] = plan.payments;
  assert.equal(p2.amount, 70000); assert.equal(p2.method, 'Bank Transfer');
  assert.equal(p3.target.imp, 2, 'a payment goes to the loan the borrower had at the time');
  assert.match(p3.warnings.join(), /has 2 loans/);
  assert.match(nobody.errors.join(), /no loan for this borrower/);
  assert.equal(tunde.payments.length, 2);
  imp.step = 'preview';
  assert.ok(api.pageImport().includes('Rows with problems'), 'the check page draws');
});

test('import adds the loans, payments and borrowers, tagged so they can be undone', ()=>{
  const api = fresh();
  start(api);
  const res = api.runImport(api.buildImportPlan(), 'ade.xlsx');
  assert.deepEqual([res.loans, res.payments, res.borrowers], [3, 4, 2]);
  const st = api.state;
  assert.deepEqual(clone(st.borrowers.map(b=>[b.id, b.name, b.phone, b.dateAdded])),
    [['AO-001','Amaka Osu','0803 456 7890','2026-06-15'], ['TB-001','Tunde Bakare','','2026-05-28']]);
  assert.ok(st.borrowers.concat(st.loans, st.payments).every(r=>r.importId===res.id));
  const amakaLoans = st.loans.filter(l=>l.borrowerId==='AO-001');
  assert.equal(amakaLoans.length, 2, 'the same name written differently is the same borrower');
  const lump = st.payments.find(p=>p.reference==='Imported');
  assert.deepEqual(clone([lump.amount, lump.date, lump.loanId]), [50000, '2026-08-15', amakaLoans[0].id]);
  const tunde = api.allLoans().find(l=>l.borrowerId==='TB-001');
  assert.equal(tunde.totalRepayable, 330000);
  assert.equal(tunde.ledger.totalPaid, 185000);
  assert.equal(st.audit[0].action, 'Spreadsheet imported');
  assert.match(st.audit[0].detail, /ade\.xlsx: 3 loans, 4 payments, 2 new borrowers/);
  // the tag survives saving and reading back
  const back = api.normalizeBook(clone(st));
  assert.ok(back.loans.every(l=>l.importId===res.id));
});

test('importing the same file again adds nothing; new payment rows still go in', ()=>{
  const api = fresh();
  start(api);
  api.runImport(api.buildImportPlan(), 'ade.xlsx');
  const counts = clone(api.state).loans.length;
  start(api);
  let plan = api.buildImportPlan();
  assert.equal(plan.counts.loans, 0);
  assert.equal(plan.counts.payments, 0);
  assert.equal(plan.counts.skippedDup, 6, '3 loans and 3 payments already in the book');
  start(api, LOANS, PAYMENTS.concat([['01/10/2026','Tunde Bakare',115000,'Cash','C3']]));
  plan = api.buildImportPlan();
  assert.equal(plan.counts.payments, 1);
  const res = api.runImport(plan, 'ade.xlsx');
  assert.equal(res.loans, 0);
  assert.equal(api.state.loans.length, counts);
  const tunde = api.allLoans().find(l=>l.borrowerId==='TB-001');
  assert.equal(tunde.ledger.totalPaid, 300000);
});

test('an existing borrower is reused, and payments can name the loan by reference', ()=>{
  const api = fresh();
  const b = api.addBorrower({name:'Tunde Bakare', phone:'0812'});
  const loans = [['Name','Amount','Rate','Months','Date given','Loan ref'], ['tunde bakare',100000,5,2,'01/06/2026','T-1'], ['Tunde Bakare',100000,5,2,'01/07/2026','T-2']];
  const pays = [['Loan ref','Date','Amount'], ['T-1','01/07/2026',105000], ['t-2','01/08/2026',5000], ['T-9','01/08/2026',5000]];
  start(api, loans, pays);
  const plan = api.buildImportPlan();
  assert.equal(plan.counts.newBorrowers, 0);
  assert.equal(plan.loans[0].borrowerId, b.id);
  assert.equal(plan.payments[0].target.imp, 0);
  assert.equal(plan.payments[1].target.imp, 1);
  assert.match(plan.payments[2].errors.join(), /no loan with reference “T-9”/);
  api.runImport(plan, 'refs.csv');
  assert.equal(api.state.borrowers.length, 1);
  assert.deepEqual(clone(api.allLoans().map(l=>l.ledger.totalPaid)), [105000, 5000]);
});

test('paid so far is left out when the payments are listed one by one, and noted when undated', ()=>{
  const api = fresh();
  const loans = [['Name','Amount','Rate','Months','Date','Paid so far'], ['A B',100000,5,2,'01/06/2026',50000], ['C D',100000,5,2,'01/06/2026',20000]];
  start(api, loans, [['Name','Date','Amount'], ['A B','01/07/2026',5000]]);
  const plan = api.buildImportPlan();
  assert.ok(plan.loans[0].paidIgnored);
  assert.match(plan.loans[1].warnings.join(), /recorded as received today/);
  assert.equal(plan.counts.payments, 2);
});

test('a rate column holding naira interest is caught, not imported as a huge rate', ()=>{
  const api = fresh();
  start(api, [['Name','Amount','Interest','Months','Date'], ['A B',100000,25000,2,'01/06/2026']], null);
  const plan = api.buildImportPlan();
  assert.equal(plan.counts.loans, 0);
  assert.match(plan.loans[0].errors.join(), /interest amount rather than the rate/);
});

test('undo removes exactly what the import added', ()=>{
  const api = fresh();
  const keep = api.addBorrower({name:'Kept Person'});
  api.addLoan({borrowerId:keep.id, principal:50000, rate:5, structure:'interest-only', months:1, startDate:'2026-06-01', firstPaymentDate:'2026-07-01'});
  start(api);
  const res = api.runImport(api.buildImportPlan(), 'ade.xlsx');
  // after the import: a new loan for an imported borrower, and a payment on an imported loan
  const amakaLoan = api.state.loans.find(l=>l.importId===res.id && l.borrowerId==='AO-001');
  api.addPayment({loanId:amakaLoan.id, borrowerId:'AO-001', date:'2026-09-20', amount:25000});
  const tb = api.state.borrowers.find(b=>b.name==='Tunde Bakare');
  api.addLoan({borrowerId:tb.id, principal:80000, rate:5, structure:'interest-only', months:1, startDate:'2026-09-25', firstPaymentDate:'2026-10-25'});
  const c = api.importContents(res.id);
  assert.equal(c.later, 1, 'the payment made since is counted, so the person is told');
  assert.deepEqual(clone(c.borrowers.map(b=>b.name)), ['Amaka Osu'], 'a borrower with a loan of their own stays');
  api.undoImport(res.id);
  const st = api.state;
  assert.deepEqual(clone(st.borrowers.map(b=>b.name).sort()), ['Kept Person', 'Tunde Bakare']);
  assert.deepEqual(clone(st.loans.map(l=>l.principal).sort()), [50000, 80000]);
  assert.equal(st.payments.length, 0);
  assert.ok(Object.keys(st.tombstones).length >= 3 + 5, 'removals are recorded, so other devices drop them too');
  assert.equal(st.audit[0].action, 'Spreadsheet import undone');
});

test('an import reaches the other device through Drive, and so does its undo', async ()=>{
  const drive = createDrive();
  async function device(){
    const {api} = load({fetch: drive.fetchFor()});
    api.setAuth({username:'Ade', email:'ade@example.com'});
    api.loadLocal();
    api.setToken(drive.issueToken('ade@example.com'), Date.now()+3600e3);
    api.TODAY = '2026-10-01';
    return api;
  }
  const laptop = await device(), phone = await device();
  assert.equal(await laptop.syncNow(), 'ok');
  assert.equal(await phone.syncNow(), 'ok');
  start(laptop);
  const res = laptop.runImport(laptop.buildImportPlan(), 'ade.xlsx');
  assert.equal(await laptop.syncNow(), 'ok');
  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(phone.state.loans.length, 3);
  assert.equal(phone.state.payments.length, 4);
  // re-importing on the phone finds everything already there
  start(phone);
  assert.equal(phone.buildImportPlan().counts.loans, 0);
  phone.undoImport(res.id);
  assert.equal(await phone.syncNow(), 'ok');
  assert.equal(await laptop.syncNow(), 'ok');
  assert.equal(laptop.state.loans.length, 0);
  assert.equal(laptop.state.borrowers.length, 0);
});

test('every step of the import page draws', ()=>{
  const api = fresh();
  api.imp = null;
  assert.match(api.pageImport(), /Choose a spreadsheet file/);
  start(api);
  assert.match(api.pageImport(), /Customer Name/);
  api.imp.step = 'preview';
  const page = api.pageImport();
  assert.match(page, /Import 3 loans and 4 payments/);
  assert.match(page, /Left out: amount “abc” is not a number/);
  api.sync.remoteKnown = false;
  assert.match(api.pageImport(), /still checking your Google Drive book/);
  api.sync.remoteKnown = true;
  const res = api.runImport(api.buildImportPlan(), 'ade.xlsx');
  api.imp = {step:'done', result:res, fileName:'ade.xlsx'};
  assert.match(api.pageImport(), /Undo this import/);
  api.imp = null;
  assert.match(api.pageImport(), /Recent imports[\s\S]*ade\.xlsx: 3 loans/);
});

test("the template's example rows are never imported, even if left in", ()=>{
  const api = fresh();
  start(api, [['Borrower name','Amount given','Monthly rate %','Months','Date given'], ['Chioma Okeke',500000,5,3,'15/06/2026'], ['Real Person',100000,5,2,'01/06/2026']],
    [['Borrower name','Date received','Amount'], ['Ibrahim Musa','28/06/2026',115000]]);
  const plan = api.buildImportPlan();
  assert.equal(plan.counts.loans, 1);
  assert.equal(plan.counts.payments, 0);
  assert.match(plan.loans[0].errors.join(), /example row from the template/);
  assert.match(plan.payments[0].errors.join(), /example row from the template/);
});
