'use strict';
/* CHORILAB · Tarjetas de regalo
 * Base de datos cifrada en el navegador (AES-GCM 256) y guardada en Supabase como versiones.
 * - Una clave de datos aleatoria (DEK) cifra toda la base.
 * - Cada usuario tiene la DEK "envuelta" con una clave derivada de su contraseña (PBKDF2-SHA256).
 */
(() => {
const CFG = window.CHORILAB_CONFIG || {};
const BASE = String(CFG.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = String(CFG.SUPABASE_ANON_KEY || '');
const configured = /^https:\/\/.+/.test(BASE) && !/TU-PROYECTO/i.test(BASE) && ANON && !/TU_CLAVE/i.test(ANON);
const API = BASE + '/rest/v1/vault';
const HDR = {apikey: ANON};
if (ANON.startsWith('eyJ')) HDR.Authorization = 'Bearer ' + ANON;
const ITER = 600000, MINPASS = 8, POLL_MS = 15000;

/* ===================== Utilidades ===================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COP = n => new Intl.NumberFormat('es-CO', {style:'currency', currency:'COP', maximumFractionDigits:0}).format(n || 0);
const fdate = t => new Date(t).toLocaleString('es-CO', {dateStyle:'medium', timeStyle:'short'});
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }

/* ===================== Criptografía ===================== */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

async function deriveKek(pass, salt) {
  const m = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:ITER, hash:'SHA-256'}, m, {name:'AES-GCM', length:256}, false, ['encrypt', 'decrypt']);
}
async function aesEnc(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {iv: b64(iv), ct: b64(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, bytes))};
}
const aesDec = (key, o) => crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(o.iv)}, key, unb64(o.ct));
async function wrap(pass, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const e = await aesEnc(await deriveKek(pass, salt), enc.encode(JSON.stringify(payload)));
  return {salt: b64(salt), iv: e.iv, ct: e.ct};
}
async function unwrap(pass, w) { return JSON.parse(dec.decode(await aesDec(await deriveKek(pass, unb64(w.salt)), w))); }
const importDek = raw => crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function userHash(user) { return hex(await crypto.subtle.digest('SHA-256', enc.encode('chorilab|' + String(user).trim().toLowerCase()))); }
async function encryptRow(users, db) { return {v:1, users, ...(await aesEnc(S.dek, enc.encode(JSON.stringify(db))))}; }
async function decryptDb(data) { return JSON.parse(dec.decode(await aesDec(S.dek, data))); }

/* ===================== Acceso remoto (Supabase) ===================== */
async function fetchLatest() {
  const r = await fetch(API + '?select=rev,data&order=rev.desc&limit=1', {headers:HDR, cache:'no-store'});
  if (!r.ok) throw new Error('No se pudo conectar con la base de datos (' + r.status + ')');
  return (await r.json())[0] || null;
}
async function insertRev(rev, data) {
  const r = await fetch(API, {method:'POST', headers:{...HDR, 'Content-Type':'application/json', Prefer:'return=minimal'}, body:JSON.stringify({rev, data})});
  if (r.status === 409) return false; // otra persona guardó antes
  if (!r.ok) throw new Error('No se pudo guardar (' + r.status + ')');
  return true;
}

/* ===================== Estado ===================== */
const defaults = () => ({
  settings: {
    bank: 'Transferencia a Nequi / Bancolombia: (escribe aquí tus datos de pago)',
    cash: 'Pago en efectivo directamente en CHORILAB.'
  },
  products: [
    {id:'c4', cat:'Combos para la casa', name:'Choripán x4', price:30000},
    {id:'c6', cat:'Combos para la casa', name:'Choripán x6', price:45000},
    {id:'r1', cat:'Combos en el restaurante', name:'Combo Personal', price:18000},
    {id:'r2', cat:'Combos en el restaurante', name:'Combo Pareja', price:34000},
    {id:'r3', cat:'Combos en el restaurante', name:'Combo Trío', price:48000},
    {id:'r4', cat:'Combos en el restaurante', name:'Combo Parche', price:80000},
    {id:'r5', cat:'Combos en el restaurante', name:'Combo Familiar', price:110000},
    {id:'b1', cat:'Bebidas', name:'Gaseosa', price:5000},
    {id:'b2', cat:'Bebidas', name:'Jugo natural', price:7000},
    {id:'b3', cat:'Bebidas', name:'Cerveza', price:8000}
  ],
  clients: [],
  tx: []
});
let S = {rev:0, users:{}, db:null, dek:null, kb64:null, me:null};
const ui = {view:'loading', tab:'resumen', filter:'todas', q:'', busy:false, dirty:false, error:''};

