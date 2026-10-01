// In-memory imitation of the slice of the Google Drive v3 + userinfo API the
// app uses. Shared by the Node tests and the browser test server.
function createDrive(){
  const api = {};
  const files = new Map();   // id -> {id,name,mimeType,parents,trashed,modifiedTime,content}
  const tokens = new Map();  // token -> email
  let n = 0, clock = Date.now();
  const fail = {next:0, status:500, offline:0};
  const log = [];
  function now(){ clock += 1000; return new Date(clock).toISOString(); }
  function issueToken(email){ const t = 'tok-'+(++n)+'-'+Math.random().toString(36).slice(2,8); tokens.set(t, email); return t; }
  function expireAll(){ tokens.clear(); }
  function matches(f, q){
    if(/trashed=false/.test(q) && f.trashed) return false;
    let m = /name='([^']+)'/.exec(q); if(m && f.name!==m[1]) return false;
    m = /mimeType='([^']+)'/.exec(q); if(m && f.mimeType!==m[1]) return false;
    m = /'([^']+)' in parents/.exec(q); if(m && !(f.parents||[]).includes(m[1])) return false;
    return true;
  }
  function pub(f, fields){ const o = {id:f.id,name:f.name,modifiedTime:f.modifiedTime,mimeType:f.mimeType,trashed:!!f.trashed}; return o; }
  function handle(method, url, headers, body){
    const u = new URL(url, 'http://x');
    let p = u.pathname.replace(/^\/gapi/,'');
    log.push(method+' '+p+(u.search?'?'+[...u.searchParams.keys()].join(','):''));
    if(fail.offline > 0){ fail.offline--; return {network:true}; }
    if(fail.next > 0){ fail.next--; return {status:fail.status, body:JSON.stringify({error:{message:'injected failure'}})}; }
    const auth = (headers.authorization||headers.Authorization||'').replace(/^Bearer /,'');
    const email = tokens.get(auth);
    if(!email) return {status:401, body:JSON.stringify({error:{message:'Invalid Credentials'}})};
    const mine = f => f.owner===email;
    if(p==='/oauth2/v3/userinfo') return {status:200, body:JSON.stringify({email, name: email.split('@')[0].replace(/\./g,' ').replace(/\b\w/g,c=>c.toUpperCase())})};
    if(p==='/drive/v3/files' && method==='GET'){
      const q = u.searchParams.get('q')||'';
      let list = [...files.values()].filter(f=>mine(f) && matches(f,q));
      const ob = u.searchParams.get('orderBy')||'';
      if(/modifiedTime desc/.test(ob)) list.sort((a,b)=>b.modifiedTime.localeCompare(a.modifiedTime));
      if(/name desc/.test(ob)) list.sort((a,b)=>b.name.localeCompare(a.name));
      return {status:200, body:JSON.stringify({files:list.map(f=>pub(f))})};
    }
    if(p==='/drive/v3/files' && method==='POST'){
      const meta = JSON.parse(body); const id = 'f'+(++n);
      files.set(id, {id, owner:email, name:meta.name, mimeType:meta.mimeType, parents:meta.parents||[], trashed:false, modifiedTime:now(), content:''});
      return {status:200, body:JSON.stringify({id})};
    }
    let m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if(m){
      const f = files.get(decodeURIComponent(m[1]));
      if(!f || !mine(f)) return {status:404, body:JSON.stringify({error:{message:'File not found'}})};
      if(method==='GET' && u.searchParams.get('alt')==='media') return {status:200, body:f.content};
      if(method==='GET') return {status:200, body:JSON.stringify(pub(f))};
      if(method==='PATCH'){ const meta = JSON.parse(body); Object.assign(f, meta); f.modifiedTime = now(); return {status:200, body:JSON.stringify(pub(f))}; }
    }
    if(p==='/upload/drive/v3/files' && method==='POST'){
      const ct = headers['content-type']||headers['Content-Type'];
      const boundary = /boundary=(.+)$/.exec(ct)[1];
      const parts = body.split('--'+boundary).slice(1,-1).map(s=>s.replace(/^\r\n/,'').replace(/\r\n$/,''));
      const content = s => s.slice(s.indexOf('\r\n\r\n')+4);
      const meta = JSON.parse(content(parts[0]));
      const id = 'f'+(++n);
      files.set(id, {id, owner:email, name:meta.name, mimeType:meta.mimeType, parents:meta.parents||[], trashed:false, modifiedTime:now(), content:content(parts[1])});
      return {status:200, body:JSON.stringify({id})};
    }
    m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if(m && method==='PATCH'){
      const f = files.get(decodeURIComponent(m[1]));
      if(!f || !mine(f)) return {status:404, body:JSON.stringify({error:{message:'File not found'}})};
      f.content = body; f.modifiedTime = now();
      if(api.onUpload) api.onUpload();
      return {status:200, body:JSON.stringify(pub(f))};
    }
    return {status:400, body:JSON.stringify({error:{message:'Unhandled '+method+' '+p}})};
  }
  // fetch() for Node tests
  function fetchFor(){
    return async (url, opts)=>{
      opts = opts||{};
      const r = handle(opts.method||'GET', url, opts.headers||{}, opts.body);
      if(r.network) throw new TypeError('Failed to fetch');
      return {ok:r.status>=200&&r.status<300, status:r.status, text:async()=>r.body, json:async()=>JSON.parse(r.body)};
    };
  }
  return Object.assign(api, {files, tokens, issueToken, expireAll, handle, fetchFor, fail, log,
    book(email){ const f=[...files.values()].find(x=>x.owner===email && x.name==='loanbook.json' && !x.trashed); return f ? JSON.parse(f.content) : null; }});
}
module.exports = {createDrive};
