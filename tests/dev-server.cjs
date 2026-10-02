// Local test server: serves the real index.html with Google's sign-in script
// and the Drive API swapped for local fakes, so the whole app — sign-in,
// sync, two devices — can be exercised in a browser without a Google account.
// localhost:PORT and 127.0.0.1:PORT keep separate browser storage, so they act
// as two devices sharing one fake Drive.  Start with:  node tests/dev-server.cjs
const http = require('http'), fs = require('fs'), path = require('path');
const {createDrive} = require('./fake-drive.cjs');
const PORT = Number(process.env.PORT || 8765);
const ROOT = path.join(__dirname, '..');
const INDEX = process.env.INDEX || path.join(ROOT, 'index.html');
const TYPES = {'.html':'text/html; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json', '.js':'application/javascript; charset=utf-8'};
const drive = createDrive();
let lastReminder = null;   // what the app last sent the (stand-in) reminder service

const FAKE_GIS = `
window.google = {accounts:{oauth2:{
  initTokenClient(cfg){
    return { requestAccessToken(o){
      const mode = localStorage.getItem('fakeGis.mode') || 'ok';
      const email = (o && o.login_hint) || localStorage.getItem('fakeGis.email') || 'ade.martins@example.com';
      setTimeout(async ()=>{
        if(mode==='popup_blocked') return cfg.error_callback({type:'popup_failed_to_open'});
        if(mode==='closed') return cfg.error_callback({type:'popup_closed'});
        const tok = await (await fetch('/__token?email='+encodeURIComponent(email))).text();
        const scope = mode==='noscope' ? 'openid email profile' : 'openid email profile https://www.googleapis.com/auth/drive.file';
        cfg.callback({access_token:tok, expires_in:Number(localStorage.getItem('fakeGis.expires')||3600), scope, token_type:'Bearer'});
      }, 120);
    }};
  },
  hasGrantedAllScopes(resp, ...s){ const g = String(resp.scope||'').split(' '); return s.every(x=>g.includes(x)); },
  revoke(t, cb){ cb && cb(); }
}}};`;

function page(){
  let html = fs.readFileSync(INDEX, 'utf8');
  html = html.replace(/<script src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/,
    `<script src="/fake-gis.js" async onload="__gisLoaded()" onerror="__gisFailed()"></script>`);
  html = html.replace("const GAPI = 'https://www.googleapis.com';", "const GAPI = location.origin + '/gapi';");
  html = html.replace(/const REMINDER_SERVICE_URL = '[^']*';/, "const REMINDER_SERVICE_URL = location.origin + '/__reminders';");   // never the real service
  return html;
}

http.createServer((req, res)=>{
  let body = '';
  req.on('data', c=>body += c);
  req.on('end', ()=>{
    const u = new URL(req.url, 'http://x');
    const send = (status, text, type)=>{ res.writeHead(status, {'Content-Type':type||'text/plain', 'Cache-Control':'no-store'}); res.end(text); };
    if(u.pathname==='/' || u.pathname==='/index.html') return send(200, page(), 'text/html; charset=utf-8');
    if(u.pathname==='/fake-gis.js') return send(200, FAKE_GIS, 'application/javascript');
    if(u.pathname==='/__token') return send(200, drive.issueToken(u.searchParams.get('email')));
    if(u.pathname==='/__ctl/expire'){ drive.expireAll(); return send(200,'ok'); }
    if(u.pathname==='/__ctl/fail'){ drive.fail.next = Number(u.searchParams.get('n')||1); drive.fail.status = Number(u.searchParams.get('status')||500); return send(200,'ok'); }
    if(u.pathname==='/__ctl/offline'){ drive.fail.offline = Number(u.searchParams.get('n')||1); return send(200,'ok'); }
    if(u.pathname==='/__ctl/files') return send(200, JSON.stringify([...drive.files.values()].map(f=>({id:f.id,name:f.name,owner:f.owner,trashed:f.trashed,parents:f.parents,bytes:(f.content||'').length,modified:f.modifiedTime})), null, 1), 'application/json');
    if(u.pathname==='/__ctl/book') return send(200, JSON.stringify(drive.book(u.searchParams.get('email')||'ade.martins@example.com')), 'application/json');
    if(u.pathname==='/__reminders' && req.method==='POST'){ try{ lastReminder = JSON.parse(body); }catch(e){ return send(200, JSON.stringify({ok:false, error:'bad-request'}), 'application/json'); } return send(200, JSON.stringify({ok:true, enabled:!!(lastReminder.settings&&lastReminder.settings.enabled)}), 'application/json'); }
    if(u.pathname==='/__ctl/reminders') return send(200, JSON.stringify(lastReminder), 'application/json');
    if(u.pathname==='/__ctl/log') return send(200, drive.log.slice(-60).join('\n'));
    if(u.pathname.startsWith('/gapi/')){
      const r = drive.handle(req.method, req.url, req.headers, body);
      if(r.network){ req.socket.destroy(); return; }
      return send(r.status, r.body, 'application/json');
    }
    // Other site files (privacy page, icons, manifest) as GitHub Pages would serve them
    const file = path.join(ROOT, decodeURIComponent(u.pathname));
    if(file.startsWith(ROOT + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && !file.includes(path.sep + 'tests' + path.sep)){
      res.writeHead(200, {'Content-Type':TYPES[path.extname(file)], 'Cache-Control':'no-store'});
      return res.end(fs.readFileSync(file));
    }
    send(404, 'not found');
  });
}).listen(PORT, ()=>console.log('LoanBook test server on http://localhost:'+PORT));
