/* ============================================================
   CLIENT-SIDE APP LOGIC  (Google Apps Script frontend)
   ============================================================ */

const $ = id => document.getElementById(id);
const LS_KEY = 'cg_asistencia_session_v1';
let currentUser = null;

// --- Constantes para diagnóstico (fallback si GS falla y no llega info desde Code.gs) ---
const SPREADSHEET_ID_FALLBACK = '1zOttNV1TFjdqJU3hrOCYAda6nCSzExuQ6EOZfz7x6hk';
const SHEET_USUARIOS_FALLBACK = 'Usuarios';
let scanning = { stream:null, running:false, raf:null, videoEl:null, canvasEl:null, ctx:null, lastToken:null, lastTokenAt:0 };

// ---------- TRANSPORTE UNIFICADO: 3 MODOS AUTODETECTADOS ----------
// MODO 1 🥇:  window.APP_CONFIG.SEATABLE definido → Frontend habla DIRECTO con SeaTable Cloud (SIN Apps Script)
// MODO 2 🥈:  window.APP_CONFIG.APPS_SCRIPT_URL válido → Fetch doPost JSON a Apps Script
// MODO 3 🥉:  Nada definido → App híbrida dentro de Apps Script, google.script.run
const GS = {
  run(name, ...args){
    const cfg = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : {};

    // ============== 🥇 MODO 1: SEATABLE DIRECTO (nuevo) ==============
    if (cfg && cfg.SEATABLE && String(cfg.SEATABLE.APP_TOKEN || '').length > 10 && String(cfg.SEATABLE.BASE_UUID || '').length > 10) {
      return new Promise((resolve, reject)=>{
        dispatchSeatableAction(name, args)
          .then(data=> resolve(data))
          .catch(err=>{
            let msg = String((err && err.message) ? err.message : err);
            if (/fetch|network|cors|blocked/i.test(msg)) msg = '🚨 NO HAY CONEXIÓN CON SEATABLE. Verifica token, UUID o conexión a internet.\n' + msg;
            reject(new Error(msg));
          });
      });
    }

    // ============== 🥈 MODO 2: APPS SCRIPT URL (anteriores) ==============
    const urlRaw = String(cfg.APPS_SCRIPT_URL || '').trim();
    const urlLow = urlRaw.toLowerCase();
    const urlOk  = (urlRaw.length > 20) && (!urlLow.includes('aqui pega')) && (!urlLow.includes('tu_url')) && (!urlLow.includes('replace')) && (!urlLow.includes('xxxx'));

    if (urlOk) {
      return new Promise((resolve, reject)=>{
        const payload = JSON.stringify({ action: name, args: args });
        const doFetch = async (attempt) => {
          try {
            const resp = await fetch(urlRaw, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: payload,
              mode: 'cors'
            });
            if (!resp.ok) {
              if (resp.status === 401 || resp.status === 403) {
                throw new Error('HTTP '+resp.status+': No tienes permiso. EN GOOGLE APPS SCRIPT → Desplegar → Gestionar → Acceso → elige "Cualquier persona (Anyone)" y Actualiza implementación. Luego pega la URL NUEVA en CONFIG.js.');
              }
              if (resp.status >= 500) {
                throw new Error('HTTP '+resp.status+': Apps Script se cayó. Abre el URL /exec en pestaña nueva, autoriza permisos si te pide, y vuelve. También revisa Registros de ejecución en Apps Script.');
              }
              throw new Error('Apps Script HTTP '+resp.status+'. Asegúrate de haber desplegado el Code.gs como "Acceso: Cualquier persona" (Anyone).');
            }
            const json = await resp.json();
            if (!json.ok) { throw new Error(json.error || ('Error en '+name)); }
            resolve(json.data);
          } catch(err){
            const errStr = String(err && err.message ? err.message : err);
            const esCors = (errStr.includes('Failed to fetch') || errStr.includes('NetworkError') || errStr.includes('CORS') || errStr.includes('Blocked by CORS'));
            const urlNoBien = !/script\.google\.com.*\/exec$/i.test(urlRaw.trim());
            if (attempt < 1 && (esCors || errStr.includes('HTTP') || errStr.includes('Failed to fetch'))) {
              setTimeout(()=> doFetch(attempt+1), 1500);
              return;
            }
            let msg = err.message || errStr;
            if (esCors || urlNoBien) {
              msg =  '🚨 NO HAY CONEXIÓN CON GOOGLE APPS SCRIPT. Haz el DIAGNÓSTICO (botón abajo del login).';
              if (urlNoBien) msg += ' 👉 CONFIG.js tiene una URL INVÁLIDA: debe terminar en script.google.com/.../exec';
              else msg += ' 👉 Causa más probable: el despliegue NO tiene "Acceso = Cualquier persona (Anyone)".';
              msg += '\n\n📝 Pasos: (1) Apps Script → Desplegar → Gestionar implementaciones → Editar ✏️ → Acceso: Cualquier persona (Anyone) → ACTUALIZA DESPLIEGUE. (2) Copia la URL NUEVA. (3) Abre CONFIG.js en GitHub y pégala. (4) Espera 1 minuto y vuelve a refrescar.';
            }
            reject(new Error(msg));
          }
        };
        doFetch(0);
      });
    }

    // ============== 🥉 MODO 3: FALLBACK google.script.run (híbrido Apps Script) ==============
    return new Promise((res, rej)=>{
      google.script.run
        .withSuccessHandler(res)
        .withFailureHandler(err=>rej(new Error(err.message||err)))
        [name](...args);
    });
  }
};

// ---------- UI HELPERS ----------
const loading = (show, text) => {
  $('loading').classList.toggle('hidden', !show);
  if (text) $('loadingText').textContent = text;
};
const toast = (msg, type='info', ttl=4200) => {
  const host = $('toastHost');
  const d = document.createElement('div');
  d.className = 'toast ' + type;
  d.textContent = msg;
  host.appendChild(d);
  setTimeout(()=>{d.style.opacity='0';d.style.transform='translateY(-8px)';d.style.transition='all .3s';setTimeout(()=>d.remove(),300)}, ttl);
};
const pad = n => String(n).padStart(2,'0');
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iniciales = n => { const p = String(n||'').trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0]||'')+(p[1]?.[0]||p[0]?.[1]||'')).toUpperCase(); };
const fmtFecha = f => { if(!f)return ''; const p=f.split('-'); if(p.length!==3)return f; return p[2]+'/'+p[1]+'/'+p[0]; };
const fmtHora = h => { if(!h)return ''; const m = String(h).match(/(\d{1,2}):(\d{1,2})/); return m?pad(m[1])+':'+pad(m[2]):String(h); };
const aniNum = (el, target) => { const from = parseInt(el.textContent.replace(/[^\d]/g,''),10)||0; const dur=420, steps=14; const inc=(target-from)/steps; let step=0; const id=setInterval(()=>{ step++; el.textContent=Math.round(from+inc*step); if(step>=steps){clearInterval(id);el.textContent=target;}}, dur/steps); };

// ---------- CLOCK ----------
function updateClock(){
  const now = new Date();
  $('clock-time').textContent = pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
  const dias=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const mes=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  $('clock-date').textContent = dias[now.getDay()]+', '+pad(now.getDate())+' '+mes[now.getMonth()]+' '+now.getFullYear();
}
setInterval(updateClock,1000); updateClock();

// ============================================================
//  🧰 SEATABLE DIRECT MODE: MD5 + AUTH + CRUD + 14 ACCIONES
// ============================================================
(function(){
  // -------- md5 inline (puro JS, sin dependencias) --------
  var md5 = (function(){
    function safeAdd(x,y){ var lsw=(x&0xFFFF)+(y&0xFFFF); var msw=(x>>16)+(y>>16)+(lsw>>16); return (msw<<16)|(lsw&0xFFFF); }
    function rol(n,c){ return (n<<c)|(n>>>(32-c)); }
    function cmn(q,a,b,x,s,t){ return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b); }
    function ff(a,b,c,d,x,s,t){ return cmn((b&c)|((~b)&d),a,b,x,s,t); }
    function gg(a,b,c,d,x,s,t){ return cmn((b&d)|(c&(~d)),a,b,x,s,t); }
    function hh(a,b,c,d,x,s,t){ return cmn(b^c^d,a,b,x,s,t); }
    function ii(a,b,c,d,x,s,t){ return cmn(c^(b|(~d)),a,b,x,s,t); }
    function coreM(x,len){
      x[len>>5] |= 0x80<<(len%32);
      x[(((len+64)>>>9)<<4)+14] = len;
      var a= 1732584193,b=-271733879,c=-1732584194,d= 271733878;
      for(var i=0;i<x.length;i+=16){
        var oa=a,ob=b,oc=c,od=d;
        a=ff(a,b,c,d,x[i+ 0], 7,-680876936); d=ff(d,a,b,c,x[i+ 1],12,-389564586);
        c=ff(c,d,a,b,x[i+ 2],17, 606105819);  b=ff(b,c,d,a,x[i+ 3],22,-1044525330);
        a=ff(a,b,c,d,x[i+ 4], 7,-176418897);  d=ff(d,a,b,c,x[i+ 5],12, 1200080426);
        c=ff(c,d,a,b,x[i+ 6],17,-1473231341); b=ff(b,c,d,a,x[i+ 7],22,-45705983);
        a=ff(a,b,c,d,x[i+ 8], 7, 1770035416); d=ff(d,a,b,c,x[i+ 9],12,-1958414417);
        c=ff(c,d,a,b,x[i+10],17,-42063);      b=ff(b,c,d,a,x[i+11],22,-1990404162);
        a=ff(a,b,c,d,x[i+12], 7, 1804603682); d=ff(d,a,b,c,x[i+13],12,-40341101);
        c=ff(c,d,a,b,x[i+14],17,-1502002290); b=ff(b,c,d,a,x[i+15],22, 1236535329);
        a=gg(a,b,c,d,x[i+ 1], 5,-165796510);  d=gg(d,a,b,c,x[i+ 6], 9,-1069501632);
        c=gg(c,d,a,b,x[i+11],14, 643717713);  b=gg(b,c,d,a,x[i+ 0],20,-373897302);
        a=gg(a,b,c,d,x[i+ 5], 5,-701558691);  d=gg(d,a,b,c,x[i+10], 9, 38016083);
        c=gg(c,d,a,b,x[i+15],14,-660478335);  b=gg(b,c,d,a,x[i+ 4],20,-405537848);
        a=gg(a,b,c,d,x[i+ 9], 5, 568446438);  d=gg(d,a,b,c,x[i+14], 9,-1019803690);
        c=gg(c,d,a,b,x[i+ 3],14,-187363961);  b=gg(b,c,d,a,x[i+ 8],20, 1163531501);
        a=gg(a,b,c,d,x[i+13], 5,-1444681467); d=gg(d,a,b,c,x[i+ 2], 9,-51403784);
        c=gg(c,d,a,b,x[i+ 7],14, 1735328473); b=gg(b,c,d,a,x[i+12],20,-1926607734);
        a=hh(a,b,c,d,x[i+ 5], 4,-378558);      d=hh(d,a,b,c,x[i+ 8],11,-2022574463);
        c=hh(c,d,a,b,x[i+11],16, 1839030562); b=hh(b,c,d,a,x[i+14],23,-35309556);
        a=hh(a,b,c,d,x[i+ 1], 4,-1530992060); d=hh(d,a,b,c,x[i+ 4],11, 1272893353);
        c=hh(c,d,a,b,x[i+ 7],16,-155497632);  b=hh(b,c,d,a,x[i+10],23,-1094730640);
        a=hh(a,b,c,d,x[i+13], 4, 681279174);  d=hh(d,a,b,c,x[i+ 0],11,-358537222);
        c=hh(c,d,a,b,x[i+ 3],16,-722521979);  b=hh(b,c,d,a,x[i+ 6],23, 76029189);
        a=hh(a,b,c,d,x[i+ 9], 4,-640364487);  d=hh(d,a,b,c,x[i+12],11,-421815835);
        c=hh(c,d,a,b,x[i+15],16, 530742520);  b=hh(b,c,d,a,x[i+ 2],23,-995338651);
        a=ii(a,b,c,d,x[i+ 0], 6,-198630844);  d=ii(d,a,b,c,x[i+ 7],10, 1126891415);
        c=ii(c,d,a,b,x[i+14],15,-1416354905); b=ii(b,c,d,a,x[i+ 5],21,-57434055);
        a=ii(a,b,c,d,x[i+12], 6, 1700485571); d=ii(d,a,b,c,x[i+ 3],10,-1894986606);
        c=ii(c,d,a,b,x[i+10],15,-1051523);    b=ii(b,c,d,a,x[i+ 1],21,-2054922799);
        a=ii(a,b,c,d,x[i+ 8], 6, 1873313359); d=ii(d,a,b,c,x[i+15],10,-30611744);
        c=ii(c,d,a,b,x[i+ 6],15,-1560198380); b=ii(b,c,d,a,x[i+13],21, 1309151649);
        a=ii(a,b,c,d,x[i+ 4], 6,-145523070);  d=ii(d,a,b,c,x[i+11],10,-1120210379);
        c=ii(c,d,a,b,x[i+ 2],15, 718787259);  b=ii(b,c,d,a,x[i+ 9],21,-343485551);
        a=safeAdd(a,oa); b=safeAdd(b,ob); c=safeAdd(c,oc); d=safeAdd(d,od);
      }
      return [a,b,c,d];
    }
    function str2blks(s){
      var nblk=((s.length+8)>>6)+1; var blks=new Array(nblk*16); for(var i=0;i<nblk*16;i++) blks[i]=0;
      for(i=0;i<s.length;i++) blks[i>>2] |= (s.charCodeAt(i)&255)<<((i%4)*8);
      blks[i>>2] |= 0x80<<((i%4)*8); blks[nblk*16-2]=s.length*8; return blks;
    }
    function toHexArr(a){ var hx='0123456789abcdef', s=''; for(var i=0;i<a.length*4;i++){ s += hx.charAt((a[i>>2]>>((i%4)*8+4))&15) + hx.charAt((a[i>>2]>>((i%4)*8))&15); } return s; }
    return function(str){ return toHexArr(coreM(str2blks(str), str.length*8)); };
  })();
  window.__md5 = md5;
})();

// -------- genToken: MISMA FÓRMULA DETERMINISTA QUE EN Code.gs --------
function genToken(cedula){
  return 'CG' + window.__md5('CG-ASIS-' + String(cedula||'').trim() + '-2026').slice(0,20);
}

// -------- SeaTable AUTH & REQUEST helpers --------
function seatableClearAuth(){ try{ localStorage.removeItem('cg_st_bearer'); localStorage.removeItem('cg_st_bearer_exp'); }catch(e){} }
function seatableGetBearerCached(){
  try {
    var token = localStorage.getItem('cg_st_bearer');
    var exp   = parseInt(localStorage.getItem('cg_st_bearer_exp')||'0', 10);
    if (token && exp && (Date.now() < exp - 5 * 60 * 1000)) return token;
  } catch(e){}
  return null;
}
async function seatableAuth(){
  var cached = seatableGetBearerCached(); if (cached) return cached;
  var cfg = window.APP_CONFIG.SEATABLE;
  var url = cfg.SERVER_URL.replace(/\/$/,'') + '/api/v2.1/dtable/app-access-token/';
  var resp = await fetch(url, {
    method: 'POST', mode: 'cors',
    headers: { 'Content-Type':'application/json','Accept':'application/json' },
    body: JSON.stringify({ access_token: cfg.APP_TOKEN })
  });
  if (!resp.ok) { seatableClearAuth(); throw new Error('SeaTable Auth HTTP '+resp.status+' (token inválido o APP sin permiso Lectura/Escritura).'); }
  var j = await resp.json();
  if (!j || !j.access_token) { seatableClearAuth(); throw new Error('SeaTable Auth: no devolvió access_token. Comprueba APP_TOKEN y permisos.'); }
  try {
    localStorage.setItem('cg_st_bearer', j.access_token);
    localStorage.setItem('cg_st_bearer_exp', String(Date.now() + 2 * 60 * 60 * 1000));
  } catch(e){}
  return j.access_token;
}
async function seatableRequest(method, path, body, retryOn401){
  var cfg = window.APP_CONFIG.SEATABLE;
  var bearer = await seatableAuth();
  var base = cfg.SERVER_URL.replace(/\/$/,'') + '/api/v2.1/dtables/' + cfg.BASE_UUID;
  var url = base + path;
  var opts = {
    method: method, mode: 'cors',
    headers: {
      'Authorization': 'Bearer ' + bearer,
      'Accept': 'application/json'
    }
  };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var resp = await fetch(url, opts);
  if (resp.status === 401 && !retryOn401) { seatableClearAuth(); return seatableRequest(method, path, body, true); }
  if (!resp.ok) {
    var txt = await resp.text().catch(()=>'');
    throw new Error('SeaTable HTTP '+resp.status+' al '+method+' '+path+' → '+txt);
  }
  if (resp.status === 204) return null;
  return resp.json().catch(()=>null);
}
async function seatableListAllRows(tableName){
  var all = []; var cursor = null;
  do {
    var path = '/rows/?table_name=' + encodeURIComponent(tableName) + '&limit=1000';
    if (cursor) path += '&cursor=' + encodeURIComponent(String(cursor));
    var data = await seatableRequest('GET', path, null);
    if (!data || !Array.isArray(data.rows)) break;
    all = all.concat(data.rows);
    cursor = data.cursor || null;
  } while (cursor);
  return all;
}
function seatableAddRow(tableName, fields){
  return seatableRequest('POST', '/rows/?table_name=' + encodeURIComponent(tableName), { row: fields });
}
function seatableUpdateRow(tableName, rowId, fields){
  return seatableRequest('PUT', '/rows/'+encodeURIComponent(rowId)+'/?table_name=' + encodeURIComponent(tableName), { row: fields });
}
function seatableDeleteRow(tableName, rowId){
  return seatableRequest('DELETE', '/rows/'+encodeURIComponent(rowId)+'/?table_name=' + encodeURIComponent(tableName), null);
}

