// Loads the app's main <script> into a Node VM with a minimal DOM stub and
// exposes its internals, so the ledger and sync logic can be tested without a
// browser. Run the suite from the project folder with:  node --test
const fs = require('fs'), vm = require('vm'), path = require('path');
const INDEX = process.env.INDEX || path.join(__dirname, '..', 'index.html');
function el(){
  const e = new Proxy(function(){}, {
    get(t,k){
      if(k==='classList') return {add(){},remove(){},toggle(){},contains(){return false;}};
      if(k==='style') return {};
      if(k==='dataset') return {};
      if(k===Symbol.toPrimitive) return ()=> '';
      if(k in t) return t[k];
      if(k==='innerHTML'||k==='value'||k==='textContent') return t['_'+k]||'';
      if(k==='querySelector') return ()=>null;
      if(k==='querySelectorAll') return ()=>[];
      if(k==='contains') return ()=>false;
      return el();
    },
    set(t,k,v){ t['_'+k]=v; return true; },
    apply(){ return el(); }
  });
  return e;
}
function load(opts){
  opts = opts||{};
  const html = fs.readFileSync(INDEX,'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  let main = scripts.find(s=>s.includes('function buildPeriods'));
  // Tests never talk to the real reminder service: it is off unless a test supplies its own.
  main = main.replace(/const REMINDER_SERVICE_URL = '[^']*';/, `const REMINDER_SERVICE_URL = ${JSON.stringify(opts.reminderUrl || '')};`);
  const store = new Map();
  const localStorage = {getItem:k=>store.has(k)?store.get(k):null, setItem:(k,v)=>store.set(k,String(v)), removeItem:k=>store.delete(k)};
  const elements = {};
  const document = {
    getElementById:id=>(elements[id] = elements[id] || el()),
    addEventListener(){}, querySelector:()=>null, querySelectorAll:()=>[], createElement:()=>el(),
    documentElement:el(), body:el(), visibilityState:'visible', activeElement:null
  };
  const ctx = {
    console, setTimeout:(f,ms)=>{ if(String(f).includes('[native code]')) return setTimeout(f,0); return 0; }, clearTimeout(){}, setInterval:()=>0, clearInterval(){},
    localStorage, document, location:{hash:'',pathname:'/',search:'',reload(){}},
    history:{replaceState(){}}, navigator:{onLine:true}, crypto:require('crypto').webcrypto,
    URLSearchParams, Blob:function(){}, URL:{createObjectURL(){return ''},revokeObjectURL(){}},
    getComputedStyle:()=>({getPropertyValue:()=>''}), matchMedia:()=>({matches:false}),
    fetch: opts.fetch || (async()=>{throw new Error('no fetch');}),
    Date: opts.Date || Date, Math, JSON, Promise, Map, Set, WeakMap, Number, String, Object, Array, RegExp, Error, isFinite, isNaN, parseInt, parseFloat, Intl, Symbol,
  };
  ctx.window = ctx; ctx.addEventListener = ()=>{}; ctx.scrollTo=()=>{};
  vm.createContext(ctx);
  vm.runInContext(main + `
;globalThis.__api = {
  buildPeriods, loanTerms, computeLedger, mergeBooks, normalizeBook, canonical, extractBook, wrapBook, freshState,
  parseAmount, parseRate, fmtNaira, addMonths, metrics, allLoans, isISODate, jsArg, esc, makeBorrowerIdIn,
  addBorrower, updateBorrower, deleteBorrower, addLoan, updateLoan, deleteLoan, addPayment, updatePayment, deletePayment, addNote, deleteNote,
  loadSampleData, getLoan, getBorrower, getPayment, getLoanPayments, bumpRev, csvCell, stableStringify,
  get state(){ return state; }, set state(v){ state = v; bumpRev(); },
  get TODAY(){ return TODAY; }, set TODAY(v){ TODAY = v; bumpRev(); },
  setAuth(a){ auth = a; },
  get meta(){ return meta; },
  syncNow, get sync(){ return sync; }, loadLocal, persistLocal, pushReminders, reminderPayload,
  setToken(t, exp){ accessToken = t; tokenExpiry = exp; },
};`, ctx, {filename:'index.html.js'});
  return {api: ctx.__api, ctx, store};
}
module.exports = {load};