const client = id => S.db.clients.find(c => c.id === id);
const balance = id => S.db.tx.filter(t => t.clientId === id && t.status === 'confirmada').reduce((s, t) => s + (t.type === 'recharge' ? t.amount : -t.amount), 0);
const reserved = id => S.db.tx.filter(t => t.clientId === id && t.status === 'pendiente' && t.type === 'use').reduce((s, t) => s + t.amount, 0);
const pending = id => S.db.tx.filter(t => t.clientId === id && t.status === 'pendiente');
const methodName = m => m === 'transferencia' ? 'Transferencia' : m === 'efectivo' ? 'Efectivo' : '—';
function newCardNo(db) {
  let n; do { n = 'CHOR-' + [0,1,2].map(() => String(Math.floor(Math.random() * 10000)).padStart(4, '0')).join('-'); } while (db.clients.some(c => c.cardNo === n));
  return n;
}

/* Aplica un cambio sobre la última versión y la guarda; reintenta si hubo conflicto. Devuelve texto de error o null. */
async function mutate(fn) {
  for (let i = 0; i < 6; i++) {
    const st = {users: structuredClone(S.users), db: structuredClone(S.db)};
    const res = await fn(st);
    if (typeof res === 'string') return res;
    const row = await encryptRow(st.users, st.db);
    if (await insertRev(S.rev + 1, row)) { S.rev++; S.users = st.users; S.db = st.db; return null; }
    await refresh();
  }
  return 'No se pudo guardar por conflicto con otro cambio. Inténtalo de nuevo.';
}

async function refresh() {
  const row = await fetchLatest();
  if (!row || row.rev <= S.rev) return false;
  const db = await decryptDb(row.data);
  S.rev = row.rev; S.users = row.data.users; S.db = db;
  if (!S.users[S.me.idh] || (S.me.role === 'client' && !client(S.me.cid))) { logout('Tu acceso fue eliminado.'); return false; }
  return true;
}

/* ===================== Arranque y sesión ===================== */
async function boot() {
  if (!configured) { ui.view = 'noconfig'; return render(); }
  ui.view = 'loading'; render();
  try { ui.view = (await fetchLatest()) ? 'login' : 'setup'; ui.error = ''; }
  catch (e) { ui.view = 'error'; ui.error = e.message; }
  render();
}
function logout(msg) {
  clearInterval(startPolling.t);
  S = {rev:0, users:{}, db:null, dek:null, kb64:null, me:null};
  ui.view = 'login'; ui.tab = 'resumen'; ui.q = ''; closeModal(); render();
  if (msg) toast(msg);
}
function startPolling() {
  clearInterval(startPolling.t);
  startPolling.t = setInterval(async () => {
    if (ui.view !== 'app' || ui.busy || document.hidden) return;
    try { if (await refresh()) ui.dirty = true; } catch (e) { return; }
    if (ui.dirty && canRerender()) { ui.dirty = false; render(); }
  }, POLL_MS);
}
function canRerender() { const a = document.activeElement; return !$('#modal').innerHTML && !(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)); }

/* ===================== Vistas ===================== */
function render() {
  const v = {
    loading: () => `<main><div class="login card"><h2 style="text-align:center">Cargando…</h2></div></main>`,
    noconfig: noconfigView, error: errorView, setup: setupView, login: loginView
  }[ui.view];
  if (v) { $('#app').innerHTML = v(); return; }
  if (ui.view === 'app') {
    if (S.me.role === 'client' && !client(S.me.cid)) return logout('Tu acceso fue eliminado.');
    $('#app').innerHTML = S.me.role === 'admin' ? adminView() : clientView();
  }
}