// -------- Row → Business object Mappers (quita _id, _ctime, etc., a formato usado por el frontend: Sheets-like) --------
function mapUsuarioRow(r){
  return {
    id:             String(r._id),
    cedula:         String(r.Cedula || '').trim(),
    nombreCompleto: String(r.NombreCompleto || '').trim(),
    cargoArea:      String(r.CargoArea || '').trim(),
    rol:            String((r.Rol && (r.Rol.name || r.Rol)) || r.Rol || 'TRABAJADOR').toUpperCase(),
    pin:            String(r.PIN || '').trim(),
    tokenQR:        String(r.TokenQR || '').trim(),
    fechaRegistro:  (r.FechaRegistro ? String(r.FechaRegistro).slice(0,16) : '')
  };
}
function mapAsistenciaRow(r){
  var medio = (r.MedioRegistro && (r.MedioRegistro.name || r.MedioRegistro)) || r.MedioRegistro || 'QR';
  return {
    id:            String(r._id),
    idRegistro:    String(r.ID_Registro || r._id),
    cedula:        String(r.Cedula || '').trim(),
    nombre:        String(r.Nombre || '').trim(),
    cargo:         String(r.Cargo || '').trim(),
    fecha:         (r.Fecha ? String(r.Fecha).slice(0,10) : ''),
    horaEntrada:   String(r.HoraEntrada || '').trim(),
    horaSalida:    String(r.HoraSalida || '').trim(),
    medioRegistro: String(medio).toUpperCase(),
    observaciones: String(r.Observaciones || '').trim()
  };
}

// -------- HELPERS PARA LAS ACCIONES --------
function hoyIsoLocal(){
  var n = new Date(); return n.getFullYear()+'-'+pad(n.getMonth()+1)+'-'+pad(n.getDate());
}
function ahoraIsoLocal(){
  var n = new Date(); return n.getFullYear()+'-'+pad(n.getMonth()+1)+'-'+pad(n.getDate())+' '+pad(n.getHours())+':'+pad(n.getMinutes())+':'+pad(n.getSeconds());
}
function ahoraHoraStr(){
  var n = new Date(); return pad(n.getHours())+':'+pad(n.getMinutes())+':'+pad(n.getSeconds());
}
function requireAdmin(listaUsuarios, adminCedula){
  var u = listaUsuarios.find(x=> String(x.cedula) === String(adminCedula).trim());
  if (!u) throw new Error('Token de admin inválido o sesión expirada. Cierra sesión y vuelve a entrar.');
  if (u.rol !== 'ADMIN') throw new Error('Acceso denegado: requiere rol ADMIN.');
  return u;
}
function uid(){ return 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2,8).toUpperCase(); }

// ============================================================
//  DISPATCH SEATABLE (14 acciones, mismo contrato que Apps Script:
//  cada una retorna Promise<data> o lanza Error(msg) => GS.run lo convierte a reject(msg)
// ============================================================
async function dispatchSeatableAction(name, args){
  var cfg = window.APP_CONFIG.SEATABLE;
  var T_USU = cfg.TABLA_USUARIOS || 'Usuarios';
  var T_ASI = cfg.TABLA_ASISTENCIA || 'Asistencia';

  // ============= 1. login(cedula, pin) =============
  if (name === 'login') {
    var ced = String(args[0]||'').trim(), pin = String(args[1]||'').trim();
    if (!ced || !pin) throw new Error('Cédula y PIN son obligatorios.');
    var rows = await seatableListAllRows(T_USU);
    var users = rows.map(mapUsuarioRow);
    var u = users.find(x=> x.cedula === ced);
    if (!u) throw new Error('Usuario no registrado. Pide al administrador que te cree la cuenta o pulsa "Regístrame".');
    if (u.pin !== pin) throw new Error('PIN incorrecto. Intenta de nuevo.');
    if (!u.tokenQR) {
      var nuevoToken = genToken(u.cedula);
      await seatableUpdateRow(T_USU, u.id, { TokenQR: nuevoToken });
      u.tokenQR = nuevoToken;
    }
    return { nombre:u.nombreCompleto, cedula:u.cedula, cargo:u.cargoArea, rol:u.rol, tokenQR:u.tokenQR, fechaRegistro:u.fechaRegistro };
  }

  // ============= 2. autoRegistrarse({cedula,nombre,cargo,pin}) =============
  if (name === 'autoRegistrarse') {
    var d = args[0] || {};
    var ced = String(d.cedula||'').trim();
    var nom = String(d.nombre||'').trim();
    var car = String(d.cargo||'').trim();
    var pin = String(d.pin||'').trim();
    if (!ced || !nom || !pin) throw new Error('Cédula, Nombre y PIN son obligatorios.');
    var all = await seatableListAllRows(T_USU);
    var us = all.map(mapUsuarioRow);
    if (us.find(x=> x.cedula === ced)) throw new Error('Ya existe un usuario con esa cédula. Inicia sesión o contacta al administrador.');
    if (us.length === 0 && ced === '1234567890') { /* seed admin permitido */ }
    var rol = (us.length === 0 && ced === '1234567890') ? 'ADMIN' : 'TRABAJADOR';
    var nuevoTok = genToken(ced);
    if (us.find(x=> x.tokenQR === nuevoTok)) nuevoTok = nuevoTok + Math.floor(Math.random()*100);
    var ctime = ahoraIsoLocal();
    var rowData = {
      Cedula: ced, NombreCompleto: nom, CargoArea: car, Rol: rol,
      PIN: pin, TokenQR: nuevoTok, FechaRegistro: ctime
    };
    var added = await seatableAddRow(T_USU, rowData);
    return { cedula: ced, nombreCompleto: nom, cargoArea: car, rol: rol, tokenQR: nuevoTok, fechaRegistro: ctime, id: added && added._id };
  }

  // ============= 3. getInfoSistema() =============
  if (name === 'getInfoSistema') {
    var uRows = await seatableListAllRows(T_USU);
    var aRows = await seatableListAllRows(T_ASI);
    return {
      spreadsheetUrl: 'https://cloud.seatable.io/dtable/'+cfg.BASE_UUID+'/?tid=0&vid=0',
      spreadsheetId: cfg.BASE_UUID,
      sheetUsuarios: T_USU, sheetAsistencia: T_ASI,
      totalUsuarios: uRows.length, totalRegistrosAsistencia: aRows.length,
      modoBackend: 'SeaTable DIRECT (sin Apps Script)'
    };
  }

  // ============= 4. estadisticas(cedulaSesion) =============
  if (name === 'estadisticas') {
    var _usuCed = String(args[0]||'').trim();
    var usrs = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    var asis = (await seatableListAllRows(T_ASI)).map(mapAsistenciaRow);
    var hoy = hoyIsoLocal();
    var entradasHoy = asis.filter(x=> x.fecha === hoy && x.horaEntrada);
    var salidasHoy  = asis.filter(x=> x.fecha === hoy && x.horaSalida);
    var sinSalidaHoy = asis.filter(x=> x.fecha === hoy && x.horaEntrada && !x.horaSalida);
    var trabajadoresActivos = usrs.filter(x=> x.rol !== 'ADMIN');
    var admins = usrs.filter(x=> x.rol === 'ADMIN');
    var cedsHoyEntraron = new Set(entradasHoy.map(x=> x.cedula));
    var ausentesHoy = trabajadoresActivos.filter(x=> !cedsHoyEntraron.has(x.cedula));
    return {
      fechaHoy: hoy,
      totalUsuarios: usrs.length,
      totalAdmins: admins.length,
      totalTrabajadores: trabajadoresActivos.length,
      entradasHoy: entradasHoy.length,
      salidasHoy: salidasHoy.length,
      enSitioHoy: sinSalidaHoy.length,
      ausentesHoy: ausentesHoy.length,
      totalRegistros: asis.length,
      ultimosRegistros: asis.slice(-15).reverse()
    };
  }

  // ============= 5. listarUsuarios(adminCedula) =============
  if (name === 'listarUsuarios') {
    var adminCed1 = String(args[0]||'').trim();
    var uAll = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    requireAdmin(uAll, adminCed1);
    return uAll.sort((a,b)=> (a.nombreCompleto||'').localeCompare(b.nombreCompleto||''));
  }

  // ============= 6. crearUsuario(adminCedula, datosNuevo) =============
  if (name === 'crearUsuario') {
    var adminCed2 = String(args[0]||'').trim();
    var data = args[1] || {};
    var uAll2 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    var _a2 = requireAdmin(uAll2, adminCed2);
    var nc = String(data.cedula||'').trim();
    var nn = String(data.nombreCompleto||'').trim();
    var ncargo = String(data.cargoArea||'').trim();
    var nrol = (String(data.rol||'TRABAJADOR')||'').toUpperCase();
    var npin = String(data.pin||'').trim();
    if (!nc || !nn || !npin) throw new Error('Cédula, Nombre y PIN son obligatorios para crear el usuario.');
    if (nrol !== 'ADMIN' && nrol !== 'TRABAJADOR') throw new Error('Rol inválido. Usa ADMIN o TRABAJADOR.');
    if (uAll2.find(x=> x.cedula === nc)) throw new Error('Ya existe un usuario con esa cédula.');
    var tok = genToken(nc);
    if (uAll2.find(x=> x.tokenQR === tok)) tok = tok + Math.floor(Math.random()*1000);
    var ct = ahoraIsoLocal();
    var r = await seatableAddRow(T_USU, { Cedula:nc, NombreCompleto:nn, CargoArea:ncargo, Rol:nrol, PIN:npin, TokenQR:tok, FechaRegistro:ct });
    return { cedula:nc, nombreCompleto:nn, cargoArea:ncargo, rol:nrol, tokenQR:tok, fechaRegistro:ct, id: r && r._id };
  }

  // ============= 7. eliminarUsuario(adminCedula, usuario_id) =============
  if (name === 'eliminarUsuario') {
    var adminCed3 = String(args[0]||'').trim();
    var userRowId = String(args[1]||'').trim();
    var uAll3 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    requireAdmin(uAll3, adminCed3);
    if (!userRowId) throw new Error('ID usuario vacío.');
    await seatableDeleteRow(T_USU, userRowId);
    return { deleted: true, id: userRowId };
  }

  // ============= 8. eliminarRegistro(adminCedula, registro_id) =============
  if (name === 'eliminarRegistro') {
    var adminCed4 = String(args[0]||'').trim();
    var asisId = String(args[1]||'').trim();
    var uAll4 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    requireAdmin(uAll4, adminCed4);
    if (!asisId) throw new Error('ID registro vacío.');
    await seatableDeleteRow(T_ASI, asisId);
    return { deleted: true, id: asisId };
  }

  // ============= 9. obtenerTokenQR(cedulaUsuario[, adminCedulaOpcional]) =============
  if (name === 'obtenerTokenQR') {
    var cedU = String(args[0]||'').trim();
    var adminOpt = String(args[1]||'').trim();
    var uAll5 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    if (adminOpt) requireAdmin(uAll5, adminOpt);
    var u = uAll5.find(x=> x.cedula === cedU);
    if (!u) throw new Error('Usuario no encontrado.');
    if (!u.tokenQR) {
      var tokN = genToken(u.cedula);
      await seatableUpdateRow(T_USU, u.id, { TokenQR: tokN });
      u.tokenQR = tokN;
    }
    return { cedula:u.cedula, nombre:u.nombreCompleto, cargo:u.cargoArea, rol:u.rol, tokenQR:u.tokenQR };
  }

  // ============= 10. regenerarTokenQR(adminCedula, cedulaUsuario) =============
  if (name === 'regenerarTokenQR') {
    var adminCed5 = String(args[0]||'').trim();
    var cedU2 = String(args[1]||'').trim();
    var uAll6 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    requireAdmin(uAll6, adminCed5);
    var u2 = uAll6.find(x=> x.cedula === cedU2);
    if (!u2) throw new Error('Usuario no encontrado para regenerar QR.');
    var baseTok = genToken(cedU2);
    var tokR = baseTok + Math.floor(Math.random()*10000);
    await seatableUpdateRow(T_USU, u2.id, { TokenQR: tokR });
    return { cedula:u2.cedula, tokenQR: tokR, nombre:u2.nombreCompleto };
  }

  // ============= 11. registroManual(cedulaUsuario, tipo(ENTRADA|SALIDA), adminCedula) =============
  // ============= 12. registrarPorTokenQR(token) =============
  if (name === 'registroManual' || name === 'registrarPorTokenQR') {
    var medio = (name === 'registroManual') ? 'MANUAL' : 'QR';
    var targetCed, targetTipo, adminC;
    var uAll7 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    if (name === 'registroManual') {
      targetCed = String(args[0]||'').trim();
      targetTipo = String(args[1]||'ENTRADA').toUpperCase();
      adminC = String(args[2]||'').trim();
      requireAdmin(uAll7, adminC);
    } else {
      var tk = String(args[0]||'').trim();
      if (!tk) throw new Error('QR vacío. Vuelve a escanear.');
      var tUsuario = uAll7.find(x=> x.tokenQR === tk);
      if (!tUsuario) throw new Error('Este código QR NO pertenece a ningún usuario registrado. Pide a admin que cree la cuenta o regenera tu QR.');
      targetCed = tUsuario.cedula;
      targetTipo = 'ENTRADA_O_SALIDA_AUTODETECT';
    }
    var usu = uAll7.find(x=> x.cedula === targetCed);
    if (!usu) throw new Error('Usuario con cédula '+targetCed+' no registrado.');
    var fecha = hoyIsoLocal();
    var horaNow = ahoraHoraStr();
    var asisRows = (await seatableListAllRows(T_ASI)).map(mapAsistenciaRow);
    var existenteHoy = asisRows.find(x=> x.cedula === targetCed && x.fecha === fecha);

    // autodetectar tipo si es QR: si NO tiene horaEntrada → ENTRADA; si tiene Entrada y NO Salida → SALIDA; si tiene las dos → NUEVA ENTRADA
    if (targetTipo === 'ENTRADA_O_SALIDA_AUTODETECT') {
      if (!existenteHoy) targetTipo = 'ENTRADA';
      else if (existenteHoy.horaEntrada && !existenteHoy.horaSalida) targetTipo = 'SALIDA';
      else targetTipo = 'ENTRADA';
    }

    var rowIdOld = existenteHoy ? existenteHoy.id : null;
    var idReg = existenteHoy ? existenteHoy.idRegistro : uid();
    if (targetTipo === 'ENTRADA') {
      if (existenteHoy && existenteHoy.horaEntrada && existenteHoy.horaSalida) {
        // nuevo registro mismo día (segunda jornada)
        var nuevoId = uid();
        var dataNew = {
          ID_Registro: nuevoId,
          Cedula: usu.cedula, Nombre: usu.nombreCompleto, Cargo: usu.cargoArea,
          Fecha: fecha, HoraEntrada: horaNow, HoraSalida: '', MedioRegistro: medio, Observaciones: (medio==='QR'?'Registro QR entrada (2ª jornada)':'Registro manual entrada (2ª jornada)')
        };
        var addN = await seatableAddRow(T_ASI, dataNew);
        return { tipo:'ENTRADA', idRegistro: nuevoId, cedula:usu.cedula, nombre:usu.nombreCompleto, fecha:fecha, hora: horaNow, id: addN && addN._id, medioRegistro:medio };
      }
      if (existenteHoy) {
        // actualiza entrada
        await seatableUpdateRow(T_ASI, rowIdOld, { HoraEntrada: horaNow, MedioRegistro: medio, Observaciones: (existenteHoy.observaciones||'') + ' / Entrada actualizada '+ahoraHoraStr()+' ('+medio+')' });
        return { tipo:'ENTRADA', idRegistro: existenteHoy.idRegistro, cedula:usu.cedula, nombre:usu.nombreCompleto, fecha:fecha, hora:horaNow, id:rowIdOld, medioRegistro:medio };
      }
      // crear registro nuevo
      var newRow = {
        ID_Registro: idReg,
        Cedula: usu.cedula, Nombre: usu.nombreCompleto, Cargo: usu.cargoArea,
        Fecha: fecha, HoraEntrada: horaNow, HoraSalida: '', MedioRegistro: medio, Observaciones: 'Entrada registrada por '+medio
      };
      var added = await seatableAddRow(T_ASI, newRow);
      return { tipo:'ENTRADA', idRegistro: idReg, cedula:usu.cedula, nombre:usu.nombreCompleto, fecha:fecha, hora:horaNow, id:added && added._id, medioRegistro:medio };
    }

    if (targetTipo === 'SALIDA') {
      if (!existenteHoy) throw new Error('No hay registro de ENTRADA hoy para '+usu.nombreCompleto+'. Debes registrar entrada primero.');
      if (existenteHoy.horaSalida) throw new Error('Ya hay SALIDA registrada hoy para '+usu.nombreCompleto+' a las '+existenteHoy.horaSalida+'. Si quieres nueva salida, regenera entrada.');
      await seatableUpdateRow(T_ASI, rowIdOld, { HoraSalida: horaNow, MedioRegistro: existenteHoy.medioRegistro || medio, Observaciones: (existenteHoy.observaciones||'') + ' / Salida registrada por '+medio });
      return { tipo:'SALIDA', idRegistro: existenteHoy.idRegistro, cedula:usu.cedula, nombre:usu.nombreCompleto, fecha:fecha, hora:horaNow, id:rowIdOld, horaEntrada:existenteHoy.horaEntrada, medioRegistro:medio };
    }

    throw new Error('Tipo de registro inválido: '+targetTipo);
  }

  // ============= 13. listarAsistencia(adminCedula, filtrosObj) =============
  if (name === 'listarAsistencia') {
    var adminCed6 = String(args[0]||'').trim();
    var filt = args[1] || {};
    var uAll8 = (await seatableListAllRows(T_USU)).map(mapUsuarioRow);
    var yo = requireAdmin(uAll8, adminCed6);
    var all = (await seatableListAllRows(T_ASI)).map(mapAsistenciaRow);
    if (filt && filt.fechaDesde) { all = all.filter(x=> x.fecha >= filt.fechaDesde); }
    if (filt && filt.fechaHasta) { all = all.filter(x=> x.fecha <= filt.fechaHasta); }
    if (filt && filt.cedula) { var fc = String(filt.cedula).trim(); if (fc) all = all.filter(x=> x.cedula === fc); }
    all.sort((a,b)=> (b.fecha+' '+b.horaEntrada).localeCompare(a.fecha+' '+a.horaEntrada));
    return all;
  }

  // ============= 14. exportarCSV(adminCedula, filtrosObj) =============
  if (name === 'exportarCSV') {
    var adminCed7 = String(args[0]||'').trim();
    var filtE = args[1] || {};
    var rows = await dispatchSeatableAction('listarAsistencia', [adminCed7, filtE]);
    var lines = ['ID_Registro,Cedula,Nombre,Cargo,Fecha,HoraEntrada,HoraSalida,MedioRegistro,Observaciones'];
    rows.forEach(r=>{
      var escCsv = function(v){ var s = String(v==null?'':v); s = s.replace(/"/g,'""'); return /[",\n]/.test(s) ? '"'+s+'"' : s; };
      lines.push([r.idRegistro, r.cedula, r.nombre, r.cargo, r.fecha, r.horaEntrada, r.horaSalida, r.medioRegistro, r.observaciones].map(escCsv).join(','));
    });
    return lines.join('\r\n');
  }

  // -------- acción desconocida --------
  throw new Error('Acción backend no soportada en modo SeaTable: '+name+'. Comunícate con soporte.');
}

