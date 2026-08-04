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

// ---------- GOOGLE SCRIPT / FETCH WRAPPER (2 MODOs AUTODETECTADO) ----------
// Modo 1 = GitHub Pages / URL externa (APP_CONFIG.APPS_SCRIPT_URL configurada) → fetch doPost JSON
// Modo 2 = Apps Script híbrido (el HTML se sirve via doGet)              → google.script.run normal
const GS = {
  run(name, ...args){
    const cfg = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : {};
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
            // ---- DIAGNOSTICO ULTRA-ESPECIFICO PARA ERRORES COMUNES ----
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

    // Fallback a google.script.run cuando el frontend sigue viviendo dentro de Apps Script
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
  loading(true, 'Diagnosticando conexión con Google Apps Script...');
  const lines = [];
  try {
    const cfg = (window.APP_CONFIG || {});
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

// Auto-restore session on load + PRUEBA POST AUTOMÁTICA DE CONEXIÓN (solo en login)
window.addEventListener('load', async ()=>{
  const s = getSession();
  if (s){ currentUser = s; enterApp(); return; }

  // ----- NO HAY SESIÓN: estamos en LOGIN. Correr prueba POST automáticamente -----
  try {
    const cfg = (window.APP_CONFIG || {});
    const url = String(cfg.APPS_SCRIPT_URL || '').trim();
    const errDiv = $('loginError');
    if (!url) { return; } // el banner de index.html ya le avisó que no tiene URL
    if (!/script\.google\.com.*\/exec$/i.test(url)) { return; } // banner también avisó

    // Hacemos un POST de PRUEBA (misma petición que hará doLogin pero sin mostrar errores
    // al usuario, solo si FALLA mostramos el diagnóstico paso a paso en loginError)
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
          // CORS funciona! El backend respondió JSON. Login funcionará
          toast('✅ Conexión establecida con Google Apps Script (CORS OK). Puedes iniciar sesión.', 'success', 4500);
          return;
        }
      }
    } catch(_errAuto){
      // Falló el POST automático: mostramos el diagnóstico DETALLADO DIRECTAMENTE EN LA TARJETA ROJA
      // (mandamos al usuario al diagnóstico completo con solo dar clic)
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