function topbar(label) {
  return `<header class="top"><div class="brand">🌭 CHORILAB<small>Tarjetas de regalo</small></div>
  <div class="who"><span>${esc(label)}</span><button class="btn ghost sm" data-act="reload">↻ Actualizar</button><button class="btn ghost sm" data-act="logout">Salir</button></div></header>`;
}
function noconfigView() {
  return `<main><div class="login card"><h2>Falta configurar</h2>
    <p>Edita el archivo <b>config.js</b> con la URL y la clave de tu proyecto de Supabase y vuelve a subirlo. Sigue el README.</p></div></main>`;
}
function errorView() {
  return `<main><div class="login card"><h2>Sin conexión</h2><div class="err">${esc(ui.error)}</div>
    <button class="btn cel" data-act="boot">Reintentar</button></div></main>`;
}
function setupView() {
  return `<main><div class="login card"><h2 style="text-align:center">Crear la base de datos</h2>
    <p class="muted">La base está vacía. Crea la cuenta de administrador: su clave protege el cifrado de todo. <b>Si la pierdes, los datos no se pueden recuperar.</b></p>
    <form data-form="setup"><label>Usuario administrador</label><input name="user" autocomplete="username" required>
    <label>Clave (mín. ${MINPASS} caracteres)</label><input name="pass" type="password" minlength="${MINPASS}" autocomplete="new-password" required>
    <label>Repite la clave</label><input name="pass2" type="password" minlength="${MINPASS}" autocomplete="new-password" required>
    <button class="btn gold" style="width:100%;margin-top:14px">Crear y cifrar</button></form></div></main>`;
}
function loginView() {
  return `<main><div class="login card"><h2 style="text-align:center">Bienvenido a CHORILAB</h2>
    <form data-form="login"><label>Usuario</label><input name="user" autocomplete="username" required autofocus>
    <label>Clave</label><input name="pass" type="password" autocomplete="current-password" required>
    <button class="btn cel" style="width:100%;margin-top:14px">Entrar</button></form>
    <div class="hint">Clientes: tu usuario y clave te los entrega CHORILAB al crear tu tarjeta.</div></div></main>`;
}