// ==========================================================
//  SESSION / LOGIN FLOW
// ==========================================================
function saveSession(u){
  try { localStorage.setItem(LS_KEY, JSON.stringify(u)); } catch(e){}
  currentUser = u;
}
function getSession(){
  try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; }
  catch(e){ return null; }
}
function clearSession(){ try{localStorage.removeItem(LS_KEY);}catch(e){} currentUser=null; }

// ---------- SWITCH: LOGIN vs REGISTRAR ----------
function setLoginMode(mode){
  const isLogin = mode === 'login';
  const tL = $('tabLoginMode'), tR = $('tabRegMode');
  const fL = $('loginForm'), fR = $('regForm');
  const ftL = $('loginFooterLogin'), ftR = $('loginFooterReg');
  const err = $('loginError');
  const subtitle = $('loginSubtitle');

  tL.classList.toggle('active', isLogin);
  tL.style.borderBottom = isLogin ? '2px solid var(--navy-600)' : 'none';
  tL.style.color = isLogin ? '' : 'var(--slate-500)';

  tR.classList.toggle('active', !isLogin);
  tR.style.borderBottom = !isLogin ? '2px solid var(--purple-500)' : 'none';
  tR.style.color = !isLogin ? '' : 'var(--slate-500)';

  fL.classList.toggle('hidden', !isLogin);
  fR.classList.toggle('hidden', isLogin);
  ftL.classList.toggle('hidden', !isLogin);
  ftR.classList.toggle('hidden', isLogin);

  subtitle.textContent = isLogin
    ? 'Conceptos Gráficos S.A. · Iniciar Sesión'
    : 'Conceptos Gráficos S.A. · Crear Cuenta';

  err.style.display='none'; err.textContent='';
}

async function doRegistrar(){
  const ced = $('regCedula').value.trim();
  const nom = $('regNombre').value.trim();
  const car = $('regCargo').value.trim();
  const p1  = $('regPin').value.trim();
  const p2  = $('regPin2').value.trim();
  const err = $('loginError');
  const btn = $('btnRegistrar');
  err.style.display='none'; err.textContent='';

  if (!ced){ err.style.display='block'; err.textContent='⚠️ Ingrese su número de cédula.'; return; }
  if (!nom){ err.style.display='block'; err.textContent='⚠️ Ingrese su nombre completo.'; return; }
  if (!p1){  err.style.display='block'; err.textContent='⚠️ Debe crear un PIN de acceso.'; return; }
  if (p1.length < 3){ err.style.display='block'; err.textContent='⚠️ El PIN debe tener al menos 3 dígitos.'; return; }
  if (p1 !== p2){ err.style.display='block'; err.textContent='⚠️ Los PINs no coinciden. Verifique.'; return; }

  // 🔒 EVITA DOBLE CLIC (bug de 2 filas iguales en la hoja): deshabilitar botón
  btn.disabled = true;
  btn.style.opacity = '0.55';
  btn.style.pointerEvents = 'none';
  btn.dataset.originalText = btn.innerHTML;
  btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px"><span class="spinner" style="display:inline-block;width:16px;height:16px;border:2.5px solid #ffffff;border-top-color:transparent;border-radius:50%;animation:sp 0.8s linear infinite"></span> Creando cuenta...</span>`;
  loading(true, 'Creando tu cuenta y generando tu QR...');
  try {
    const r = await GS.run('autoRegistrarse', { cedula:ced, nombre:nom, cargo:car, pin:p1 });
    toast('✅ '+r.mensaje, 'success', 5500);
    // Limpiar form
    $('regCedula').value='';$('regNombre').value='';$('regCargo').value='';
    $('regPin').value='';$('regPin2').value='';
    // Rellenar login y saltar a login
    $('loginCedula').value = r.cedula;
    $('loginPin').value = p1;
    setLoginMode('login');
    // Auto-loguear
    saveSession({ cedula:r.cedula, nombre:r.nombre, cargo:r.cargo, rol:r.rol, token:r.token });
    setTimeout(()=>{
      enterApp(true); // true = recienRegistrado => mostrar tab Mi QR directamente
    }, 350);
  } catch(e){
    err.style.display='block';
    err.innerHTML = '❌ '+String(e.message||e).replace(/\n/g,'<br>');
  } finally {
    loading(false);
    // restaurar botón
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
  }
}

async function doLogin(){
  const ced = $('loginCedula').value.trim();
  const pin = $('loginPin').value.trim();
  const err = $('loginError');
  err.style.display='none'; err.innerHTML='';
  if (!ced || !pin){ err.style.display='block'; err.textContent='⚠️ Ingrese cédula y PIN.'; return; }
  loading(true, 'Iniciando sesión...');
  try {
    const u = await GS.run('login', ced, pin);
    saveSession(u);
    $('loginCedula').value=''; $('loginPin').value='';
    enterApp();
  } catch (e){
    err.style.display='block';
    err.innerHTML = '❌ '+String(e.message||e).replace(/\n/g,'<br>');
  } finally { loading(false); }
}

async function diagnosticarBackend(){
  const err = $('loginError');
  const cfg = (window.APP_CONFIG || {});
  const esSeatable = !!(cfg.SEATABLE && String(cfg.SEATABLE.APP_TOKEN||'').length>20 && String(cfg.SEATABLE.BASE_UUID||'').length>10);

  if (esSeatable) {
    // ======================= 🧭 MODO SEATABLE DIRECTO =======================
    loading(true, 'Diagnosticando conexión con SeaTable Cloud...');
    const lines = [];
    try {
      const ST = cfg.SEATABLE;
      lines.push('🧭 <b>MODO SEATABLE DIRECTO (sin Apps Script)</b>');
      lines.push('🩺 <b>PASO 1: ¿CONFIG.js SEATABLE completo?</b>');
      var ok1 = String(ST.SERVER_URL||'').startsWith('https://')
              && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(ST.BASE_UUID||''))
              && String(ST.APP_TOKEN||'').length >= 36
              && String(ST.TABLA_USUARIOS||'').length >= 3
              && String(ST.TABLA_ASISTENCIA||'').length >= 3;
      if (!ok1) {
        lines.push('   ❌ FALLO: Revisa SERVER_URL (https), BASE_UUID (formato UUID), APP_TOKEN (≥36 chars), TABLA_* no vacías.');
        lines.push('   🛠️  Edita CONFIG.js en GitHub y vuelve a pegar los valores correctos del token API de SeaTable.');
        throw new Error(lines.join('<br>'));
      }
      lines.push('   ✅ OK: SERVER_URL = '+esc(ST.SERVER_URL));
      lines.push('   ✅ OK: BASE_UUID = <code style="background:#f1f5f9;padding:2px 6px;border-radius:6px">'+esc(String(ST.BASE_UUID))+'</code>');
      lines.push('   ✅ OK: API_TOKEN = '+esc(String(ST.APP_TOKEN||'').slice(0,8))+'••••••••••'+esc(String(ST.APP_TOKEN||'').slice(-4))+' ('+String(ST.APP_TOKEN||'').length+' chars)');
      lines.push('   ✅ OK: Tablas → '+esc(ST.TABLA_USUARIOS)+' / '+esc(ST.TABLA_ASISTENCIA));

      lines.push('🩺 <b>PASO 2: Autenticar contra SeaTable (obtener Bearer temporal)</b>');
      try {
        seatableClearAuth();
        var bearer = await seatableAuth();
        lines.push('   ✅ OK: Autenticación exitosa. Bearer = '+esc(String(bearer||'').slice(0,10))+'•••• (longitud '+String(bearer||'').length+' chars)');
      } catch (eAuth){
        var ea = String(eAuth.message || eAuth);
        lines.push('   ❌ FALLO AUTH (Paso 2): '+esc(ea));
        lines.push('   🎯 CAUSAS MÁS PROBABLES:');
        lines.push('   · 1️⃣ El APP_TOKEN que pegaste en CONFIG.js es INCORRECTO. Vuelve a SeaTable → API Tokens → Create Token, copia de nuevo (cuidado con espacios).');
        lines.push('   · 2️⃣ En SeaTable, el permiso del token NO es "Lectura y escritura". Edita el token y marca Lectura + Escritura.');
        lines.push('   · 3️⃣ El BASE_UUID es INCORRECTO. Copiálo de la ventana del token (arriba dice "Base UUID").');
        lines.push('   · 4️⃣ Firewall / antivirus bloquea cloud.seatable.io — pruébalo abriendo el servidor en pestaña nueva.');
        throw new Error(lines.join('<br>'));
      }

      lines.push('🩺 <b>PASO 3: Prueba LEER Tabla "'+esc(ST.TABLA_USUARIOS)+'"</b>');
      try {
        var u = await seatableListAllRows(ST.TABLA_USUARIOS);
        lines.push('   ✅ OK: Lectura exitosa. Hay '+u.length+' usuarios en la tabla.');
        if (u.length === 0) {
          lines.push('   ⚠️  Tabla vacía. Crea el usuario ADMIN inicial (Cédula 1234567890, PIN 1234, Rol ADMIN, TokenQR = genToken de la cédula) o usa "Regístrame" y se creará automáticamente si es la 1ª fila.');
        } else {
          lines.push('   ℹ️  Último usuario: '+esc(String(u[u.length-1].NombreCompleto || u[u.length-1].Cedula || '(sin nombre)')));
        }
      } catch(eLectU){
        var eu = String(eLectU.message || eLectU);
        lines.push('   ❌ FALLO LECTURA USUARIOS: '+esc(eu));
        lines.push('   🎯 CAUSAS PROBABLES:');
        lines.push('   · 1️⃣ La tabla NO SE LLAMA "'+esc(ST.TABLA_USUARIOS)+'" (sensible a mayúsculas). Renómbrala en SeaTable.');
        lines.push('   · 2️⃣ NO CREASTE la tabla. Sigue la guía de creación de tablas que te pasé (7 columnas exactas).');
        lines.push('   · 3️⃣ El token no tiene permiso Lectura. Edita el token en SeaTable → Lectura y Escritura.');
        throw new Error(lines.join('<br>'));
      }

      lines.push('🩺 <b>PASO 4: Prueba LEER Tabla "'+esc(ST.TABLA_ASISTENCIA)+'"</b>');
      try {
        var a = await seatableListAllRows(ST.TABLA_ASISTENCIA);
        lines.push('   ✅ OK: Lectura exitosa. Hay '+a.length+' registros de asistencia.');
      } catch(eLectA){
        var eaa = String(eLectA.message || eLectA);
        lines.push('   ❌ FALLO LECTURA ASISTENCIA: '+esc(eaa));
        lines.push('   🎯 Causa probable: NO creaste la tabla "'+esc(ST.TABLA_ASISTENCIA)+'" con sus 9 columnas exactas. Repite la guía de creación tablas y vuelve.');
        throw new Error(lines.join('<br>'));
      }

      lines.push('🩺 <b>PASO 5: Prueba LOGIN REAL (credenciales admin 1234567890/1234 — EXACTAMENTE lo que hace el botón Iniciar Sesión)</b>');
      try {
        var loginRta = await GS.run('login','1234567890','1234');
        lines.push('   🎉 <b>¡TODO FUNCIONA! Login Admin 1234567890/1234 → EXITOSO.</b>');
        lines.push('   · Nombre: '+esc(loginRta.nombre||'—'));
        lines.push('   · Cargo:  '+esc(loginRta.cargo||'—'));
        lines.push('   · Rol:    '+esc(loginRta.rol||'—'));
        lines.push('   · TokenQR: '+esc(loginRta.tokenQR||'—'));
        lines.push('🎊 <b>¡DIAGNÓSTICO SEATABLE 100% APROBADO! Ya puedes iniciar sesión 🚀</b>');
      } catch (eLogin){
        var el = String(eLogin.message || eLogin);
        lines.push('   ⚠️  Login falló con: '+esc(el));
        lines.push('   ℹ️  Esto NORMALMENTE significa: tu admin 1234567890 / PIN 1234 NO EXISTE AÚN en la tabla Usuarios. Solución:');
        lines.push('   · Opción A: Crea MANUALMENTE la 1ª fila en Usuarios (Cedula=1234567890, Rol=ADMIN, PIN=1234, TokenQR=CG'+esc((window.__md5 ? window.__md5('CG-ASIS-1234567890-2026').slice(0,20) : 'a001e18f56fb65488f95'))+')');
        lines.push('   · Opción B: Pulsa <b>+ Regístrame</b> desde la app, crea el usuario con cédula 1234567890 (será automáticamente ADMIN por ser la 1ª fila).');
        lines.push('   · Luego vuelve a iniciar sesión.');
      }

      err.style.display = 'block'; err.innerHTML = lines.join('<br>');
    } catch(e){
      err.style.display = 'block'; err.innerHTML = String(e.message||e).replace(/\n/g,'<br>');
    } finally { loading(false); }
    return;
  }

  // ======================= 🌐 MODO GOOGLE APPS SCRIPT =======================
  loading(true, 'Diagnosticando conexión con Google Apps Script...');
  const lines = [];
  try {
    const url = String(cfg.APPS_SCRIPT_URL || '').trim();
    lines.push('🩺 <b>PASO 1: ¿CONFIG.js existe y tiene URL?</b>');
    if (!url) { lines.push('   ❌ FALLO: CONFIG.js está vacío. Abre CONFIG.js en GitHub y pega tu URL /exec.'); throw new Error(lines.join('<br>')); }
    lines.push('   ✅ OK: Detectada URL: <code style="word-break:break-all;background:#f8fafc;padding:2px 6px;border-radius:6px">'+esc(url)+'</code>');

    lines.push('🩺 <b>PASO 2: ¿URL termina en script.google.com/.../exec?</b>');
    const okFormat = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/i.test(url);
    if (!okFormat) {
      lines.push('   ❌ FALLO: El formato NO es script.google.com/macros/s/.../exec.');
      lines.push('   ⚠️  Posiblemente Chrome TRADUJO la URL: "guion.Google.com" y "/ejecutivo" son FALSOS.');
      lines.push('   📝 Solución: En Apps Script → Desplegar → Gestionar implementaciones → COPIAR la URL de ahí y PEGAR de nuevo en CONFIG.js.');
      throw new Error(lines.join('<br>'));
    }
    lines.push('   ✅ OK: El formato de la URL es correcto.');

    lines.push('🩺 <b>PASO 3: Prueba GET /?action=ping (abrir backend en nueva pestaña)</b>');
    lines.push('   ℹ️  Abriendo backend... Si te pide autorizar OAuth, hazlo, luego vuelve y pulsa Iniciar Sesión.');
    lines.push('   ℹ️  Si en la pestaña nueva te sale: "✅ Backend OK" → tu backend funciona.');
    lines.push('   ℹ️  Si te sale: "El acceso no está autorizado" → EL DESPLIEGUE NO TIENE ACCESO = CUALQUIER PERSONA.');
    window.open(url + (url.includes('?') ? '&' : '?') + 'action=ping', '_blank', 'noopener,noreferrer');

    lines.push('🩺 <b>PASO 4: Prueba FETCH GET /?action=ping (solo lectura)</b>');
    try {
      const r = await fetch(url + (url.includes('?')?'&':'?') + 'action=ping', { method:'GET', mode:'cors' });
      lines.push('   ✅ OK: GET CORS devolvió HTTP '+r.status);
      const txt = await r.text().catch(()=>'');
      if (txt && txt.includes('Backend OK')) lines.push('   ✅ Backend respondió: "Backend OK". Conexión HTTPS funciona.');
      if (txt && txt.includes('autorizado')) lines.push('   ❌ ¡FALLO DE PERMISOS! El backend respondió: "No autorizado" → necesitas desplegar con Acceso = Cualquier persona (Anyone).');
    } catch (eFetch){
      const es = String(eFetch.message || eFetch);
      lines.push('   ❌ FALLO GET: '+esc(es));
      if (es.includes('Failed to fetch') || es.includes('CORS') || es.includes('Blocked')) {
        lines.push('   🎯 <b>CAUSA SEGURA (el 99% de los casos):</b>');
        lines.push('   Tu despliegue de Apps Script NO tiene "Acceso: Cualquier persona (Anyone)".');
        lines.push('   📝 Pasos para ARREGLARLO YA (2 minutos):');
        lines.push('   1️⃣ Abre Google Apps Script → tu proyecto.');
        lines.push('   2️⃣ Clic en <b>Desplegar → Gestionar implementaciones</b>.');
        lines.push('   3️⃣ Busca la versión ACTIVA (arriba de todo), pulsa el ✏️ Editar (lápiz).');
        lines.push('   4️⃣ Despliega <b>"Quien tiene acceso"</b> → selecciona la ÚLTIMA opción:');
        lines.push('      ✅ <b>Cualquier persona (Anyone)</b> ⚠️ NO elijas "Cualquier persona con cuenta Google" (eso sigue pidiendo login).');
        lines.push('   5️⃣ Clic en <b>Actualizar</b> (o Desplegar, si es nueva versión). Copia la URL NUEVA que termina en /exec.');
        lines.push('   6️⃣ Abre CONFIG.js en GitHub → ✏️ Edita → PEGA ESA URL NUEVA. Commit changes.');
        lines.push('   7️⃣ Espera 1 minuto a que Actions ponga ✅ VERDE. Refresca esta página con Ctrl+Shift+R.');
        lines.push('   8️⃣ Vuelve a pulsar "Iniciar Sesión" con Admin: 1234567890 / 1234');
      }
      throw new Error(lines.join('<br>'));
    }

    lines.push('🩺 <b>PASO 5: Prueba FETCH POST REAL (login acción — EXACTAMENTE lo que usa el botón Iniciar Sesión)</b>');
    try {
      const postBody = JSON.stringify({ action:'login', args:['1234567890','1234'] }); // credenciales admin
      const r2 = await fetch(url, {
        method:'POST', mode:'cors',
        headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
        body: postBody
      });
      lines.push('   ✅ OK: POST CORS devolvió HTTP '+r2.status);
      if (r2.ok) {
        try {
          const j = await r2.json();
          if (j.ok) {
            lines.push('   🎉 <b>¡POST FUNCIONA! Login Admin 1234567890/1234 CREDENCIALES VÁLIDAS — CONEXIÓN 100% ESTABLECIDA.</b>');
            lines.push('   Ya puedes pulsar Iniciar Sesión con normalidad. Si aún no funciona, es caché: cierra la pestaña y abre de nuevo.');
          } else {
            lines.push('   ℹ️  Backend respondió con error esperado: '+esc(j.error||'sin detalle'));
            lines.push('   CORS DE POST FUNCIONA, pero la credencial no coincide. Asegúrate de usar:');
            lines.push('   Admin → Cédula: <b>1234567890</b> · PIN: <b>1234</b>');
            lines.push('   O Trabajador → Cédula <b>1001001001</b> · PIN <b>2024</b>');
            lines.push('   (O crea una cuenta nueva desde Regístrame).');
          }
        } catch(_){
          const t2 = await r2.text().catch(()=>'');
          lines.push('   ⚠️  Respuesta no-JSON (primer despliegue / OAuth pendiente?): muestra un extracto: '+esc(t2.slice(0,180)));
          if (t2 && (t2.includes('autorizado') || t2.includes('Google Account required') || t2.includes('Acceso denegado'))) {
            lines.push('   ❌ <b>Causa: el despliegue NO tiene permiso Anyone. Repite el Paso 4 del diagnóstico y marca literalmente "Cualquier persona" (Anyone), NO la opción "con cuenta Google".</b>');
          }
        }
      } else if (r2.status === 401 || r2.status === 403) {
        lines.push('   ❌ HTTP '+r2.status+' → el despliegue NO tiene la opción "Cualquier persona (Anyone)" marcada.');
      }
    } catch (ePost){
      const es = String(ePost.message || ePost);
      lines.push('   ❌ FALLO POST (acción login): '+esc(es));
      lines.push('   🎯 <b>Esto es lo que realmente falla al pulsar "Iniciar Sesión". Solución:</b>');
      lines.push('   🚨 <b>La opción "Quien tiene acceso" en Apps Script → Gestionar implementaciones → tiene que ser literalmente "Cualquier persona" (Anyone).</b>');
      lines.push('   ❌ NO vale "Cualquier persona con cuenta Google" → eso pide OAuth y rompe CORS.');
      lines.push('   👉 <b>Repite los pasos 1-8 del PASO 4 (arriba en este mismo diagnóstico) y asegúrate de elegir la ÚLTIMA opción del desplegable "Quien tiene acceso".</b>');
      lines.push('   📌 Otra causa común: has pegado la URL que corresponde a una implementación ANTERIOR. Copia LA URL NUEVA DESPUÉS de hacer clic en "Actualizar implementación" y vuelve a pegarla en CONFIG.js, sube commit, espera Actions, vuelve a pulsar Diagnosticar conexión.');
      throw new Error(lines.join('<br>'));
    }

    lines.push('🎉 <b>¡DIAGNÓSTICO COMPLETO! Conexión Backend ↔ GitHub Pages: 100% OK.</b>');
    lines.push('   - Usa credenciales 👑 Admin: <b>1234567890</b> · PIN <b>1234</b>');
    lines.push('   - Si el botón Iniciar Sesión sigue sin responder: cierra TODAS las pestañas del dominio github.io y abre de nuevo (limpia caché de credenciales).');
    lines.push('   - Abre "Registro de ejecución" en Apps Script para ver si hay un error en tu servidor tras el POST (ej: SPREADSHEET_ID inválido).');

    err.style.display = 'block';
    err.innerHTML = lines.join('<br>');
  } catch (e){
    err.style.display = 'block';
    err.innerHTML = String(e.message||e).replace(/\n/g,'<br>');
  } finally { loading(false); }
}

function enterApp(recienRegistrado){
  if (!currentUser) return;
  $('viewLogin').classList.add('hidden');
  $('viewApp').classList.remove('hidden');
  // Render user header
  $('myName').textContent = currentUser.nombre;
  $('myAvatar').textContent = iniciales(currentUser.nombre);
  const rb = $('myRole');
  rb.textContent = currentUser.rol;
  rb.classList.toggle('admin', currentUser.rol==='ADMIN');
  rb.classList.toggle('user',  currentUser.rol!=='ADMIN');
  // Build tabs
  buildTabs();
  // Load tab content (TODOS renderizan su tarjeta QR para el imprimir no salga vacio)
  refreshStats();
  loadSheetInfo(); // Mostrar info de la hoja en la que se están guardando los datos
  refreshUserSelects();
  renderMyCard();  // ← Generar myQrCanvas para TODOS los roles (admin y trabajador)
  if (currentUser.rol === 'ADMIN'){
    refreshUsersTable();
    refreshAsistencia();
  } else {
    refreshMyAsistencia();
  }
  // Tab inicial: Si se acaba de registrar (recienRegistrado) → mostrar su QR.
  // De lo contrario: Panel Principal.
  if (recienRegistrado){
    switchTab('miqr');
    toast('👉 Este es tu Código QR Personal. Puedes imprimirlo o guardarlo.', 'info', 6000);
  } else {
    switchTab('dashboard');
  }
}

function buildTabs(){
  const bar = $('tabsBar');
  const isAdmin = currentUser.rol === 'ADMIN';
  const tabs = isAdmin
    ? [['dashboard','&#128202;','Panel'],
       ['scanner',  '&#128247;','Escanear QR'],
       ['usuarios', '&#128101;','Usuarios'],
       ['asistencia','&#128203;','Asistencia'],
       ['miqr',     '&#9609;','Mi QR']]
    : [['dashboard',    '&#128202;','Inicio'],
       ['miqr',         '&#9609;','Mi QR'],
       ['miasistencia', '&#128197;','Mis Registros']];
  bar.innerHTML = tabs.map(([id,ic,label],i)=>
    `<button class="tab-btn ${i===0?'active':''}" data-tab="${id}"><span>${ic}</span> ${label}</button>`
  ).join('');
  bar.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

  // Show/hide admin-only quick reg
  const qa = $('quickAdmin');
  const qu = $('quickUser');
  if (isAdmin){ qa.classList.remove('hidden'); qu.classList.add('hidden'); }
  else       { qa.classList.add('hidden');  qu.classList.remove('hidden');
    $('myQuickInfo').innerHTML = '<b>&#128075; Hola, '+esc(currentUser.nombre)+'</b><br><small style="color:var(--slate-500);font-weight:500">Usa estos botones para marcar tu ingreso / salida rápidamente.</small>';
  }

  $('dashSubtitle').textContent = isAdmin
    ? ('Bienvenido, Administrador · Sesión: '+ currentUser.nombre)
    : ('Vista personal · '+ currentUser.cargo);
}

function switchTab(name){
  document.querySelectorAll('.tab-view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  const target = $('tab-'+name);
  if (target) target.classList.add('active');
  // Side effects
  if (name === 'miqr'){ renderMyCard(); }
  if (name !== 'scanner'){ stopScanner(); }
  if (name === 'usuarios' && currentUser.rol==='ADMIN'){ refreshUsersTable(); }
  if (name === 'asistencia' && currentUser.rol==='ADMIN'){ refreshAsistencia(); }
  if (name === 'miasistencia'){ refreshMyAsistencia(); }
}

// ==========================================================
//  STATS & SELECTS
// ==========================================================
async function loadSheetInfo(){
  // 🔒 SEGURIDAD: la tarjeta de info de la hoja (URL + ID + total) SOLO la ve el ADMIN
  if (!currentUser || currentUser.rol !== 'ADMIN') {
    $('sheetInfoCard').style.display = 'none';
    return;
  }
  try {
    const info = await GS.run('getInfoSistema');
    const card = $('sheetInfoCard');
    card.style.display = 'block';
    $('sheetLinkUrl').href = info.spreadsheetUrl;
    $('sheetLinkUrl').textContent = info.spreadsheetUrl;
    aniNum($('sInfoUsers'), info.totalUsuarios||0);
    aniNum($('sInfoAsis'), info.totalRegistrosAsistencia||0);
    $('sInfoTz').textContent = info.tz || '—';
    // Guardar URL en sesión por si la necesitamos en otros lugares
    try { localStorage.setItem('cg_sheet_url', info.spreadsheetUrl); } catch(e){}
  } catch(e){
    console.warn('loadSheetInfo falló:', e);
  }
}
async function refreshStats(){
  try {
    const s = await GS.run('estadisticas', currentUser.cedula);
    aniNum($('s1'), s.registrosHoy||0);
    aniNum($('s2'), s.entradasHoy||0);
    aniNum($('s3'), s.salidasHoy||0);
    if (currentUser.rol==='ADMIN'){
      $('s4lbl').textContent='Total Usuarios';
      aniNum($('s4'), s.totalUsuarios||0);
    } else {
      $('s4lbl').textContent='Presentes Hoy';
      aniNum($('s4'), s.presentesHoy||0);
    }
  } catch(e){ console.warn(e); }
}
async function refreshUserSelects(){
  if (currentUser.rol !== 'ADMIN') return;
  try {
    const list = await GS.run('listarUsuarios', currentUser.cedula);
    const opt1 = ['<option value="">-- Seleccionar --</option>'];
    const opt2 = ['<option value="">Todos</option>'];
    list.forEach(u=>{
      const lbl = u.nombre + (u.cargo?' · '+u.cargo:'') + ' ('+u.cedula+')';
      opt1.push(`<option value="${esc(u.cedula)}">${esc(lbl)}</option>`);
      opt2.push(`<option value="${esc(u.cedula)}">${esc(lbl)}</option>`);
    });
    $('quickUser').innerHTML = opt1.join('');
    $('fCedula').innerHTML = opt2.join('');
  } catch(e){ console.warn(e); }
}

// ==========================================================
//  QUICK REGISTERS
// ==========================================================
$('btnQuickReg').addEventListener('click', async ()=>{
  const ced = $('quickUser').value;
  if (!ced){ toast('Selecciona un trabajador', 'error'); return; }
  const tipo = document.querySelector('input[name="quickTipo"]:checked').value;
  loading(true, 'Registrando '+tipo+'...');
  try {
    await GS.run('registroManual', ced, tipo, currentUser.cedula);
    toast('✅ '+tipo+' registrada correctamente', 'success');
    refreshStats(); refreshAsistencia();
  } catch(e){ toast('❌ '+e.message,'error',6000); }
  finally { loading(false); }
});
async function marcarPropia(tipo){
  loading(true, 'Registrando '+tipo+'...');
  try {
    await GS.run('registroManual', currentUser.cedula, tipo, currentUser.cedula);
    toast('✅ '+tipo+' registrada · Hora: '+new Date().toLocaleTimeString(), 'success');
    refreshStats();
    if (currentUser.rol !== 'ADMIN') refreshMyAsistencia();
  } catch(e){ toast('❌ '+e.message,'error',6000); }
  finally { loading(false); }
}
$('btnMyEntrada').addEventListener('click',()=>marcarPropia('ENTRADA'));
$('btnMySalida').addEventListener('click',()=>marcarPropia('SALIDA'));
$('btnMyEntrada2').addEventListener('click',()=>marcarPropia('ENTRADA'));
$('btnMySalida2').addEventListener('click',()=>marcarPropia('SALIDA'));

// ==========================================================
//  QR SCANNER (admin)
// ==========================================================
/**
 * Lee un QR DESDE UNA IMAGEN (archivo subido o foto de cámara capture).
 * Usa múltiples escalados + inversión + sharpen para mejorar la detección.
 * NO requiere cámara streaming (getUserMedia). Funciona en cualquier sandbox/iframe.
 */
async function leerQrDesdeArchivo(fileInput){
  const files = fileInput.files || [];
  if (!files.length) return;
  const file = files[0];
  loading(true, 'Analizando imagen QR...');
  try {
    const dataUrl = await new Promise((resolve, reject)=>{
      const r = new FileReader();
      r.onload = ()=> resolve(r.result);
      r.onerror = ()=> reject(r.error);
      r.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject)=>{
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });

    // ============================================================
    // Generamos MUCHAS versiones de la imagen (distintos tamaños,
    // inversión, brillo) para garantizar que jsQR lo detecte.
    // ============================================================
    const TARGET_SIZES = [ 900, 1200, 1600, 2000 ]; // distintas resoluciones
    const foundSoFar = new Set(); // evitar procesar el mismo token 2 veces

    const tryDecode = (canvas, w, h, opts) => {
      try {
        const idato = canvas.getContext('2d', { willReadFrequently:true }).getImageData(0,0,w,h);
        const c = jsQR(idato.data, idato.width, idato.height, opts || {});
        if (c && c.data && String(c.data).trim()) return String(c.data).trim();
      } catch(e){}
      return null;
    };

    const inversiones = [
      { inversionAttempts: 'attemptBoth' },
      { inversionAttempts: 'dontInvert' },
      { inversionAttempts: 'onlyInvert' },
    ];

    // Probar cada tamaño objetivo (escalar la imagen a múltiplos tamaños ayuda
    // MUCHO cuando la foto es de muy baja o muy alta resolución)
    for (let s = 0; s < TARGET_SIZES.length; s++){
      const TARGET = TARGET_SIZES[s];
      let w, h;
      if (Math.max(img.width, img.height) <= TARGET){
        w = img.width; h = img.height;
      } else {
        const scale = TARGET / Math.max(img.width, img.height);
        w = Math.round(img.width * scale);
        h = Math.round(img.height * scale);
      }
      w = Math.max(200, w); h = Math.max(200, h);

      // Variante 1: canvas normal
      const cv1 = document.createElement('canvas');
      cv1.width = w; cv1.height = h;
      const cx1 = cv1.getContext('2d', { willReadFrequently:true });
      cx1.imageSmoothingEnabled = true;
      cx1.imageSmoothingQuality = 'high';
      cx1.drawImage(img, 0, 0, w, h);

      // Variante 2: mismo canvas + sharpen leve / brillo (mejora QR borrosos)
      const cv2 = document.createElement('canvas');
      cv2.width = w; cv2.height = h;
      const cx2 = cv2.getContext('2d', { willReadFrequently:true });
      cx2.filter = 'contrast(125%) brightness(105%) saturate(110%)';
      cx2.drawImage(cv1, 0, 0);
      cx2.filter = 'none';

      // Probar todas las inversiones en ambos canvas
      for (let i = 0; i < inversiones.length; i++){
        const inv = inversiones[i];
        let tok = tryDecode(cv1, w, h, inv);
        if (tok && !foundSoFar.has(tok)){ foundSoFar.add(tok); }
        tok = tryDecode(cv2, w, h, inv);
        if (tok && !foundSoFar.has(tok)){ foundSoFar.add(tok); }
      }

      // Upscale 2x con interpolación (si la imagen es pequeña) → mejora módulos QR
      if (Math.max(img.width, img.height) < 900){
        const bigW = w * 2, bigH = h * 2;
        const cv3 = document.createElement('canvas');
        cv3.width = bigW; cv3.height = bigH;
        const cx3 = cv3.getContext('2d', { willReadFrequently:true });
        cx3.imageSmoothingEnabled = false; // pixel-perfect (no difuminar al escalar)
        cx3.drawImage(cv1, 0, 0, bigW, bigH);
        for (let i = 0; i < inversiones.length; i++){
          const tok = tryDecode(cv3, bigW, bigH, inversiones[i]);
          if (tok && !foundSoFar.has(tok)){ foundSoFar.add(tok); }
        }
      }

      // Encontramos algo? Procesar inmediatamente
      if (foundSoFar.size > 0){
        break;
      }
    }

    const tokens = Array.from(foundSoFar);
    if (!tokens.length){
      toast('❌ No se detectó ningún QR en la foto.\n\n💡 Mejora: toma la foto DE FRENTE, buena luz, sin sombras ni reflejos, y ocupa ~50% del cuadro.','error', 8000);
      return;
    }
    // Si hay múltiples (muy raro), tomamos el más largo (probablemente el QR real)
    tokens.sort((a,b)=> b.length - a.length);
    const ganador = tokens[0];
    toast('✅ QR detectado ('+ganador.length+' caracteres). Registrando asistencia...','success', 3000);
    await handleQRToken(ganador);
  } catch(e){
    console.error('leerQrDesdeArchivo error:', e);
    toast('❌ Error procesando imagen: '+e.message,'error',6000);
  } finally {
    loading(false);
    // Resetear el input para que se pueda volver a subir/capturar la misma foto
    try { fileInput.value = ''; } catch(e){}
  }
}

/**
 * Diagnóstico rápido de cámara para mostrar en el panel de error.
 * Devuelve string con toda la info útil.
 */
async function diagnosticarCamara_(){
  const lineas = [];
  lineas.push('🔍 Diagnóstico:');
  lineas.push('· Navegador: ' + (navigator.userAgent||'').slice(0,80));
  lineas.push('· URL actual: ' + window.location.href.slice(0,70));
  lineas.push('· SecureContext: ' + String(window.isSecureContext));
  lineas.push('· mediaDevices: ' + (navigator.mediaDevices ? 'SÍ existe' : 'NO existe (necesitas HTTPS)'));
  if (navigator.permissions && navigator.permissions.query){
    try {
      const st = await navigator.permissions.query({ name:'camera' });
      lineas.push('· Permiso (Permissions API): ' + (st.state||'unknown') + ' (NOTA: en iframes anidados dice "prompt" aunque el padre lo tenga permitido)');
    } catch(e){ lineas.push('· Permissions query error: '+e.message); }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices){
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter(d => d.kind === 'videoinput');
      lineas.push('· Cámaras detectadas: ' + cams.length +
        (cams.length ? ' (' + cams.map(c=>c.label || 'Cámara sin nombre (bloqueada)').slice(0,2).join(' / ') + ')' : ''));
      if (cams.length === 0) lineas.push('  ⚠️ Ninguna cámara detectada: o no tienes, o el driver está apagado, o el permiso no está concedido REALMENTE.');
    } catch(e){ lineas.push('· enumerateDevices error: '+e.message); }
  }
  return lineas.join('\n');
}