/* ---------- Admin ---------- */
function adminView() {
  const tabs = [['resumen','Resumen'],['clientes','Clientes'],['movimientos','Movimientos'],['productos','Productos'],['ajustes','Ajustes']];
  const body = {resumen:adminResumen, clientes:adminClientes, movimientos:adminMov, productos:adminProductos, ajustes:adminAjustes}[ui.tab]();
  return topbar('Administrador') + `<main>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.tab===k?'on':''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>${body}</main>`;
}
function adminResumen() {
  const conf = S.db.tx.filter(t => t.status === 'confirmada');
  const rec = conf.filter(t => t.type === 'recharge').reduce((s, t) => s + t.amount, 0);
  const use = conf.filter(t => t.type === 'use').reduce((s, t) => s + t.amount, 0);
  const pend = S.db.tx.filter(t => t.status === 'pendiente').length;
  const tr = conf.filter(t => t.type === 'recharge' && t.method === 'transferencia').reduce((s, t) => s + t.amount, 0);
  const latest = [...S.db.tx].sort((a, b) => b.created - a.created).slice(0, 6);
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Clientes</span><b>${S.db.clients.length}</b></div>
    <div class="stat"><span>Saldo total en tarjetas</span><b>${COP(rec - use)}</b></div>
    <div class="stat"><span>Recargas confirmadas</span><b>${COP(rec)}</b><span>Transf. ${COP(tr)} · Efectivo ${COP(rec - tr)}</span></div>
    <div class="stat"><span>Consumos confirmados</span><b>${COP(use)}</b></div>
    <div class="stat"><span>Esperando confirmación</span><b>${pend}</b></div></div>
    <div class="card"><h3>Últimos movimientos</h3>${txTable(latest, 'admin')}</div>`;
}
function adminClientes() {
  const q = ui.q.toLowerCase();
  const list = S.db.clients.filter(c => !q || (c.name + c.user + c.phone + c.cardNo).toLowerCase().includes(q));
  return `<div class="card"><h3>Crear cliente</h3>
    <form data-form="newclient"><div class="row">
      <div><label>Nombre completo</label><input name="name" required></div>
      <div><label>Teléfono</label><input name="phone" inputmode="tel"></div></div>
      <div class="row"><div><label>Usuario</label><input name="user" required autocomplete="off"></div>
      <div><label>Clave inicial (mín. ${MINPASS})</label><input name="pass" required minlength="${MINPASS}" autocomplete="off"></div>
      <div class="fit"><button class="btn gold">Crear tarjeta</button></div></div></form></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2">Clientes (${list.length})</h3>
      <input data-search placeholder="Buscar por nombre, usuario o tarjeta" value="${esc(ui.q)}"></div>
      ${list.length ? `<div class="tw"><table><thead><tr><th>Cliente</th><th>Tarjeta</th><th>Saldo</th><th>Pend.</th><th></th></tr></thead><tbody>
      ${list.map(c => `<tr><td><b>${esc(c.name)}</b><br><span class="muted">@${esc(c.user)} ${c.phone ? '· ' + esc(c.phone) : ''}</span></td>
        <td class="muted">${esc(c.cardNo)}</td><td><b>${COP(balance(c.id))}</b></td><td>${pending(c.id).length}</td>
        <td style="white-space:nowrap"><button class="btn sm ok" data-act="recharge" data-id="${c.id}">Recargar</button>
        <button class="btn sm cel" data-act="use" data-id="${c.id}">Consumo</button>
        <button class="btn sm ghost" data-act="detail" data-id="${c.id}">Ver</button>
        <button class="btn sm ghost" data-act="delclient" data-id="${c.id}" aria-label="Eliminar">🗑</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Aún no hay clientes.</div>'}</div>`;
}
function adminMov() {
  const list = S.db.tx.filter(t => ui.filter === 'todas' || t.status === ui.filter).sort((a, b) => b.created - a.created);
  return `<div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2">Movimientos</h3>
    <select data-filter>${['todas','pendiente','confirmada','rechazada','anulada'].map(s => `<option value="${s}" ${ui.filter===s?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></div>
    ${txTable(list, 'admin')}</div>`;
}
function adminProductos() {
  const cats = [...new Set(S.db.products.map(p => p.cat))];
  return `<div class="card"><h3>Productos de CHORILAB</h3>
    <p class="muted">Se usan al registrar consumos. Ajusta nombres y precios cuando lo necesites.</p>
    ${S.db.products.map(p => `<form data-form="prod" data-id="${p.id}" class="row" style="margin-bottom:6px">
      <div><input name="cat" value="${esc(p.cat)}" list="cats" aria-label="Categoría"></div>
      <div style="flex:2"><input name="name" value="${esc(p.name)}" required aria-label="Nombre"></div>
      <div><input name="price" type="number" min="0" step="500" value="${p.price}" required aria-label="Precio"></div>
      <div class="fit"><button class="btn sm cel">Guardar</button> <button type="button" class="btn sm ghost" data-act="delprod" data-id="${p.id}" aria-label="Eliminar">🗑</button></div></form>`).join('')}
    <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="card"><h3>Agregar producto</h3><form data-form="newprod" class="row">
      <div><label>Categoría</label><input name="cat" list="cats" required></div>
      <div style="flex:2"><label>Nombre</label><input name="name" required></div>
      <div><label>Precio</label><input name="price" type="number" min="0" step="500" required></div>
      <div class="fit"><button class="btn gold">Agregar</button></div></form></div>`;
}
function adminAjustes() {
  return `<div class="card"><h3>Métodos de pago</h3><form data-form="settings">
      <label>Instrucciones de transferencia (se muestran al recargar)</label><textarea name="bank" rows="2">${esc(S.db.settings.bank)}</textarea>
      <label>Instrucciones de efectivo</label><textarea name="cash" rows="2">${esc(S.db.settings.cash)}</textarea>
      <button class="btn cel" style="margin-top:10px">Guardar</button></form></div>
    <div class="card"><h3>Mi clave de administrador</h3><form data-form="mypass" class="row">
      <div><label>Clave actual</label><input type="password" name="old" required autocomplete="current-password"></div>
      <div><label>Nueva clave (mín. ${MINPASS})</label><input type="password" name="new" minlength="${MINPASS}" required autocomplete="new-password"></div>
      <div class="fit"><button class="btn cel">Cambiar</button></div></form></div>
    <div class="card"><h3>Copia de seguridad (cifrada)</h3>
      <p class="muted">Descarga una copia con frecuencia. El archivo está cifrado: solo se abre con las mismas claves.</p>
      <button class="btn gold" data-act="export">Descargar copia</button>
      <label class="btn ghost" style="display:inline-block;margin:0 0 0 6px;cursor:pointer">Restaurar copia<input type="file" accept=".json" data-import hidden></label></div>`;
}

/* ---------- Cliente ---------- */
function cardHTML(c) {
  return `<div class="gcard"><div class="t"><b>CHORILAB</b><span>Tarjeta de regalo</span></div>
    <div class="lbl" style="margin-top:22px">Saldo disponible</div><div class="bal" style="margin-top:2px">${COP(balance(c.id))}</div>
    <div class="num">${esc(c.cardNo)}</div><div class="nm">${esc(c.name)}</div></div>`;
}
function clientView() {
  const c = client(S.me.cid);
  const pend = pending(c.id);
  const hist = S.db.tx.filter(t => t.clientId === c.id && t.status !== 'pendiente').sort((a, b) => b.created - a.created);
  return topbar(c.name) + `<main><div class="grid g2" style="align-items:start">
    <div>${cardHTML(c)}${reserved(c.id) ? `<p class="muted">Hay ${COP(reserved(c.id))} pendientes de confirmar en consumos.</p>` : ''}</div>
    <div class="card"><h3>Por confirmar (${pend.length})</h3>
      <p class="muted">Cada recarga y cada uso de tu tarjeta necesita tu confirmación.</p>
      ${pend.length ? pend.map(t => `<div class="card pend" style="margin:8px 0;padding:12px">
        <div><span class="badge b-${t.type}">${t.type==='recharge'?'Recarga':'Consumo'}</span> <b>${COP(t.amount)}</b></div>
        <div class="muted">${fdate(t.created)}${t.type==='recharge' ? ' · ' + methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : ''}</div>
        ${t.items ? `<div class="muted">${t.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>` : ''}
        ${t.note ? `<div class="muted">Nota: ${esc(t.note)}</div>` : ''}
        <div style="margin-top:8px"><button class="btn sm ok" data-act="confirm" data-id="${t.id}">Revisar y confirmar</button></div></div>`).join('') : '<div class="empty">Nada pendiente ✅</div>'}</div></div>
    <div class="card"><h3>Mi historial</h3>${txTable(hist, 'client')}</div>
    <div class="card"><h3>Cambiar mi clave</h3><form data-form="mypass" class="row">
      <div><label>Clave actual</label><input type="password" name="old" required autocomplete="current-password"></div>
      <div><label>Nueva clave (mín. ${MINPASS})</label><input type="password" name="new" minlength="${MINPASS}" required autocomplete="new-password"></div>
      <div class="fit"><button class="btn cel">Cambiar</button></div></form></div></main>`;
}

function txTable(list, role) {
  if (!list.length) return '<div class="empty">Sin movimientos.</div>';
  return `<div class="tw"><table><thead><tr><th>Fecha</th>${role==='admin'?'<th>Cliente</th>':''}<th>Tipo</th><th>Detalle</th><th>Monto</th><th>Estado</th>${role==='admin'?'<th></th>':''}</tr></thead><tbody>
  ${list.map(t => {
    const c = client(t.clientId);
    const det = t.type === 'recharge' ? methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : (t.items || []).map(i => `${i.qty}× ${esc(i.name)}`).join(', ');
    return `<tr><td class="muted">${fdate(t.created)}</td>${role==='admin'?`<td>${c ? esc(c.name) : '<i>eliminado</i>'}</td>`:''}
      <td><span class="badge b-${t.type}">${t.type==='recharge'?'Recarga':'Consumo'}</span></td>
      <td class="muted">${det}${t.note ? '<br>' + esc(t.note) : ''}</td>
      <td class="${t.type==='recharge'?'pos':'neg'}">${t.type==='recharge'?'+':'−'}${COP(t.amount)}</td>
      <td><span class="badge b-${t.status}">${t.status}</span></td>
      ${role==='admin'?`<td>${t.status==='pendiente'?`<button class="btn sm ghost" data-act="cancel" data-id="${t.id}">Anular</button>`:''}</td>`:''}</tr>`;
  }).join('')}</tbody></table></div>`;
}

/* ===================== Modales ===================== */
function modal(title, body) {
  $('#modal').innerHTML = `<div class="ov"><div class="md" role="dialog" aria-modal="true"><div class="mh"><h3>${title}</h3><button class="x" data-act="close" aria-label="Cerrar">✕</button></div>${body}</div></div>`;
}
const closeModal = () => { $('#modal').innerHTML = ''; };

function openRecharge(id) {
  const c = client(id);
  modal('Recargar a ' + esc(c.name), `<form data-form="recharge" data-id="${id}">
    <label>Monto de la recarga (COP)</label><input name="amount" type="number" min="1000" step="500" required>
    <div class="chips">${[20000,50000,100000,200000].map(v => `<button type="button" class="btn sm ghost" data-act="amt" data-v="${v}">${COP(v)}</button>`).join('')}</div>
    <label>Método de pago</label>
    <div class="radio"><label><input type="radio" name="method" value="efectivo" checked> 💵 Efectivo</label>
    <label><input type="radio" name="method" value="transferencia"> 🏦 Transferencia</label></div>
    <div class="hint" id="payhint">${esc(S.db.settings.cash)}</div>
    <div id="refbox" hidden><label>Referencia / comprobante de la transferencia</label><input name="ref"></div>
    <label>Nota (opcional)</label><input name="note">
    <p class="muted">El saldo se acredita cuando el cliente confirme la recarga desde su cuenta.</p>
    <button class="btn ok" style="width:100%">Enviar recarga al cliente</button></form>`);
}
function openUse(id) {
  const c = client(id);
  const avail = balance(id) - reserved(id);
  const cats = [...new Set(S.db.products.map(p => p.cat))];
  modal('Consumo de ' + esc(c.name), `<form data-form="use" data-id="${id}">
    <div class="hint">Saldo disponible: <b>${COP(avail)}</b></div>
    ${cats.map(cat => `<div class="cat">${esc(cat)}</div>${S.db.products.filter(p => p.cat === cat).map(p =>
      `<div class="prow"><div class="n">${esc(p.name)}<div class="muted">${COP(p.price)}</div></div>
      <input class="qty" type="number" min="0" value="0" name="q_${p.id}" data-price="${p.price}" aria-label="Cantidad ${esc(p.name)}"></div>`).join('')}`).join('')}
    <label>Nota (opcional, ej. mesa o pedido)</label><input name="note">
    <div class="total">Total: <span id="tot">${COP(0)}</span></div>
    <p class="muted">El descuento se aplica cuando el cliente confirme el uso desde su cuenta.</p>
    <button class="btn cel" style="width:100%">Enviar consumo al cliente</button></form>`);
}
function openDetail(id) {
  const c = client(id);
  const list = S.db.tx.filter(t => t.clientId === id).sort((a, b) => b.created - a.created);
  modal(esc(c.name), `${cardHTML(c)}<p class="muted">Usuario: @${esc(c.user)} ${c.phone ? '· Tel: ' + esc(c.phone) : ''}</p>
    <div style="margin-top:8px">${txTable(list, 'client')}</div>
    <form data-form="resetpass" data-id="${id}" class="row" style="margin-top:10px"><div><label>Restablecer clave del cliente</label><input name="new" minlength="${MINPASS}" required placeholder="Nueva clave"></div>
    <div class="fit"><button class="btn sm cel">Guardar</button></div></form>`);
}
function openConfirm(id) {
  const t = S.db.tx.find(x => x.id === id);
  if (!t || t.status !== 'pendiente') return;
  modal(t.type === 'recharge' ? 'Confirmar recarga' : 'Confirmar uso de tu tarjeta', `<form data-form="confirm" data-id="${id}">
    <div class="total" style="text-align:left">${t.type==='recharge'?'+':'−'}${COP(t.amount)}</div>
    <p class="muted">${t.type==='recharge' ? 'Método: ' + methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : (t.items || []).map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</p>
    ${t.note ? `<p class="muted">Nota: ${esc(t.note)}</p>` : ''}
    <label>Escribe tu clave para confirmar</label><input type="password" name="pass" autocomplete="current-password" required>
    <div class="row" style="margin-top:12px"><button class="btn ok">Confirmar</button>
    <button type="button" class="btn red" data-act="reject" data-id="${id}">Rechazar</button></div></form>`);
}

/* ===================== Acciones ===================== */
async function setStatus(id, status, onlyType) {
  const err = await mutate(st => {
    const t = st.db.tx.find(x => x.id === id);
    if (!t || t.status !== 'pendiente') return 'Este movimiento ya no está pendiente';
    t.status = status; t.resolved = Date.now();
  });
  if (err) { toast(err); return false; }
  return true;
}
const checkPass = async pass => { try { await unwrap(pass, S.users[S.me.idh]); return true; } catch (e) { return false; } };

const forms = {
  async setup(f, d) {
    const user = d.get('user').trim(), pass = d.get('pass');
    if (!user) return toast('Escribe un usuario');
    if (pass.length < MINPASS) return toast('La clave debe tener al menos ' + MINPASS + ' caracteres');
    if (pass !== d.get('pass2')) return toast('Las claves no coinciden');
    const raw = b64(crypto.getRandomValues(new Uint8Array(32)));
    S.dek = await importDek(raw);
    const idh = await userHash(user);
    const users = {[idh]: await wrap(pass, {k:raw, role:'admin'})};
    const ok = await insertRev(1, await encryptRow(users, defaults()));
    S.dek = null;
    if (!ok) { toast('La base ya había sido creada'); return boot(); }
    ui.view = 'login'; render(); toast('Base creada y cifrada. Ahora inicia sesión.');
  },
  async login(f, d) {
    const row = await fetchLatest();
    if (!row) return boot();
    const idh = await userHash(d.get('user'));
    const w = row.data.users && row.data.users[idh];
    let p;
    try { if (!w) throw 0; p = await unwrap(d.get('pass'), w); } catch (e) { return toast('Usuario o clave incorrectos'); }
    S.dek = await importDek(p.k); S.kb64 = p.k;
    try { S.db = await decryptDb(row.data); } catch (e) { S.dek = null; return toast('No se pudo descifrar la base de datos'); }
    S.rev = row.rev; S.users = row.data.users; S.me = {role:p.role, cid:p.cid, idh};
    ui.view = 'app'; ui.tab = 'resumen'; ui.q = ''; startPolling(); render();
  },
  async newclient(f, d) {
    const name = d.get('name').trim(), phone = d.get('phone').trim(), user = d.get('user').trim(), pass = d.get('pass');
    if (!name || !user) return toast('Completa nombre y usuario');
    if (pass.length < MINPASS) return toast('La clave debe tener al menos ' + MINPASS + ' caracteres');
    const idh = await userHash(user), cid = uid();
    const w = await wrap(pass, {k:S.kb64, role:'client', cid});
    const err = await mutate(st => {
      if (st.users[idh]) return 'Ese usuario ya existe';
      st.users[idh] = w;
      st.db.clients.push({id:cid, name, phone, user, cardNo:newCardNo(st.db), created:Date.now()});
    });
    if (err) return toast(err);
    render(); toast('Cliente creado. Entrégale su usuario y clave.');
  },
  async recharge(f, d) {
    const amount = Math.round(+d.get('amount')), method = d.get('method'), ref = (d.get('ref') || '').trim();
    if (!(amount > 0)) return toast('Monto inválido');
    if (method === 'transferencia' && !ref) return toast('Indica la referencia de la transferencia');
    const err = await mutate(st => {
      if (!st.db.clients.some(c => c.id === f.dataset.id)) return 'El cliente ya no existe';
      st.db.tx.push({id:uid(), clientId:f.dataset.id, type:'recharge', amount, method, ref, note:d.get('note').trim(), status:'pendiente', created:Date.now()});
    });
    if (err) return toast(err);
    closeModal(); render(); toast('Recarga enviada: queda pendiente de confirmación del cliente');
  },
  async use(f, d) {
    const id = f.dataset.id, items = []; let total = 0;
    S.db.products.forEach(p => { const q = Math.floor(+d.get('q_' + p.id) || 0); if (q > 0) { items.push({id:p.id, name:p.name, qty:q, price:p.price}); total += q * p.price; } });
    if (!items.length) return toast('Selecciona al menos un producto');
    const err = await mutate(st => {
      const bal = st.db.tx.filter(t => t.clientId === id && t.status === 'confirmada').reduce((s, t) => s + (t.type === 'recharge' ? t.amount : -t.amount), 0);
      const res = st.db.tx.filter(t => t.clientId === id && t.status === 'pendiente' && t.type === 'use').reduce((s, t) => s + t.amount, 0);
      if (total > bal - res) return 'Saldo insuficiente para este consumo';
      st.db.tx.push({id:uid(), clientId:id, type:'use', amount:total, items, note:d.get('note').trim(), status:'pendiente', created:Date.now()});
    });
    if (err) return toast(err);
    closeModal(); render(); toast('Consumo enviado: queda pendiente de confirmación del cliente');
  },
  async confirm(f, d) {
    const id = f.dataset.id;
    if (!(await checkPass(d.get('pass') || ''))) return toast('Clave incorrecta');
    const err = await mutate(st => {
      const t = st.db.tx.find(x => x.id === id && x.clientId === S.me.cid);
      if (!t || t.status !== 'pendiente') return 'Este movimiento ya no está pendiente';
      if (t.type === 'use') {
        const bal = st.db.tx.filter(x => x.clientId === t.clientId && x.status === 'confirmada').reduce((s, x) => s + (x.type === 'recharge' ? x.amount : -x.amount), 0);
        if (t.amount > bal) return 'Saldo insuficiente';
      }
      t.status = 'confirmada'; t.resolved = Date.now();
    });
    if (err) return toast(err);
    closeModal(); render(); toast('Movimiento confirmado ✅');
  },
  async prod(f, d) {
    const err = await mutate(st => {
      const p = st.db.products.find(x => x.id === f.dataset.id); if (!p) return 'Producto no encontrado';
      p.cat = d.get('cat').trim(); p.name = d.get('name').trim(); p.price = Math.max(0, Math.round(+d.get('price')));
    });
    toast(err || 'Producto actualizado');
  },
  async newprod(f, d) {
    const err = await mutate(st => { st.db.products.push({id:uid(), cat:d.get('cat').trim(), name:d.get('name').trim(), price:Math.max(0, Math.round(+d.get('price')))}); });
    if (err) return toast(err);
    render(); toast('Producto agregado');
  },
  async settings(f, d) {
    const err = await mutate(st => { st.db.settings.bank = d.get('bank').trim(); st.db.settings.cash = d.get('cash').trim(); });
    toast(err || 'Ajustes guardados');
  },
  async mypass(f, d) {
    const np = d.get('new');
    if (np.length < MINPASS) return toast('La clave debe tener al menos ' + MINPASS + ' caracteres');
    if (!(await checkPass(d.get('old')))) return toast('La clave actual no coincide');
    const w = await wrap(np, {k:S.kb64, role:S.me.role, cid:S.me.cid});
    const err = await mutate(st => { st.users[S.me.idh] = w; });
    if (err) return toast(err);
    f.reset(); toast('Clave actualizada');
  },
  async resetpass(f, d) {
    const c = client(f.dataset.id); if (!c) return;
    if (d.get('new').length < MINPASS) return toast('La clave debe tener al menos ' + MINPASS + ' caracteres');
    const idh = await userHash(c.user);
    const w = await wrap(d.get('new'), {k:S.kb64, role:'client', cid:c.id});
    const err = await mutate(st => { st.users[idh] = w; });
    if (err) return toast(err);
    closeModal(); toast('Clave del cliente restablecida');
  }
};

/* ===================== Eventos ===================== */
async function run(fn) {
  if (ui.busy) return;
  ui.busy = true; document.body.classList.add('busy');
  try { await fn(); } catch (err) { console.error(err); toast('Error: ' + (err.message || err)); }
  finally { ui.busy = false; document.body.classList.remove('busy'); }
}

document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault(); const fn = forms[f.dataset.form];
  if (fn) run(() => fn(f, new FormData(f)));
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('ov')) return closeModal();
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'close') closeModal();
  else if (a === 'boot') boot();
  else if (a === 'logout') logout();
  else if (a === 'reload') run(async () => { await refresh(); render(); toast('Datos actualizados'); });
  else if (a === 'tab') { ui.tab = b.dataset.v; ui.q = ''; render(); }
  else if (a === 'recharge') openRecharge(id);
  else if (a === 'use') openUse(id);
  else if (a === 'detail') openDetail(id);
  else if (a === 'confirm') openConfirm(id);
  else if (a === 'amt') { const i = $('input[name=amount]'); if (i) i.value = b.dataset.v; }
  else if (a === 'reject') run(async () => { if (await setStatus(id, 'rechazada')) { closeModal(); render(); toast('Movimiento rechazado'); } });
  else if (a === 'cancel') { if (confirm('¿Anular este movimiento pendiente?')) run(async () => { if (await setStatus(id, 'anulada')) render(); }); }
  else if (a === 'delclient') {
    const c = client(id); if (!c) return;
    if (confirm(`¿Eliminar a ${c.name}? Se borrarán también sus movimientos.`)) run(async () => {
      const idh = await userHash(c.user);
      const err = await mutate(st => { delete st.users[idh]; st.db.clients = st.db.clients.filter(x => x.id !== id); st.db.tx = st.db.tx.filter(t => t.clientId !== id); });
      if (err) return toast(err); render();
    });
  }
  else if (a === 'delprod') {
    if (confirm('¿Eliminar este producto?')) run(async () => {
      const err = await mutate(st => { st.db.products = st.db.products.filter(p => p.id !== id); });
      if (err) return toast(err); render();
    });
  }
  else if (a === 'export') run(async () => {
    const row = await fetchLatest();
    const url = URL.createObjectURL(new Blob([JSON.stringify(row.data)], {type:'application/json'}));
    const l = document.createElement('a'); l.href = url; l.download = 'chorilab-copia-cifrada-' + new Date().toISOString().slice(0, 10) + '.json'; l.click(); URL.revokeObjectURL(url);
  });
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-search]')) { ui.q = t.value; render(); const n = $('[data-search]'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  if (t.classList.contains('qty')) {
    let s = 0; document.querySelectorAll('.qty').forEach(i => s += (Math.floor(+i.value) || 0) * +i.dataset.price);
    $('#tot').textContent = COP(s);
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-filter]')) { ui.filter = t.value; render(); }
  if (t.name === 'method') {
    const tr = t.value === 'transferencia';
    $('#refbox').hidden = !tr; $('#payhint').textContent = tr ? S.db.settings.bank : S.db.settings.cash;
    $('#refbox input').required = tr;
  }
  if (t.matches('[data-import]') && t.files[0]) {
    const file = t.files[0]; t.value = '';
    const r = new FileReader();
    r.onload = () => run(async () => {
      let data; try { data = JSON.parse(r.result); await decryptDb(data); if (!data.users || !data.users[S.me.idh]) throw 0; } catch (x) { return toast('Copia no válida o cifrada con otras claves'); }
      if (!confirm('Esto reemplazará los datos actuales por los de la copia. ¿Continuar?')) return;
      const latest = await fetchLatest();
      if (!(await insertRev(latest.rev + 1, data))) return toast('Hubo un conflicto, inténtalo de nuevo');
      logout('Copia restaurada. Inicia sesión de nuevo.');
    });
    r.readAsText(file);
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
boot();
})();