/**
 * Muestra un panel de ayuda GRANDE (no solo toast) cuando falla la cámara,
 * con las instrucciones exactas para permitir el permiso.
 */
function mostrarPanelErrorCamara(errObj, infoExtra){
  const errMsg = (errObj && (errObj.message || String(errObj))) || 'desconocido';
  const errName = (errObj && errObj.name) || '';
  const host = $('qrModalHostFallback') || (()=>{
    const d = document.createElement('div');
    d.id = 'qrModalHostFallback';
    document.body.appendChild(d);
    return d;
  })();
  // Traducir mensajes de error comunes a lenguaje simple
  let titulo = '❌ No se pudo acceder a la cámara';
  let solucion = '';
  const esAppsScript = /googleusercontent\.com|script\.google\.com|macros\/s\//i.test(window.location.href || '');
  const firma = errName + '|' + errMsg;

  if (/notallowed|permission denied|permiso denegado|denegad|securityerr/i.test(firma)) {
    solucion = `
      <div style="padding:14px 16px;border-radius:12px;background:white;border:1px solid #fecaca;font-size:12.5px;color:#7f1d1d;line-height:1.75">
      <div style="font-weight:900;margin-bottom:6px;font-size:13.5px;color:#991b1b">🚨 PERMISO DENEGADO (por el sandbox iframe de Apps Script)</div>
      <div style="margin-top:6px;padding:10px 12px;background:#fef9c3;border:1px solid #fde68a;border-radius:10px;color:#713f12">
      <b>⚠️ NOTA IMPORTANTE:</b> Google Apps Script ejecuta la app dentro de un <b>iframe anidado</b> (dominio <code>*.googleusercontent.com</code>). Aunque actives el permiso en el candado, el iframe a veces <b>no lo hereda</b>. Es un bug conocido de la plataforma.
      </div>
      <ol style="padding-left:18px;margin:8px 0 0">
        <li>Haz clic en el candado 🔒 → <b>Cámara</b> → selecciona <b style="color:#16a34a">✔ Permitir</b>.</li>
        <li><b>Cierra completamente la pestaña y vuelve a abrir</b> la URL del despliegue (no solo actualiza F5).</li>
        <li>Al reabrir, pulsa <b>Encender Cámara</b> y en el <b>popup del navegador</b> que aparece (no el candado) elige <b>Permitir</b>.</li>
        <li style="margin-top:4px">Si sigues sin poder: escribe <b>chrome://settings/content/camera</b> → borra los permisos guardados de <i>script.google.com</i> y vuelve a intentarlo.</li>
      </ol>
      </div>`;
  } else if (/notfound|device|no input|overconstrained|notreadable|trackstart|inuse|constraint/i.test(firma)) {
    solucion = `<div style="padding:14px 16px;border-radius:12px;background:white;border:1px solid #fde68a;font-size:12.5px;color:#92400e;line-height:1.75">
      <b>⚠️ La cámara está ocupada / no disponible / constraints inválidas.</b><br>
      · Cierra Meet, Teams, Zoom, OBS, WhatsApp Web u otras apps que usen cámara.<br>
      · Si usas laptop: tienes webcam frontal → el 2do/3er intento del scanner ya usa <code>facingMode:user</code> (frontal).<br>
      · 🔹 Usa el <b>método alternativo</b> (Subir Imagen QR) — funciona 100% sin necesidad de cámara.</div>`;
  } else if (/securecontext|only secure|https|localhost|mediaDevices is undefined/i.test(firma)) {
    solucion = `<div style="padding:14px 16px;border-radius:12px;background:white;border:1px solid #fde68a;font-size:12.5px;color:#92400e;line-height:1.75">
      <b>⚠️ Se requiere HTTPS o localhost.</b><br>La web que abre Google Apps Script es segura (https://), pero si abriste desde un archivo local no funciona. Usa la URL del Despliegue.</div>`;
  } else {
    solucion = `<div style="padding:14px 16px;border-radius:12px;background:white;border:1px solid #e2e8f0;font-size:12.5px;color:#334155;line-height:1.75">
      <b>Detalles técnicos:</b><br>
      · Error name: <code style="background:#f1f5f9;padding:2px 6px;border-radius:5px">${esc(errName||'-')}</code><br>
      · Error msg:  <code style="background:#f1f5f9;padding:2px 6px;border-radius:5px">${esc(String(errMsg).slice(0,180))}</code></div>`;
  }

  host.innerHTML = `
    <div class="modal-backdrop" id="qrErrBackdrop">
      <div class="modal" style="max-width:560px">
        <div class="modal-head" style="background:linear-gradient(135deg,#991b1b,#7f1d1d)">
          <h3><span style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.15);display:inline-flex;align-items:center;justify-content:center">📷</span> ${esc(titulo)}</h3>
          <button class="modal-close" id="qrErrClose">✕</button>
        </div>
        <div class="modal-body" style="max-height:80vh;overflow-y:auto">
          ${solucion}

          <div style="margin-top:16px;padding:14px 16px;border-radius:14px;background:linear-gradient(135deg,#eff6ff,#ecfdf5);border:1.5px solid #bfdbfe">
            <div style="font-size:13px;font-weight:900;color:#1e3a8a;margin-bottom:6px">
              ✅ MÉTODOS ALTERNATIVOS (funcionan siempre, sin cámara):
            </div>
            <ul style="margin:0;padding-left:18px;font-size:12px;color:#475569;line-height:1.75">
              <li><b>🖼️ Subir Imagen QR:</b> Haz clic en el botón gris "Subir Imagen QR" que está junto a Encender Cámara → saca foto al QR con tu celular → envíasela a tu PC → selecciónala y se detecta solo.</li>
              <li><b>📋 Copiar token:</b> Dentro de "Mi QR" del trabajador hay un botón <b>📋 Copiar Token</b>. Pégalo en el campo "O pega aquí un Token QR manualmente" → clic <b>Procesar Token</b>.</li>
            </ul>
          </div>

          ${infoExtra ? `<div style="margin-top:14px;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:11.5px;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;line-height:1.7">${esc(infoExtra)}</div>` : ''}

          <div style="display:flex;gap:8px;justify-content:space-between;margin-top:18px;flex-wrap:wrap">
            <button class="btn btn-outline-secondary" id="qrErrDiagnosticar">🔍 Diagnosticar navegador</button>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-secondary" id="qrErrReintentar">🔄 Reintentar (3 modos)</button>
              <button class="btn btn-purple" id="qrErrOk">Entendido</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  const remove = ()=>{ const h=$('qrErrBackdrop'); if(h) h.remove(); };
  $('qrErrClose').onclick = remove;
  $('qrErrBackdrop').onclick = (e)=>{ if(e.target && e.target.id==='qrErrBackdrop') remove(); };
  $('qrErrOk').onclick = remove;
  $('qrErrReintentar').onclick = ()=>{ remove(); startScanner(); };
  $('qrErrDiagnosticar').onclick = async ()=>{
    const btn = $('qrErrDiagnosticar');
    if (!btn) return;
    btn.disabled = true; btn.textContent = 'Diagnosticando...';
    try {
      const reporte = await diagnosticarCamara_();
      // Añadir el reporte en un recuadro adicional dentro del body del modal
      const bd = document.querySelector('#qrErrBackdrop .modal-body');
      if (bd){
        const exist = document.getElementById('qrErrDiagResult');
        if (exist) exist.remove();
        const d = document.createElement('div');
        d.id = 'qrErrDiagResult';
        d.style.cssText = 'margin-top:14px;padding:12px 14px;border-radius:12px;background:#0f172a;color:#a5f3fc;font-size:11.5px;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;line-height:1.7;overflow-x:auto';
        d.textContent = reporte;
        bd.appendChild(d);
      }
    } catch(e){ console.warn(e); }
    finally { if(btn){ btn.disabled=false; btn.textContent='🔍 Diagnosticar navegador'; } }
  };
}

/**
 * Intenta getUserMedia en 3 MODOS (facingMode env → user → sin constraints),
 * para cubrir laptops con webcam frontal, celulares, etc.
 */
async function intentarGetUserMedia_(){
  const estrategias = [
    { nombre:'environment (trasera/celular)',  constraints:{ video:{ facingMode:'environment', width:{ideal:1280}, height:{ideal:720} }, audio:false } },
    { nombre:'user (frontal/laptop)',          constraints:{ video:{ facingMode:'user',        width:{ideal:1280}, height:{ideal:720} }, audio:false } },
    { nombre:'default (sin restricciones)',    constraints:{ video:true, audio:false } },
  ];
  let ultimoError = null;
  const intentosInfo = [];
  for (let i = 0; i < estrategias.length; i++){
    const s = estrategias[i];
    try {
      intentosInfo.push('Intento '+(i+1)+'/3 [' + s.nombre + ']...');
      const stream = await navigator.mediaDevices.getUserMedia(s.constraints);
      intentosInfo.push('  → ✅ ÉXITO con modo "' + s.nombre + '"');
      return { stream, modoUsado: s.nombre, log: intentosInfo.join('\n') };
    } catch(e){
      intentosInfo.push('  → ❌ Falló: ' + (e.name || 'Error') + ' - ' + (e.message||''));
      ultimoError = e;
    }
  }
  throw { err: ultimoError, log: intentosInfo.join('\n') };
}

async function startScanner(){
  if (scanning.running) return;
  const video = $('qrVideo');
  const canvas = $('qrCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently:true });
  scanning.videoEl = video; scanning.canvasEl = canvas; scanning.ctx = ctx;

  // 1) Validación previa: ¿soporta mediaDevices el navegador?
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    mostrarPanelErrorCamara({ name:'SecureContextError', message:'Tu navegador no expone getUserMedia. Necesitas abrir por HTTPS (URL del despliegue Apps Script).' });
    return;
  }

  // 2) Pre-calentar: enumerateDevices para que el navegador pida permiso también (a veces ayuda)
  try { await navigator.mediaDevices.enumerateDevices(); } catch(e){}

  try {
    const resultado = await intentarGetUserMedia_();
    scanning.stream = resultado.stream;
    video.srcObject = scanning.stream;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.muted = true;
    // Asegurar que el video NO esté oculto mientras se inicializa (algunos navegadores bloquean play() si display:none)
    const prevDisplay = video.style.display;
    try {
      await video.play();
    } catch(ePlay){
      // Fallback play por si play() lanza "play() failed because the user didn't interact"
      try { await video.play().catch(()=>{}); } catch(_){}
    }
    scanning.running = true;
    $('btnScanStart').classList.add('hidden');
    $('btnScanStop').classList.remove('hidden');
    // Flash
    try {
      const tr = scanning.stream.getVideoTracks()[0];
      const caps = tr && tr.getCapabilities ? tr.getCapabilities() : null;
      if (caps && caps.torch) $('btnScanFlash').classList.remove('hidden');
    } catch(e){}
    if (resultado.modoUsado && resultado.modoUsado !== 'environment (trasera/celular)'){
      toast('ℹ️ Cámara activada en modo: ' + resultado.modoUsado,'info', 4000);
    }
    scanLoop();
  } catch(bundle){
    const err = (bundle && bundle.err) || bundle;
    const log = (bundle && bundle.log) ? bundle.log : '';
    console.warn('Camera error bundle:', bundle);
    try { toast('❌ No se pudo acceder a la cámara: '+ (err && err.message ? err.message : String(bundle)), 'error', 5000); } catch(err2){}
    try { mostrarPanelErrorCamara(err, log); } catch(err3){}
  }
}
function stopScanner(){
  scanning.running=false;
  if (scanning.raf) cancelAnimationFrame(scanning.raf);
  if (scanning.stream){ scanning.stream.getTracks().forEach(t=>t.stop()); scanning.stream=null; }
  if (scanning.videoEl){ scanning.videoEl.srcObject=null; }
  $('btnScanStart').classList.remove('hidden');
  $('btnScanStop').classList.add('hidden');
  $('btnScanFlash').classList.add('hidden');
}
async function scanLoop(){
  if (!scanning.running) return;
  const v = scanning.videoEl, c = scanning.canvasEl, ctx = scanning.ctx;
  if (v.readyState === v.HAVE_ENOUGH_DATA){
    c.width  = v.videoWidth;
    c.height = v.videoHeight;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    try {
      const img = ctx.getImageData(0,0,c.width,c.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
      if (code && code.data){
        await handleQRToken(code.data);
      }
    } catch(e){ /* ignore */ }
  }
  scanning.raf = requestAnimationFrame(scanLoop);
}
async function handleQRToken(token){
  token = String(token||'').trim();
  if (!token) return;
  // Antirebote: mismo token en < 3s => no
  const now = Date.now();
  if (scanning.lastToken === token && (now - scanning.lastTokenAt) < 3500) return;
  scanning.lastToken = token; scanning.lastTokenAt = now;
  // Beep
  try { const ctxA = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctxA.createOscillator(); const g = ctxA.createGain();
    o.frequency.value=920; o.type='sine'; g.gain.value=0.16;
    o.connect(g); g.connect(ctxA.destination); o.start();
    setTimeout(()=>{try{o.stop();ctxA.close();}catch(e){}}, 120);
  } catch(e){}
  loading(true, 'Procesando QR...');
  try {
    const r = await GS.run('registrarPorTokenQR', token);
    renderLastRead(r);
    refreshStats();
    if (currentUser.rol==='ADMIN') refreshAsistencia();
  } catch(e){
    toast('❌ QR inválido: '+e.message,'error',5500);
    renderLastReadError(e.message, token);
  } finally { loading(false); }
}
function renderLastRead(r){
  const el = $('lastReadBox');
  const cls = (r.tipo||'').toLowerCase().includes('entrada') ? 'read-box read-entry' : 'read-box read-exit';
  el.className = cls;
  el.textContent = r.mensaje || JSON.stringify(r);
}
function renderLastReadError(msg, token){
  const el = $('lastReadBox');
  el.className = 'read-box';
  el.style.background = 'var(--red-100)';
  el.style.color = '#7f1d1d';
  el.style.border = '1px solid #fca5a5';
  el.textContent = '❌ Error: '+ msg + '\nToken leído: ' + token;
  setTimeout(()=>{ if(el.textContent.startsWith('❌')) el.removeAttribute('style'); }, 3000);
}
$('btnScanStart').addEventListener('click', startScanner);
$('btnScanStop').addEventListener('click', stopScanner);
$('btnTokenManual').addEventListener('click', ()=>{
  const t = $('tokenManual').value.trim(); if (!t){ toast('Pega un token','error'); return; }
  handleQRToken(t); $('tokenManual').value='';
});
$('tokenManual').addEventListener('keydown',e=>{ if(e.key==='Enter') $('btnTokenManual').click(); });
$('btnScanFlash').addEventListener('click', async ()=>{
  if (!scanning.stream) return;
  try {
    const t = scanning.stream.getVideoTracks()[0];
    const cap = t.getCapabilities(); if(!cap.torch) return;
    const cur = (t.getSettings().advanced && t.getSettings().advanced[0]?.torch) || false;
    await t.applyConstraints({ advanced:[{ torch: !cur }] });
    $('btnScanFlash').textContent = (!cur?'⚡ Flash ON':'⚡ Flash');
  } catch(e){ toast('Flash no soportado','error',3000); }
});
// Subir/Capturar imagen QR (NO usa getUserMedia, funciona siempre en sandbox)
['qrUploadInput','qrCamInput','qrCamFrontInput'].forEach(function(id){
  try {
    const el = document.getElementById(id);
    if (el){ el.addEventListener('change', function(){ leerQrDesdeArchivo(this); }); }
  } catch(e){}
});

// ==========================================================
//  USUARIOS (admin)
// ==========================================================
$('btnToggleUserForm').addEventListener('click', ()=>{
  const f = $('userForm'); const b = $('btnToggleUserForm');
  const open = f.classList.toggle('hidden') === false;
  b.innerHTML = open ? '&#10134; Cerrar Formulario' : '&#10133; Nuevo Usuario';
  if (open) $('nuCedula').focus();
});
$('btnCrearUsuario').addEventListener('click', async ()=>{
  const d = {
    cedula: $('nuCedula').value.trim(),
    nombre: $('nuNombre').value.trim(),
    cargo:  $('nuCargo').value.trim(),
    rol:    $('nuRol').value
  };
  if (!d.cedula || !d.nombre){ toast('Cédula y Nombre son obligatorios','error'); return; }
  loading(true, 'Creando usuario...');
  try {
    const r = await GS.run('crearUsuario', currentUser.cedula, d);
    toast('✅ Usuario creado · Cédula '+r.cedula, 'success');
    $('nuCedula').value='';$('nuNombre').value='';$('nuCargo').value='';
    refreshUsersTable(); refreshUserSelects(); refreshStats();
    // Opcional: mostrar QR del nuevo usuario
    setTimeout(()=>showQrModal(r.cedula), 450);
  } catch(e){ toast('❌ '+e.message,'error',6500); }
  finally { loading(false); }
});
async function refreshUsersTable(){
  if (currentUser.rol !== 'ADMIN') return;
  try {
    const list = await GS.run('listarUsuarios', currentUser.cedula);
    const body = $('usersBody');
    if (list.length===0){
      body.innerHTML = `<tr><td colspan="7" class="empty-cell"><div class="empty"><div class="empty-icon">&#128101;</div><p>No hay usuarios registrados.</p></div></td></tr>`;
      return;
    }
    body.innerHTML = list.map((u,i)=>`
      <tr>
        <td class="td-num">${i+1}</td>
        <td style="font-family:monospace;font-weight:700;color:var(--slate-900)">${esc(u.cedula)}</td>
        <td class="td-name">${esc(u.nombre)}</td>
        <td>${esc(u.cargo)}</td>
        <td><span class="badge ${u.rol==='ADMIN'?'b-admin':'b-user'}">${esc(u.rol)}</span></td>
        <td><code style="background:var(--slate-100);padding:2px 7px;border-radius:5px;color:var(--slate-700);font-size:12px">${esc(u.pin)}</code></td>
        <td>
          <div class="row-actions">
            <button class="icon-btn purple" title="Ver / Imprimir QR" data-act="qr" data-id="${esc(u.cedula)}">&#9609;</button>
            <button class="icon-btn danger" title="Eliminar usuario"   data-act="del-user" data-id="${esc(u.cedula)}">&#128465;</button>
          </div>
        </td>
      </tr>`).join('');
  } catch(e){ console.warn(e); toast('❌ '+e.message,'error'); }
}

// ==========================================================
//  ASISTENCIA (admin)
// ==========================================================
const filtros = () => ({ cedula:$('fCedula').value, fechaDesde:$('fDesde').value, fechaHasta:$('fHasta').value });
async function refreshAsistencia(){
  if (currentUser.rol !== 'ADMIN') return;
  loading(true, 'Cargando asistencia...');
  try {
    const r = await GS.run('listarAsistencia', currentUser.cedula, filtros());
    renderAsistenciaTable($('asisBody'), r.registros, r.totalHoras, 'admin');
    $('totalHoras').textContent = r.totalHoras.toFixed(2) + ' h';
  } catch(e){ toast('❌ '+e.message,'error'); }
  finally { loading(false); }
}
['fCedula','fDesde','fHasta'].forEach(id=>$(id).addEventListener('change', refreshAsistencia));
$('btnLimpiarFiltros').addEventListener('click', ()=>{
  $('fCedula').value='';$('fDesde').value='';$('fHasta').value='';
  refreshAsistencia();
});
$('btnExportar').addEventListener('click', async ()=>{
  loading(true, 'Generando CSV...');
  try {
    const r = await GS.run('exportarCSV', currentUser.cedula, filtros());
    downloadB64(r.dataB64, r.filename, r.mimetype);
    toast('✅ CSV descargado correctamente','success');
  } catch(e){ toast('❌ '+e.message,'error'); }
  finally { loading(false); }
});
function renderAsistenciaTable(tbody, data, totalHoras, mode){
  if (data.length===0){
    const cols = mode==='admin' ? 11 : 8;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-cell"><div class="empty"><div class="empty-icon">&#128452;</div><p>No hay registros con los filtros aplicados.</p><small>Registra una entrada o limpia los filtros.</small></div></td></tr>`;
    return;
  }
  if (mode==='admin'){
    tbody.innerHTML = data.map((r,i)=>{
      const hasIn = !!r.hEnt, hasOut = !!r.hSal;
      let estado='Incompleto', cls='b-bad';
      if (hasIn && hasOut){ estado='Completo'; cls='b-ok'; }
      else if (hasIn){ estado='En Turno'; cls='b-wait'; }
      const medCls = (r.medio||'').toUpperCase()==='QR' ? 'b-qr' : 'b-man';
      return `<tr>
        <td class="td-num">${i+1}</td>
        <td style="font-family:monospace;font-weight:600;color:var(--slate-800)">${esc(r.cedula)}</td>
        <td class="td-name">${esc(r.nombre)}</td>
        <td>${esc(r.cargo)}</td>
        <td>${fmtFecha(r.fecha)}</td>
        <td class="td-hora td-in">${r.hEnt?fmtHora(r.hEnt):'<span class="td-empty">—</span>'}</td>
        <td class="td-hora td-out">${r.hSal?fmtHora(r.hSal):'<span class="td-empty">—</span>'}</td>
        <td class="td-hours">${r.horas?r.horas.toFixed(2)+' h':'—'}</td>
        <td><span class="badge ${medCls}">${esc(r.medio||'—')}</span></td>
        <td><span class="badge ${cls}">${estado}</span></td>
        <td style="text-align:center">
          <button class="icon-btn danger" data-act="del-reg" data-id="${esc(r.idReg)}" title="Eliminar registro">&#128465;</button>
        </td>
      </tr>`;
    }).join('');
  } else {
    tbody.innerHTML = data.map((r,i)=>{
      const hasIn = !!r.hEnt, hasOut = !!r.hSal;
      let estado='Incompleto', cls='b-bad';
      if (hasIn && hasOut){ estado='Completo'; cls='b-ok'; }
      else if (hasIn){ estado='En Turno'; cls='b-wait'; }
      const medCls = (r.medio||'').toUpperCase()==='QR' ? 'b-qr' : 'b-man';
      return `<tr>
        <td class="td-num">${i+1}</td>
        <td>${fmtFecha(r.fecha)}</td>
        <td class="td-hora td-in">${r.hEnt?fmtHora(r.hEnt):'<span class="td-empty">—</span>'}</td>
        <td class="td-hora td-out">${r.hSal?fmtHora(r.hSal):'<span class="td-empty">—</span>'}</td>
        <td class="td-hours">${r.horas?r.horas.toFixed(2)+' h':'—'}</td>
        <td><span class="badge ${medCls}">${esc(r.medio||'—')}</span></td>
        <td><span class="badge ${cls}">${estado}</span></td>
        <td style="color:var(--slate-500);font-size:11.5px">${esc(r.obs||'—')}</td>
      </tr>`;
    }).join('');
  }
}

// ==========================================================
//  QR GENERACIÓN ROBUSTA (3 niveles de fallback para NUNCA fallar)
// ==========================================================
/**
 * 🪪 Genera un dataURL PNG del código QR de un token, A PRUEBA DE ERRORES:
 *   1. Primer intento: librería local `QRCode.toDataURL` (CDN)
 *   2. Segundo intento: librería local `QRCode.toCanvas` → exportar a dataURL
 *   3. Tercer intento (si falla TODO): FETCH a `api.qrserver.com` → convertir a blob → dataURL
 * Si los 3 fallan → devuelve una IMG de qrserver como URL externa (no base64) que el <img> sí dibuja.
 */
async function generarQrDataURLRobusta(token, sizePx){
  sizePx = sizePx || 560;
  if (!token) return '';
  const enc = encodeURIComponent(token);
  const externalUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${sizePx}x${sizePx}&margin=10&ecc=H&data=${enc}`;

  // --- Intento #1: QRCode.toDataURL (método directo, más rápido)
  if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
    try {
      const d = await QRCode.toDataURL(token, {
        margin: 2, width: sizePx,
        color:{ dark:'#0f2847', light:'#ffffff' },
        errorCorrectionLevel: 'H'
      });
      if (d && d.indexOf('data:image') === 0) return d;
    } catch(e){ /* continuar al fallback */ }
  }

  // --- Intento #2: QRCode.toCanvas + exportar con .toDataURL()
  if (typeof QRCode !== 'undefined' && typeof QRCode.toCanvas === 'function') {
    try {
      const cv = document.createElement('canvas');
      cv.width = sizePx; cv.height = sizePx;
      await QRCode.toCanvas(cv, token, {
        margin: 2, width: sizePx,
        color:{ dark:'#0f2847', light:'#ffffff' },
        errorCorrectionLevel: 'H'
      });
      const d = cv.toDataURL('image/png');
      if (d && d.indexOf('data:image') === 0) return d;
    } catch(e){ /* continuar al fallback */ }
  }

  // --- Intento #3: API EXTERNA qrserver.com (no requiere librería local cargada)
  try {
    const resp = await fetch(externalUrl, { method:'GET', mode:'cors' });
    if (resp && resp.ok) {
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject)=>{
        const fr = new FileReader();
        fr.onload = ()=> resolve(fr.result);
        fr.onerror = ()=> reject(fr.error);
        fr.readAsDataURL(blob);
      });
      if (dataUrl && dataUrl.indexOf('data:image') === 0) return dataUrl;
    }
  } catch(e){ /* continuar al fallback final */ }

  // --- Fallback FINAL: devolver la URL EXTERNA DIRECTA (el <img> la descargará solo)
  return externalUrl;
}

/**
 * Helper: detecta si la URL retornada es dataURL o una URL remota, para el modal descargar.
 */
function _downloadUrl(href, filename){
  const a = document.createElement('a');
  a.href = href; a.download = filename; a.rel = 'noopener';
  a.target = (href.indexOf('data:image') === 0) ? '_self' : '_blank';
  document.body.appendChild(a); a.click();
  setTimeout(()=> a.remove(), 400);
}

// ==========================================================
//  MI QR + MI ASISTENCIA (todos los usuarios)
// ==========================================================
async function renderMyCard(forceFromServer){
  if (!currentUser) return;
  // Si el token no está en sesión (migración antigua), pedirlo al backend (resuelve "QR no se genera")
  if (!currentUser.token || forceFromServer) {
    try {
      const tok = await GS.run('obtenerTokenQR', currentUser.cedula);
      if (tok) {
        currentUser.token = tok;
        saveSession(currentUser); // persistir
      }
    } catch(e){ /* continuar */ }
  }
  // header side
  $('myAvatar2').textContent = iniciales(currentUser.nombre);
  $('myName2').textContent = currentUser.nombre;
  $('myCargo2').textContent = currentUser.cargo || 'Trabajador';
  $('myCed2').textContent   = currentUser.cedula;
  $('myRole2').textContent  = currentUser.rol;
  $('myFecha').textContent  = fmtFecha(new Date().toISOString().slice(0,10));
  $('myToken').textContent  = currentUser.token || '— sin generar aún —';
  // qr side
  $('qrMyName').textContent = currentUser.nombre;
  $('qrMyCed').textContent  = 'Cédula '+ currentUser.cedula + ' · ' + (currentUser.cargo||'');
  $('qrMyToken').textContent = currentUser.token || 'Sin token';

  const holderCanvas = $('qrMyHolderCanvas'); // contenedor del canvas + imagen
  const fallBackBox  = $('qrMyFallback');     // contenedor alternativo si falla QR
  fallBackBox.style.display = 'none';

  if (!currentUser.token) {
    // Mostrar fallback amigable porque no hay token
    holderCanvas.style.display = 'none';
    fallBackBox.style.display = 'flex';
    fallBackBox.innerHTML = `
      <div style="font-size:52px">⚠️</div>
      <div style="font-size:14px;font-weight:800;color:#92400e;margin:6px 0 2px">
        Token QR no disponible
      </div>
      <div style="font-size:12px;color:#78350f;text-align:center;line-height:1.6;max-width:340px">
        Tu código QR no se pudo generar. Pulsa el botón de abajo para regenerarlo desde la hoja de cálculo.<br><br>
        <b>Cédula:</b> ${esc(currentUser.cedula)}
      </div>
      <button class="btn btn-purple" style="margin-top:12px" id="btnFixMyQr">
        🔧 Regenerar mi Código QR
      </button>`;
    $('btnFixMyQr').onclick = async ()=>{
      loading(true, 'Regenerando tu QR desde la hoja...');
      try {
        const t = await GS.run('regenerarTokenQR', currentUser.cedula, currentUser.cedula);
        currentUser.token = t;
        saveSession(currentUser);
        toast('✅ QR regenerado correctamente','success', 3000);
        await renderMyCard();
      } catch(e){ toast('❌ '+e.message, 'error', 5000);
      } finally { loading(false); }
    };
    return;
  }

  try {
    holderCanvas.style.display = 'block';

    // ✅ GENERAR QR CON FALLBACK DE 3 NIVELES (nunca más sale el recuadro vacío ni "No se pudo dibujar")
    const dataUrl = await generarQrDataURLRobusta(currentUser.token, 560);
    const img = $('myQrImg');
    img.src = dataUrl;
    img.dataset.lastDataUrl = dataUrl;

    // Respaldo (opcional): intentar dibujar canvas sin lanzar error si falla
    try {
      if (typeof QRCode !== 'undefined' && QRCode.toCanvas){
        await QRCode.toCanvas($('myQrCanvas'), currentUser.token, {
          margin: 2, width: 360,
          color:{ dark:'#0f2847', light:'#ffffff' },
          errorCorrectionLevel: 'H'
        });
        const cv = $('myQrCanvas');
        try { cv.dataset.lastDataUrl = cv.toDataURL('image/png'); } catch(e){}
      }
    } catch(e){ /* ignorar (la <img> ya tiene el QR dibujado) */ }

  } catch(e){
    // ✅ Incluso si TODO fallara, usamos la API externa DIRECTAMENTE en el <img>
    holderCanvas.style.display = 'block';
    try {
      const enc = encodeURIComponent(currentUser.token || 'CG-ERROR');
      const externalUrl = `https://api.qrserver.com/v1/create-qr-code/?size=560x560&margin=10&ecc=H&data=${enc}`;
      const img = $('myQrImg');
      img.src = externalUrl;
      img.dataset.lastDataUrl = externalUrl;
      toast('ℹ️ QR generado via servidor. Se guardó correctamente.','info', 4000);
    } catch(ee){
      // Fallback FINAL si incluso eso falla: mostrar token copiable
      holderCanvas.style.display = 'none';
      fallBackBox.style.display = 'flex';
      fallBackBox.innerHTML = `
        <div style="font-size:52px">🪪</div>
        <div style="font-size:14px;font-weight:800;color:#0f2847;margin:6px 0 2px">
          Tu Token Personal (copia y pega en el lector QR)
        </div>
        <div style="margin:10px 0;padding:10px 12px;background:#0f172a;color:#a5f3fc;border-radius:9px;font-family:monospace;font-weight:700;letter-spacing:1px;font-size:13px;word-break:break-all;width:320px;text-align:center">
          ${esc(currentUser.token)}
        </div>
        <div style="font-size:12px;color:#78350f;max-width:340px;text-align:center;line-height:1.6">
          ⚠️ No se pudo dibujar el gráfico QR. Copia este texto y pégalo en el campo "O pega aquí un Token QR" del Escaner.
        </div>
        <button class="btn btn-outline-secondary" style="margin-top:12px" id="btnCopyToken">
          📋 Copiar Token
        </button>`;
      $('btnCopyToken').onclick = ()=>{
        navigator.clipboard.writeText(currentUser.token).then(()=>{
          toast('✅ Token copiado al portapapeles','success', 2500);
        }).catch(()=>{
          toast('❌ No se pudo copiar. Selecciona y copia manualmente.','error', 4500);
        });
      };
    }
  }
}

/**
 * Helper: obtiene el DATA URL PNG del QR del usuario actual (prioriza la <img> que ya dibujamos)
 */
async function getMyQrDataUrl(){
  if (!currentUser || !currentUser.token) return '';
  // 1) Prioridad: la imagen myQrImg que ya generamos (560px, alta calidad)
  const img = $('myQrImg');
  if (img && img.src && (img.src.startsWith('data:image') || img.src.startsWith('https://'))) {
    if (img.src.startsWith('data:image')) return img.src;
    // Si es URL externa, intentamos traerla como blob y convertirla
    try {
      const resp = await fetch(img.src, { method:'GET', mode:'cors' });
      if (resp.ok) {
        const blob = await resp.blob();
        return await new Promise((res, rej)=>{
          const fr = new FileReader();
          fr.onload = ()=> res(fr.result);
          fr.onerror = ()=> rej(fr.error);
          fr.readAsDataURL(blob);
        });
      }
    } catch(e){ /* continuar al fallback */ }
  }
  // 2) Regenerar con función robusta (3 niveles)
  return generarQrDataURLRobusta(currentUser.token, 560);
}
$('btnMyPrint').addEventListener('click', async ()=>{
  loading(true, 'Generando carnet con tu QR...');
  try {
    // Generar QR SIEMPRE con función ROBUSTA (fallback API externo si falla el local
    const imgData = await generarQrDataURLRobusta(currentUser.token, 560);
    const w = window.open('', '_blank', 'width=620,height=780');
    w.document.write(`
      <!doctype html><html><head><meta charset="utf-8"><title>Carnet QR · ${esc(currentUser.nombre)}</title>
      <style>
        body{font-family:Inter,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;background:#f1f5f9;margin:0;color:#0f172a}
        .card{background:white;padding:30px 30px 22px;border-radius:20px;box-shadow:0 20px 60px rgba(15,23,42,.2);max-width:420px;text-align:center;border:1px solid #e2e8f0}
        .brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px;color:#0f2847}
        .logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#4299e1,#1e4e8c);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
        h1{font-size:15px;margin:0}
        .sub{font-size:11px;color:#64748b;margin-top:2px}
        img{display:block;margin:14px auto 10px;max-width:280px;border-radius:14px;padding:10px;background:#fff;border:2px solid #e2e8f0}
        .n{font-size:18px;font-weight:700;color:#0f172a;margin-top:4px}
        .c{font-size:13px;color:#334155;margin-top:2px}
        .ced{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#0f172a;color:#a5f3fc;padding:7px 10px;border-radius:8px;display:inline-block;margin-top:10px;letter-spacing:1px;font-weight:600}
        .tk{font-size:10.5px;color:#64748b;word-break:break-all;margin-top:6px}
        .instr{margin-top:14px;padding:10px 12px;background:#ebf8ff;border-radius:10px;font-size:11.5px;color:#1e40af;border:1px solid #bfdbfe}
        .foot{margin-top:12px;font-size:10.5px;color:#94a3b8}
      </style></head>
      <body>
        <div class="card">
          <div class="brand"><div class="logo">CG</div><div><h1>Conceptos Gráficos S.A.</h1><div class="sub">Control de Asistencia · Carnet Digital</div></div></div>
          <img src="${imgData}" alt="QR del trabajador">
          <div class="n">${esc(currentUser.nombre)}</div>
          <div class="c">${esc(currentUser.cargo||'Trabajador')}</div>
          <div class="ced">CI. ${esc(currentUser.cedula)}</div>
          <div class="tk">TOKEN: ${esc(currentUser.token)}</div>
          <div class="instr"><b>Instrucción:</b> Al ingresar o salir de la empresa, acerca este QR al lector de la recepción o usa la cámara del celular desde la app.</div>
          <div class="foot">Impreso el ${new Date().toLocaleString()} · Válido únicamente con documento físico oficial.</div>
        </div>
      </body></html>`);
    w.document.close();
    setTimeout(()=>{ w.focus(); w.print(); }, 650);
  } catch(e){
    toast('❌ Error generando carnet: '+e.message, 'error');
  } finally { loading(false); }
});

// My asistencia
const myFilt = () => ({ cedula:'', fechaDesde:$('mfDesde').value, fechaHasta:$('mfHasta').value });
async function refreshMyAsistencia(){
  loading(true, 'Cargando tu historial...');
  try {
    const r = await GS.run('listarAsistencia', currentUser.cedula, myFilt());
    renderAsistenciaTable($('myAsisBody'), r.registros, r.totalHoras, 'user');
    $('myTotalHoras').textContent = r.totalHoras.toFixed(2) + ' h';
  } catch(e){ toast('❌ '+e.message,'error'); }
  finally { loading(false); }
}
['mfDesde','mfHasta'].forEach(id=>$(id).addEventListener('change', refreshMyAsistencia));
$('btnMyLimpiar').addEventListener('click', ()=>{ $('mfDesde').value='';$('mfHasta').value='';refreshMyAsistencia(); });
$('btnMyExport').addEventListener('click', async ()=>{
  loading(true, 'Generando CSV...');
  try {
    const r = await GS.run('exportarCSV', currentUser.cedula, myFilt());
    downloadB64(r.dataB64, r.filename, r.mimetype);
    toast('✅ CSV descargado','success');
  } catch(e){ toast('❌ '+e.message,'error'); }
  finally { loading(false); }
});

// ==========================================================
//  GLOBAL DELEGATE (botones en tablas dinámicas)
// ==========================================================
document.addEventListener('click', async e=>{
  const b = e.target.closest('[data-act]'); if(!b) return;
  const act = b.dataset.act; const id = b.dataset.id;
  if (act === 'del-user' && currentUser.rol==='ADMIN'){
    if (!confirm('¿Eliminar usuario con cédula '+id+'?\n(Solo es posible si no tiene registros de asistencia).')) return;
    loading(true, 'Eliminando...');
    try { await GS.run('eliminarUsuario', currentUser.cedula, id); toast('✅ Usuario eliminado','success');
      refreshUsersTable(); refreshUserSelects(); refreshStats(); }
    catch(err){ toast('❌ '+err.message,'error',6500); }
    finally { loading(false); }
  }
  if (act === 'del-reg' && currentUser.rol==='ADMIN'){
    if (!confirm('¿Eliminar este registro de asistencia?')) return;
    loading(true, 'Eliminando registro...');
    try { await GS.run('eliminarRegistro', currentUser.cedula, id); toast('✅ Registro eliminado','success');
      refreshAsistencia(); refreshStats(); }
    catch(err){ toast('❌ '+err.message,'error',6500); }
    finally { loading(false); }
  }
  if (act === 'qr' && currentUser.rol==='ADMIN'){
    showQrModal(id);
  }
});

// ==========================================================
//  QR MODAL (ver QR de un usuario, admin)
// ==========================================================
async function showQrModal(cedula){
  loading(true, 'Generando QR del trabajador...');
  try {
    let info = null;
    try {
      info = await GS.run('obtenerTokenQR', cedula, currentUser.cedula);
    } catch(err){
      // Fallback: si no lo encuentra, intenta regenerar el token del usuario
      try {
        const nuevoToken = await GS.run('regenerarTokenQR', currentUser.cedula, cedula);
        info = await GS.run('obtenerTokenQR', cedula, currentUser.cedula);
      } catch(err2){ throw err; }
    }
    if (!info || !info.token) throw new Error('No se pudo obtener el Token QR de este usuario. Pulsa "Regenerar".');

    const host = $('qrModalHost');
    host.innerHTML = `
      <div class="modal-backdrop" id="qrMdBackdrop">
        <div class="modal">
          <div class="modal-head">
            <h3><span style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.2);display:inline-flex;align-items:center;justify-content:center">&#9609;</span> Código QR · ${esc(info.nombre)}</h3>
            <button class="modal-close" id="mdQrClose">&times;</button>
          </div>
          <div class="modal-body">
            <div class="qr-holder">
              <!-- 🖼️ IMAGEN PNG PRINCIPAL (garantiza que siempre se vea) -->
              <img id="mdQrImg" alt="QR de ${esc(info.nombre)}" style="width:340px;height:340px;max-width:100%;display:block;margin:0 auto;padding:8px;border-radius:8px;background:white;border:1px solid #e2e8f0">
              <!-- Canvas oculto de respaldo -->
              <canvas id="mdQrCanvas" width="340" height="340" style="display:none"></canvas>
              <div class="qr-user-info">
                <div class="q-name">${esc(info.nombre)}</div>
                <div class="q-cedula">Cédula: ${esc(info.cedula)}</div>
                <div class="q-cargo">Token único generado a partir de la cédula.</div>
              </div>
              <div class="token-code" id="mdToken">${esc(info.token)}</div>
            </div>
            <div class="modal-actions">
              <button class="btn btn-outline-secondary" id="mdCopy">&#128203; Copiar Token</button>
              <button class="btn btn-red-outline" id="mdRegen">&#128260; Regenerar QR</button>
              <button class="btn btn-purple" id="mdPrint">&#128424; Imprimir / Guardar PDF</button>
              <button class="btn btn-primary" id="mdDownload">&#128247; Descargar PNG</button>
            </div>
          </div>
        </div>
      </div>`;
    // ✅ Render PRINCIPAL: PNG con función ROBUSTA (3 niveles de fallback)
    const qrPng = await generarQrDataURLRobusta(info.token, 560);
    const imgMd = $('mdQrImg');
    imgMd.src = qrPng;
    imgMd.dataset.lastDataUrl = qrPng;
    // Respaldo en canvas (por si alguien lo necesita en otros scripts)
    try {
      if (typeof QRCode !== 'undefined' && QRCode.toCanvas){
        await QRCode.toCanvas($('mdQrCanvas'), info.token, {
          margin:2, width:340, color:{dark:'#0f2847',light:'#fff'}, errorCorrectionLevel:'H'
        });
      }
    } catch(e){}

    // Events
    const close = ()=> host.innerHTML='';
    $('mdQrClose').addEventListener('click', close);
    $('qrMdBackdrop').addEventListener('click', e=>{ if(e.target.id==='qrMdBackdrop') close(); });
    $('mdCopy').addEventListener('click', ()=>{
      navigator.clipboard?.writeText(info.token); toast('📋 Token copiado','info');
    });
    $('mdRegen').addEventListener('click', async ()=>{
      if (!confirm('Regenerar el QR de '+info.nombre+' (cedula '+info.cedula+')? Esto actualizará la columna TokenQR en la hoja de cálculo.')) return;
      loading(true, 'Regenerando QR del trabajador...');
      try {
        const nt = await GS.run('regenerarTokenQR', currentUser.cedula, info.cedula);
        info.token = nt;
        toast('✅ QR regenerado','success');
        close(); showQrModal(cedula);
        refreshUsersTable();
      } catch(e){ toast('❌ '+e.message,'error', 6000); loading(false); }
    });
    $('mdDownload').addEventListener('click', async ()=>{
      try {
        const pngData = imgMd.dataset.lastDataUrl || await generarQrDataURLRobusta(info.token, 560);
        _downloadUrl(pngData, `QR_${info.cedula}_${info.nombre.replace(/\s+/g,'_')}.png`);
        toast('✅ PNG descargado','success');
      } catch(e){ toast('❌ Error descarga: '+e.message,'error'); }
    });
    $('mdPrint').addEventListener('click', async ()=>{
      loading(true, 'Generando carnet...');
      try {
        const img = imgMd.dataset.lastDataUrl || await generarQrDataURLRobusta(info.token, 560);
        const w = window.open('','_blank','width=620,height=780');
        w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR ${esc(info.nombre)}</title>
        <style>body{font-family:Inter,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;background:#f1f5f9;margin:0;color:#0f172a}
        .card{background:white;padding:26px;border-radius:18px;box-shadow:0 20px 60px rgba(15,23,42,.2);max-width:400px;text-align:center;border:1px solid #e2e8f0}
        h1{font-size:16px;margin:0}.s{font-size:11px;color:#64748b;margin-top:2px}
        img{max-width:280px;display:block;margin:14px auto 8px;padding:10px;border:2px solid #e2e8f0;border-radius:14px;background:#fff}
        .nn{font-size:18px;font-weight:700}.cd{font-size:13px;color:#334155}
        .cc{font-family:monospace;background:#0f172a;color:#a5f3fc;padding:6px 10px;border-radius:7px;margin-top:10px;display:inline-block;font-size:12px;letter-spacing:1px}
        .ins{margin-top:12px;padding:10px;background:#ebf8ff;border-radius:10px;font-size:11.5px;color:#1e40af;border:1px solid #bfdbfe}</style></head>
        <body><div class="card">
        <h1>Conceptos Gráficos S.A.</h1>
        <div class="s">Carnet de Asistencia</div>
        <img src="${img}" alt="QR del empleado">
        <div class="nn">${esc(info.nombre)}</div>
        <div class="cd">CI. ${esc(info.cedula)}</div>
        <div class="cc">${esc(info.token)}</div>
        <div class="ins">Presenta este QR al llegar y retirarte de la empresa.</div>
        </div></body></html>`);
        w.document.close();
        setTimeout(()=>{w.focus();w.print();},650);
      } catch(e){ toast('❌ Error imprimir: '+e.message,'error');
      } finally { loading(false); }
    });
  } catch(e){ toast('❌ '+e.message,'error', 7000); }
  finally { loading(false); }
}

// ==========================================================
//  MISC
// ==========================================================
function downloadB64(b64, filename, mime){
  const bin = atob(b64);
  const arr = [];
  for (let i=0;i<bin.length;i+=512){
    const s = bin.slice(i,i+512); const u = new Uint8Array(s.length);
    for (let j=0;j<s.length;j++) u[j] = s.charCodeAt(j);
    arr.push(u);
  }
  const blob = new Blob(arr, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
// --- LOGIN + REGISTRO events ---
$('tabLoginMode').addEventListener('click', ()=>setLoginMode('login'));
$('tabRegMode').addEventListener('click', ()=>setLoginMode('reg'));
$('btnRegistrar').addEventListener('click', doRegistrar);
$('regForm').addEventListener('submit', e=>{ e.preventDefault(); doRegistrar(); });
$('btnLogin').addEventListener('click', doLogin);
$('loginForm').addEventListener('submit', e=>{ e.preventDefault(); doLogin(); });

// --- PANEL INFO HOJA DE CÁLCULO + SINCRONIZAR ---
function showDiagnostico(info){
  const estaConectado = info.ok && info.idCoincide;
  const estadoColor  = estaConectado ? 'color:#065f46' : 'color:#7f1d1d';
  const estadoIcono  = estaConectado ? '✅' : '🚨';
  const estadoTexto  = estaConectado ? 'CONECTADO CORRECTAMENTE' : 'FALLO DE CONEXIÓN (ver detalles abajo)';
  const ult = info.ultimoUsuario
    ? `<div style="padding:10px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;font-size:12px"><b>Último usuario guardado:</b><br>
       ・Fila #${info.ultimoUsuario.fila}<br>
       ・Cédula: <b>${esc(info.ultimoUsuario.cedula)}</b><br>
       ・Nombre: ${esc(info.ultimoUsuario.nombre)}<br>
       ・Cargo: ${esc(info.ultimoUsuario.cargo)}<br>
       ・Rol: ${esc(info.ultimoUsuario.rol)}<br>
       ・Fecha registro: ${esc(info.ultimoUsuario.fecha)}<br>
       ・Token QR generado: ${info.ultimoUsuario.token ? '<span style="color:#065f46;font-weight:700">SÍ</span>' : '<span style="color:#7f1d1d;font-weight:700">NO</span>'}
       </div>`
    : `<div style="padding:10px;background:#fef2f2;border-radius:10px;border:1px solid #fecaca;font-size:12px;color:#7f1d1d;font-weight:600">
       ⚠️ AÚN NO HAY USUARIOS GUARDADOS EN LA HOJA. Pulsa "Sincronizar / Reparar" o registra el primer usuario.
       </div>`;
  const encHtml = Array.isArray(info.encabezadosUsuarios)
    ? info.encabezadosUsuarios.map(c=>`<span style="display:inline-block;padding:3px 7px;border-radius:6px;background:#e2e8f0;color:#0f172a;margin:2px 2px 0 0;font-size:11px;font-weight:700">${esc(c)}</span>`).join('')
    : '';

  const html = `
    <div class="modal-backdrop" id="diagBackdrop">
      <div class="modal" style="max-width:680px">
        <div class="modal-head">
          <h3><span>🩺</span> Diagnóstico de Conexión con la Hoja</h3>
          <button class="modal-close" id="diagClose">✕</button>
        </div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto">
          <div style="padding:14px;border-radius:12px;background:${estaConectado?'#ecfdf5':'#fef2f2'};border:1.5px solid ${estaConectado?'#86efac':'#fca5a5'};margin-bottom:14px;display:flex;align-items:center;gap:12px">
            <div style="font-size:28px">${estadoIcono}</div>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:900;${estadoColor}">${estadoTexto}</div>
              <div style="font-size:11.5px;color:#475569;margin-top:3px">Fecha diagnóstico: ${new Date().toLocaleString()}</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
            <div class="diag-item"><div class="diag-lbl">ID Hoja (esperado)</div><div class="diag-val">${esc(info.idEsperado||'(no configurado, se crea hoja automática)')}</div></div>
            <div class="diag-item"><div class="diag-lbl">ID Hoja (real conectada)</div><div class="diag-val" style="${info.idCoincide?'color:#065f46':'color:#7f1d1d;font-weight:800'}">${esc(info.spreadsheetId)}</div></div>
            <div class="diag-item"><div class="diag-lbl">URL Hoja (abrir ↗)</div><div class="diag-val"><a href="${esc(info.spreadsheetUrl)}" target="_blank" rel="noopener" style="font-weight:700;color:#1d4ed8;text-decoration:underline;word-break:break-all">${esc(info.spreadsheetUrl)}</a></div></div>
            <div class="diag-item"><div class="diag-lbl">Zona horaria script</div><div class="diag-val">${esc(info.tz||'—')}</div></div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
            <div style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center">
              <div style="font-size:10.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px">Total usuarios</div>
              <div style="font-size:22px;font-weight:900;color:#0f2847;margin-top:2px">${info.totalUsuarios||0}</div>
            </div>
            <div style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center">
              <div style="font-size:10.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px">Registros asistencia</div>
              <div style="font-size:22px;font-weight:900;color:#0f2847;margin-top:2px">${info.totalRegistrosAsistencia||0}</div>
            </div>
            <div style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center">
              <div style="font-size:10.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px">Estructura Usuarios</div>
              <div style="font-size:22px;font-weight:900;color:${info.encabezadosUsuarios && info.encabezadosUsuarios.length>=7?'#065f46':'#7f1d1d'};margin-top:2px">${info.encabezadosUsuarios?info.encabezadosUsuarios.length+' cols':'—'}</div>
            </div>
          </div>

          <div style="margin-bottom:14px">
            <div style="font-size:12px;font-weight:800;color:#0f172a;margin-bottom:6px">📋 Encabezados reales pestaña "Usuarios"</div>
            ${encHtml || '<span style="color:#64748b;font-size:12px">(No se detectaron encabezados)</span>'}
          </div>

          ${ult}

          ${!estaConectado ? `
          <div style="padding:14px 16px;border-radius:12px;background:#fff7ed;border:1px solid #fdba74;margin-top:14px;font-size:12.5px;color:#7c2d12;line-height:1.7">
            <div style="font-weight:900;margin-bottom:6px;font-size:13px">🔥 SI NO COINCIDEN LOS IDs, HAZ ESTO:</div>
            1) Abre la hoja de cálculo con LA MISMA CUENTA GOOGLE con la que creaste el proyecto Apps Script.<br>
            2) Botón <b>Compartir</b> (arriba derecha) → agrega tu correo como <b>"Editor"</b> (no solo Visualizador / Comentarista).<br>
            3) Si la hoja la compartiste contigo desde otra cuenta → pide al propietario que te de permisos de Editor.<br>
            4) En el editor Apps Script guarda 💾 y vuelve a Desplegar nueva versión.<br>
            5) Si sigue fallando → <b>copia el ID del paso 2 del diagnostico</b> en SPREADSHEET_ID dentro Code.gs.
          </div>` : `
          <div style="padding:14px 16px;border-radius:12px;background:#f0fdf4;border:1px solid #86efac;margin-top:14px;font-size:12.5px;color:#064e3b;line-height:1.7">
            <div style="font-weight:900;margin-bottom:6px;font-size:13px">🎯 CONEXIÓN EXITOSA — tus datos se guardan aquí:</div>
            ✅ Cada usuario creado va a la pestaña <b>"Usuarios"</b> de esta hoja.<br>
            ✅ Cada marca de entrada / salida va a la pestaña <b>"Asistencia"</b>.<br>
            ✅ Si cierras sesión y vuelves a entrar, los usuarios <b>SÍ SE RECUERDAN</b> (ya no vuelven a desaparecer).<br>
            ✅ Cada QR generado es único por número de cédula y se guarda en columna F: <b>TokenQR</b>.
          </div>`}

          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button class="btn btn-secondary" id="diagClose2">Cerrar</button>
            <button class="btn btn-primary" id="diagSync">🔄 Sincronizar Ahora</button>
          </div>
        </div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
  const close = ()=>{ const d = $('diagBackdrop'); if (d) d.remove(); };
  $('diagClose').onclick = close;
  $('diagClose2').onclick = close;
  $('diagBackdrop').onclick = (e)=>{ if (e.target && e.target.id === 'diagBackdrop') close(); };
  $('diagSync').onclick = async ()=>{
    close();
    $('btnSyncSheet').click(); // dispara el flujo ya programado de sincronización
  };
}

document.addEventListener('click', async (e)=>{
  if (e.target && e.target.id === 'btnDiagnosticar') {
    loading(true, 'Ejecutando diagnóstico de conexión...');
    try {
      const info = await GS.run('getInfoSistema');
      showDiagnostico(info);
    } catch(err){
      // Incluso si falla, mostrar diagnóstico con el error
      showDiagnostico({
        ok: false,
        idEsperado: SPREADSHEET_ID_FALLBACK,
        idCoincide: false,
        spreadsheetId: '— ERROR —',
        spreadsheetUrl: '— NO CONECTADO —',
        sheetUsuarios: SHEET_USUARIOS_FALLBACK,
        sheetAsistencia: 'Asistencia',
        totalUsuarios: 0,
        totalRegistrosAsistencia: 0,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        encabezadosUsuarios: [],
        ultimoUsuario: null,
        error: err.message
      });
      toast('❌ Error de conexión detectado. Revisa el diagnóstico: '+err.message, 'error', 9000);
    } finally { loading(false); }
  }
  if (e.target && e.target.id === 'btnSyncSheet') {
    loading(true, 'Sincronizando estructura de la hoja de cálculo...');
    try {
      // Llamamos a getInfoSistema -> dispara getSpreadsheet_ -> ensureSheets_()
      // que repara pestañas, encabezados y genera tokens QR faltantes a usuarios antiguos.
      const info = await GS.run('getInfoSistema');
      $('sheetLinkUrl').href = info.spreadsheetUrl;
      $('sheetLinkUrl').textContent = info.spreadsheetUrl;
      aniNum($('sInfoUsers'), info.totalUsuarios||0);
      aniNum($('sInfoAsis'), info.totalRegistrosAsistencia||0);
      $('sInfoTz').textContent = info.tz || '—';
      // Refrescar también tarjetas y tablas
      refreshStats();
      refreshUserSelects();
      if (currentUser){
        await renderMyCard(true); // true = forzar regeneración del token desde el servidor
        if (currentUser.rol === 'ADMIN'){
          refreshUsersTable();
          refreshAsistencia();
        } else {
          refreshMyAsistencia();
        }
      }
      toast('✅ Estructura sincronizada. Los QRs faltantes han sido regenerados.', 'success', 5500);
      // Abrir la hoja para que el usuario confirme
      try { window.open(info.spreadsheetUrl, '_blank'); } catch(err){}
    } catch(err){
      toast('❌ No se pudo sincronizar: '+err.message, 'error', 7000);
    } finally { loading(false); }
  }
});
$('btnLogout').addEventListener('click', ()=>{
  stopScanner();
  clearSession();
  $('viewApp').classList.add('hidden');
  $('viewLogin').classList.remove('hidden');
  toast('Sesión cerrada correctamente','info');
});

// Auto-restore session on load + PRUEBA AUTOMÁTICA DE CONEXIÓN (solo en login, sin pulsar nada)
window.addEventListener('load', async ()=>{
  const s = getSession();
  if (s){ currentUser = s; enterApp(); return; }

  // ----- NO HAY SESIÓN: estamos en LOGIN. Correr prueba automática (SEATABLE o APPS SCRIPT) -----
  try {
    const cfg = (window.APP_CONFIG || {});
    const esSeatable = !!(cfg.SEATABLE && String(cfg.SEATABLE.APP_TOKEN||'').length>20 && String(cfg.SEATABLE.BASE_UUID||'').length>10);
    const errDiv = $('loginError');

    // ================ 🔝 MODO 1: SEATABLE DIRECTO (NUEVO) ================
    if (esSeatable) {
      try {
        seatableClearAuth();
        // 1. Prueba AUTH (obtener bearer token)
        await seatableAuth();
        // 2. Prueba LECTURA tablas
        const u = await seatableListAllRows(cfg.SEATABLE.TABLA_USUARIOS);
        await seatableListAllRows(cfg.SEATABLE.TABLA_ASISTENCIA);
        // 3. (Opcional) Si hay usuarios, toast OK sin login
        toast('✅ SEATABLE: Conexión establecida. Tablas OK ('+u.length+' usuarios). Puedes Iniciar Sesión o Regístrame.', 'success', 5500);
        if (errDiv && u.length === 0) {
          errDiv.style.display = 'block';
          errDiv.style.whiteSpace = 'normal';
          errDiv.innerHTML = 'ℹ️  <b>¡Conexión SEATABLE OK, pero tabla <code>'+esc(cfg.SEATABLE.TABLA_USUARIOS)+'</code> está VACÍA!</b><br>'
            + '• Opción 1: Pulsa <b style="color:#1d4ed8">+ Regístrame</b> y crea la primera cuenta con cédula <b>1234567890</b> (se convierte en ADMIN automáticamente).<br>'
            + '• Opción 2: O crea MANUALMENTE 1 fila en la tabla Usuarios desde SeaTable (Cedula 1234567890, Rol ADMIN, PIN 1234).';
        }
        return;
      } catch(errAutoSeatable){
        const emsg = String((errAutoSeatable && errAutoSeatable.message) ? errAutoSeatable.message : errAutoSeatable);
        const lines = [];
        lines.push('🚨 <b style="font-size:14px">PRUEBA AUTOMÁTICA SEATABLE: No hay conexión. Iniciar Sesión NO funcionará:</b>');
        lines.push('❌ Error detectado: '+esc(emsg));
        lines.push('🎯 <b>Las causas MÁS COMUNES (ordénalas así):</b>');
        lines.push('1️⃣ <b>NO CREASTE LAS 2 TABLAS:</b> en SeaTable falta <code>'+esc(cfg.SEATABLE.TABLA_USUARIOS)+'</code> (7 columnas) y/o <code>'+esc(cfg.SEATABLE.TABLA_ASISTENCIA)+'</code> (9 columnas). Sigue la guía de creación tablas.');
        lines.push('2️⃣ <b>API Token sin permiso Escritura:</b> en SeaTable → tu base → ⚙️ API Tokens → Edita el token → <b>Lectura y escritura</b>.');
        lines.push('3️⃣ <b>APP_TOKEN / BASE_UUID tienen espacios / errores:</b> copia y pega DE NUEVO ambos valores en CONFIG.js exactamente como aparecen en SeaTable.');
        lines.push('4️⃣ <b>URL SERVER mal:</b> usa <code>https://cloud.seatable.io</code> (sin barra al final). Si tienes plan Enterprise cambia por tu dominio.');
        lines.push('5️⃣ Firewall / antivirus bloquea <code>cloud.seatable.io</code>. Abre el servidor en pestaña nueva y confirma que carga.');
        lines.push('🟢 Pulsa el botón <b style="color:#b91c1c">🩺 Diagnosticar conexión</b> debajo del login para un diagnóstico PASO A PASO interactivo.');
        if (errDiv) { errDiv.style.display = 'block'; errDiv.style.whiteSpace='normal'; errDiv.innerHTML = lines.join('<br>'); }
        return;
      }
    }

    // ================ 🌐 MODO 2: GOOGLE APPS SCRIPT (anterior) ================
    const url = String(cfg.APPS_SCRIPT_URL || '').trim();
    if (!url) { return; }
    if (!/script\.google\.com.*\/exec$/i.test(url)) { return; }

    try {
      const postBody = JSON.stringify({ action:'login', args:['DIAGNOSTICO_AUTOMATICO','NO_OP'] });
      const r = await fetch(url, {
        method:'POST', mode:'cors',
        headers: { 'Content-Type':'application/json','Accept':'application/json' },
        body: postBody
      });
      if (r.ok) {
        const j = await r.json().catch(()=>({}));
        if (typeof j === 'object' && 'ok' in j) {
          toast('✅ Conexión establecida con Google Apps Script (CORS OK). Puedes iniciar sesión.', 'success', 4500);
          return;
        }
      }
    } catch(_errAuto){
      const lines = [];
      lines.push('🚨 <b style="font-size:14px">PRUEBA AUTOMÁTICA: El botón Iniciar Sesión NO FUNCIONARÁ a menos que arregles esto:</b>');
      lines.push('🔍 La URL de CONFIG.js detectada es:');
      lines.push('<code style="display:block;background:#f1f5f9;padding:8px 10px;border-radius:8px;margin:4px 0 6px 0;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all">'+esc(url)+'</code>');
      lines.push('🎯 <b>El error más probable: la implementación seleccionada NO tiene marcada la opción "Cualquiera"</b> en Apps Script → Gestionar Implementaciones.');
      lines.push('📝 Pasos a hacer YA:');
      lines.push('1️⃣ Abre Apps Script → menú <b>Implementar ▼ → Gestionar implementaciones</b>.');
      lines.push('2️⃣ Haz clic en la VERSIÓN ACTIVA DE ARRIBA (no las archivadas).');
      lines.push('3️⃣ Pulsa ✏️ Editar. Verifica:');
      lines.push('   · <b>Ejecutar como</b>: <b>Yo (tu cuenta Gmail)</b>');
      lines.push('   · <b>Usuarios con acceso</b>: <b>CUALQUIERA</b> (Anyone). ❌ NO "Cualquiera con cuenta Google".');
      lines.push('4️⃣ Pulsa <b>Implementar</b> (AZUL). Espera a que guarde.');
      lines.push('5️⃣ Copia la URL NUEVA del botón Copiar (no la archivada).');
      lines.push('6️⃣ Abre CONFIG.js en GitHub → ✏️ Editar → borra TODO y pega:');
      lines.push('<code style="display:block;background:#0f172a;color:#a5f3fc;padding:8px 10px;border-radius:8px;margin:4px 0;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all">window.APP_CONFIG = { APPS_SCRIPT_URL: \'PEGA-AQUI-LA-NUEVA-URL\' };</code>');
      lines.push('7️⃣ Commit changes en GitHub. Espera 1 minuto → Actions ✅ verde.');
      lines.push('8️⃣ <b>Cierra ESTA pestaña COMPLETAMENTE</b>, abre una nueva, pega tu URL de GitHub Pages AÑADIENDO al final: <code>?v=POST-AUTO-'+Date.now()+'</code>, pulsa Enter.');
      lines.push('🟢 Para ver el diagnóstico paso a paso interactivo, pulsa el botón <b style="color:#b91c1c">🩺 Diagnosticar conexión</b> debajo del login.');

      if (errDiv) {
        errDiv.style.display = 'block';
        errDiv.style.whiteSpace = 'normal';
        errDiv.innerHTML = lines.join('<br>');
      }
    }
  } catch(e){}
});
