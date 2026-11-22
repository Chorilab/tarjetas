'use strict';
/* CHORILAB · Tarjetas de regalo + Caja (POS) + Menú + Inventario
 * Base de datos cifrada en el navegador (AES-GCM 256) y guardada en Supabase como versiones.
 * - Una clave de datos aleatoria (DEK) cifra toda la base.
 * - Cada usuario tiene la DEK "envuelta" con una clave derivada de su contraseña (PBKDF2-SHA256).
 * - Menú, stock, ventas y clientes viven en la misma base cifrada: todo se sincroniza solo (cada 15 s).
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
const isToday = t => new Date(t).toDateString() === new Date().toDateString();
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
function refocus(sel) { const n = $(sel); if (n) { n.focus(); try { n.setSelectionRange(n.value.length, n.value.length); } catch (e) {} } }

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
async function decryptDb(data) { return normalize(JSON.parse(dec.decode(await aesDec(S.dek, data)))); }

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
  tx: [],
  stockLog: []
});
/* Completa campos nuevos en bases creadas con versiones anteriores. */
function normalize(db) {
  db.settings = db.settings || {}; db.settings.bank ??= ''; db.settings.cash ??= '';
  db.products = db.products || []; db.clients = db.clients || []; db.tx = db.tx || []; db.stockLog = db.stockLog || [];
  db.products.forEach(p => {
    if (p.active === undefined) p.active = true;
    if (p.stock === undefined) p.stock = null;
    if (p.min === undefined) p.min = 0;
    p.desc ??= '';
  });
  db.clients.forEach(c => { c.notes ??= ''; });
  return db;
}
let S = {rev:0, users:{}, db:null, dek:null, kb64:null, me:null};
const ui = {
  view:'loading', tab:'caja', ctab:'tarjeta', filter:'todas', tfilter:'todos', q:'', csort:'name', busy:false, dirty:false, error:'',
  cart:{}, pq:'', pcat:'todas', pmode:'mostrador', pmethod:'efectivo', pclient:null, pcq:'', precv:'', pnote:''
};

const client = id => S.db.clients.find(c => c.id === id);
const product = id => S.db.products.find(p => p.id === id);
const balance = id => S.db.tx.filter(t => t.clientId === id && t.status === 'confirmada').reduce((s, t) => s + (t.type === 'recharge' ? t.amount : -t.amount), 0);
const reserved = id => S.db.tx.filter(t => t.clientId === id && t.status === 'pendiente' && t.type === 'use').reduce((s, t) => s + t.amount, 0);
const pending = id => S.db.tx.filter(t => t.clientId === id && t.status === 'pendiente');
const lastActivity = id => S.db.tx.filter(t => t.clientId === id).reduce((m, t) => Math.max(m, t.created), 0);
const methodName = m => m === 'transferencia' ? 'Transferencia' : m === 'efectivo' ? 'Efectivo' : '—';
const txLabel = t => t.type === 'recharge' ? 'Recarga' : t.type === 'sale' ? 'Venta' : 'Consumo';
const tracked = p => p.stock !== null && p.stock !== undefined;
const stockState = p => !tracked(p) ? 'free' : p.stock <= 0 ? 'out' : p.stock <= (p.min || 0) ? 'low' : 'ok';
const itemsText = items => (items || []).map(i => `${i.qty}× ${esc(i.name)}`).join(', ');
function restock(db, items) { (items || []).forEach(it => { const p = db.products.find(x => x.id === it.id); if (p && tracked(p)) p.stock += it.qty; }); }
function newCardNo(db) {
  let n; do { n = 'CHOR-' + [0,1,2].map(() => String(Math.floor(Math.random() * 10000)).padStart(4, '0')).join('-'); } while (db.clients.some(c => c.cardNo === n));
  return n;
}

/* Carrito del POS */
const cartLines = () => Object.entries(ui.cart).map(([id, q]) => { const p = product(id); return p && q > 0 ? {p, q} : null; }).filter(Boolean);
const cartTotal = () => cartLines().reduce((s, l) => s + l.p.price * l.q, 0);
function addToCart(id, d = 1) {
  const p = product(id); if (!p) return;
  const n = (ui.cart[id] || 0) + d;
  if (n <= 0) delete ui.cart[id];
  else { if (tracked(p) && n > p.stock) return toast('Solo quedan ' + p.stock + ' de ' + p.name); ui.cart[id] = n; }
  render();
}
function resetCart() { ui.cart = {}; ui.precv = ''; ui.pnote = ''; ui.pclient = null; ui.pcq = ''; }

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
  ui.view = 'login'; ui.tab = 'caja'; ui.ctab = 'tarjeta'; ui.q = ''; ui.pq = ''; ui.pcat = 'todas'; ui.pmode = 'mostrador'; resetCart(); closeModal(); render();
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
  return `<header class="top"><div class="brand">🌭 CHORILAB<small>Tarjetas de regalo · Caja</small></div>
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
  const low = S.db.products.filter(p => ['low', 'out'].includes(stockState(p))).length;
  const pend = S.db.tx.filter(t => t.status === 'pendiente').length;
  const tabs = [['caja','🧾 Caja'],['resumen','Resumen'],['clientes','Clientes'],['movimientos','Movimientos' + (pend ? ` (${pend})` : '')],['menu','Menú'],['inventario','Inventario' + (low ? ` ⚠${low}` : '')],['ajustes','Ajustes']];
  const body = {caja:adminCaja, resumen:adminResumen, clientes:adminClientes, movimientos:adminMov, menu:adminMenu, inventario:adminInventario, ajustes:adminAjustes}[ui.tab]();
  return topbar('Administrador') + `<main class="${ui.tab === 'caja' ? 'wide' : ''}">
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.tab===k?'on':''}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</div>${body}</main>`;
}

/* ----- Caja (POS) ----- */
function tileHTML(p) {
  const st = stockState(p), n = ui.cart[p.id] || 0;
  return `<button class="ptile ${st}" data-act="add" data-id="${p.id}" ${st==='out'?'disabled':''}>
    ${n ? `<span class="qb">${n}</span>` : ''}<span class="pn">${esc(p.name)}</span><span class="pp">${COP(p.price)}</span>
    ${st==='out' ? '<span class="badge b-out">Agotado</span>' : tracked(p) ? `<span class="ps ${st}">${p.stock} disp.</span>` : ''}</button>`;
}
function adminCaja() {
  const prods = S.db.products.filter(p => p.active);
  const cats = [...new Set(prods.map(p => p.cat))];
  const q = ui.pq.toLowerCase();
  const shown = prods.filter(p => (ui.pcat === 'todas' || p.cat === ui.pcat) && (!q || (p.name + ' ' + p.cat).toLowerCase().includes(q)));
  return `<div class="poslay">
    <section class="pos-l">
      <input data-psearch type="search" placeholder="Buscar producto…" value="${esc(ui.pq)}" style="margin-bottom:8px">
      <div class="chips" style="margin:0 0 12px">${['todas', ...cats].map(c => `<button class="chip ${ui.pcat===c?'on':''}" data-act="pcat" data-v="${esc(c)}">${c==='todas'?'Todo':esc(c)}</button>`).join('')}</div>
      ${shown.length ? `<div class="ptiles">${shown.map(tileHTML).join('')}</div>` : '<div class="empty">No hay productos. Agrégalos en la pestaña Menú.</div>'}
    </section>
    <aside class="pos-r card">${cartPanel()}</aside></div>`;
}
function cartPanel() {
  const lines = cartLines(), total = cartTotal(), tarjeta = ui.pmode === 'tarjeta';
  let who;
  if (tarjeta) {
    const c = ui.pclient && client(ui.pclient);
    if (c) {
      const av = balance(c.id) - reserved(c.id);
      who = `<div class="hint"><b>${esc(c.name)}</b> · ${esc(c.cardNo)}<br>Saldo disponible: <b class="${av >= total ? 'pos' : 'neg'}">${COP(av)}</b>
        <button class="btn sm ghost" data-act="pclientclear" style="margin-left:6px">Cambiar</button></div>`;
    } else {
      const qq = ui.pcq.toLowerCase();
      const res = S.db.clients.filter(c => !qq || (c.name + ' ' + c.user + ' ' + c.phone + ' ' + c.cardNo).toLowerCase().includes(qq)).slice(0, 6);
      who = `<input data-pcsearch type="search" placeholder="Buscar cliente (nombre, usuario, tarjeta)" value="${esc(ui.pcq)}">
        <div class="clist">${res.length ? res.map(c => `<button class="crow" data-act="pclient" data-id="${c.id}"><span>${esc(c.name)}<small class="muted"> ${esc(c.cardNo)}</small></span><b>${COP(balance(c.id) - reserved(c.id))}</b></button>`).join('') : '<div class="empty">Sin resultados</div>'}</div>`;
    }
  } else {
    who = `<div class="seg">${['efectivo', 'transferencia'].map(m => `<button class="${ui.pmethod===m?'on':''}" data-act="pmethod" data-v="${m}">${m==='efectivo'?'💵 Efectivo':'🏦 Transferencia'}</button>`).join('')}</div>
      ${ui.pmethod === 'efectivo' ? `<label>Recibido (opcional)</label><input id="recv" inputmode="numeric" value="${esc(ui.precv)}" placeholder="Ej. 50000"><div id="chg" class="muted" style="margin-top:4px">${changeText(total)}</div>` : `<div class="hint">${esc(S.db.settings.bank)}</div>`}`;
  }
  return `<h3>Pedido</h3>
    <div class="seg" style="margin:8px 0"><button class="${!tarjeta?'on':''}" data-act="pmode" data-v="mostrador">Mostrador</button><button class="${tarjeta?'on':''}" data-act="pmode" data-v="tarjeta">💳 Tarjeta de regalo</button></div>
    ${who}
    <div class="cart">${lines.length ? lines.map(({p, q}) => `<div class="cline"><div class="n">${esc(p.name)}<div class="muted">${COP(p.price)}</div></div>
      <div class="qty-ctl"><button class="btn sm ghost" data-act="cdec" data-id="${p.id}" aria-label="Menos">−</button><b>${q}</b><button class="btn sm ghost" data-act="cinc" data-id="${p.id}" aria-label="Más">+</button></div>
      <b class="lt">${COP(p.price * q)}</b></div>`).join('') : '<div class="empty">Toca los productos para agregarlos.</div>'}</div>
    <input id="pnote" placeholder="Nota (mesa, nombre, pedido…)" value="${esc(ui.pnote)}">
    <div class="total">Total: ${COP(total)}</div>
    <div class="row" style="margin-top:10px"><button class="btn ghost fit" data-act="clearcart" ${lines.length?'':'disabled'}>Vaciar</button>
      <button class="btn ${tarjeta?'cel':'ok'}" data-act="checkout" ${lines.length?'':'disabled'}>${tarjeta ? 'Enviar cobro al cliente' : 'Cobrar ' + COP(total)}</button></div>
    ${tarjeta ? '<p class="muted">El descuento se aplica cuando el cliente confirme desde su cuenta.</p>' : ''}`;
}
function changeText(total) {
  const r = Math.round(+String(ui.precv).replace(/\D/g, ''));
  if (!r) return '';
  return r >= total ? `Cambio a devolver: <b>${COP(r - total)}</b>` : `Faltan <b class="neg">${COP(total - r)}</b>`;
}

/* ----- Resumen ----- */
function adminResumen() {
  const conf = S.db.tx.filter(t => t.status === 'confirmada');
  const rec = conf.filter(t => t.type === 'recharge').reduce((s, t) => s + t.amount, 0);
  const use = conf.filter(t => t.type === 'use').reduce((s, t) => s + t.amount, 0);
  const pend = S.db.tx.filter(t => t.status === 'pendiente').length;
  const tr = conf.filter(t => t.type === 'recharge' && t.method === 'transferencia').reduce((s, t) => s + t.amount, 0);
  const hoy = conf.filter(t => t.type !== 'recharge' && isToday(t.resolved || t.created));
  const hoySales = hoy.filter(t => t.type === 'sale');
  const hoyRec = conf.filter(t => t.type === 'recharge' && isToday(t.resolved || t.created)).reduce((s, t) => s + t.amount, 0);
  const sum = a => a.reduce((s, t) => s + t.amount, 0);
  const cnt = {}; hoy.forEach(t => (t.items || []).forEach(i => { cnt[i.name] = (cnt[i.name] || 0) + i.qty; }));
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const alerts = S.db.products.filter(p => ['low', 'out'].includes(stockState(p)));
  const latest = [...S.db.tx].sort((a, b) => b.created - a.created).slice(0, 6);
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Ventas de hoy</span><b>${COP(sum(hoy))}</b><span>Mostrador ${COP(sum(hoySales))} · Tarjetas ${COP(sum(hoy) - sum(hoySales))}</span></div>
    <div class="stat"><span>Recargas de hoy</span><b>${COP(hoyRec)}</b></div>
    <div class="stat"><span>Pedidos de hoy</span><b>${hoy.length}</b><span>Ticket prom. ${COP(hoy.length ? Math.round(sum(hoy) / hoy.length) : 0)}</span></div>
    <div class="stat"><span>Esperando confirmación</span><b>${pend}</b></div>
    <div class="stat"><span>Clientes</span><b>${S.db.clients.length}</b></div>
    <div class="stat"><span>Saldo total en tarjetas</span><b>${COP(rec - use)}</b></div>
    <div class="stat"><span>Recargas confirmadas</span><b>${COP(rec)}</b><span>Transf. ${COP(tr)} · Efectivo ${COP(rec - tr)}</span></div>
    <div class="stat"><span>Consumos con tarjeta</span><b>${COP(use)}</b></div></div>
    <div class="grid g2">
      <div class="card"><h3>Más vendidos hoy</h3>${top.length ? top.map(([n, q]) => `<div class="prow"><div class="n">${esc(n)}</div><b>${q}</b></div>`).join('') : '<div class="empty">Aún no hay ventas hoy.</div>'}</div>
      <div class="card"><h3>Alertas de inventario</h3>${alerts.length ? alerts.map(p => `<div class="prow"><div class="n">${esc(p.name)}</div><span class="badge b-${stockState(p)}">${stockState(p)==='out'?'Agotado':p.stock+' restantes'}</span></div>`).join('') : '<div class="empty">Todo en orden ✅</div>'}</div></div>
    <div class="card"><h3>Últimos movimientos</h3>${txTable(latest, 'admin')}</div>`;
}

/* ----- Clientes ----- */
function adminClientes() {
  const q = ui.q.toLowerCase();
  const sorters = {name:(a, b) => a.name.localeCompare(b.name), bal:(a, b) => balance(b.id) - balance(a.id), last:(a, b) => lastActivity(b.id) - lastActivity(a.id)};
  const list = S.db.clients.filter(c => !q || (c.name + c.user + c.phone + c.cardNo).toLowerCase().includes(q)).sort(sorters[ui.csort]);
  return `<div class="card"><h3>Crear cliente</h3>
    <form data-form="newclient"><div class="row">
      <div><label>Nombre completo</label><input name="name" required></div>
      <div><label>Teléfono</label><input name="phone" inputmode="tel"></div></div>
      <div class="row"><div><label>Usuario</label><input name="user" required autocomplete="off"></div>
      <div><label>Clave inicial (mín. ${MINPASS})</label><input name="pass" required minlength="${MINPASS}" autocomplete="off"></div>
      <div class="fit"><button class="btn gold">Crear tarjeta</button></div></div></form></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2">Clientes (${list.length})</h3>
      <input data-search placeholder="Buscar por nombre, usuario, teléfono o tarjeta" value="${esc(ui.q)}">
      <select data-csort aria-label="Ordenar"><option value="name" ${ui.csort==='name'?'selected':''}>Ordenar: nombre</option><option value="bal" ${ui.csort==='bal'?'selected':''}>Ordenar: mayor saldo</option><option value="last" ${ui.csort==='last'?'selected':''}>Ordenar: última visita</option></select></div>
      ${list.length ? `<div class="tw"><table><thead><tr><th>Cliente</th><th>Tarjeta</th><th>Saldo</th><th>Última visita</th><th>Pend.</th><th></th></tr></thead><tbody>
      ${list.map(c => { const la = lastActivity(c.id); return `<tr><td><b>${esc(c.name)}</b><br><span class="muted">@${esc(c.user)} ${c.phone ? '· ' + esc(c.phone) : ''}</span></td>
        <td class="muted">${esc(c.cardNo)}</td><td><b>${COP(balance(c.id))}</b></td><td class="muted">${la ? fdate(la) : '—'}</td><td>${pending(c.id).length}</td>
        <td style="white-space:nowrap"><button class="btn sm ok" data-act="recharge" data-id="${c.id}">Recargar</button>
        <button class="btn sm cel" data-act="use" data-id="${c.id}">Cobrar</button>
        <button class="btn sm ghost" data-act="detail" data-id="${c.id}">Ver</button>
        <button class="btn sm ghost" data-act="delclient" data-id="${c.id}" aria-label="Eliminar">🗑</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty">Aún no hay clientes.</div>'}</div>`;
}

/* ----- Movimientos ----- */
function adminMov() {
  const list = S.db.tx.filter(t => (ui.filter === 'todas' || t.status === ui.filter) && (ui.tfilter === 'todos' || t.type === ui.tfilter)).sort((a, b) => b.created - a.created);
  return `<div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2">Movimientos (${list.length})</h3>
    <select data-tfilter>${[['todos','Todos los tipos'],['sale','Ventas'],['use','Consumos con tarjeta'],['recharge','Recargas']].map(([v, l]) => `<option value="${v}" ${ui.tfilter===v?'selected':''}>${l}</option>`).join('')}</select>
    <select data-filter>${['todas','pendiente','confirmada','rechazada','anulada'].map(s => `<option value="${s}" ${ui.filter===s?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}</select></div>
    ${txTable(list.slice(0, 300), 'admin')}</div>`;
}

/* ----- Menú (editor; los clientes lo ven en su cuenta) ----- */
function adminMenu() {
  const cats = [...new Set(S.db.products.map(p => p.cat))];
  return `<div class="card"><h3>Menú de CHORILAB</h3>
    <p class="muted">Lo que cambies aquí se actualiza en la Caja y en la pestaña Menú de tus clientes. Los productos ocultos no aparecen en ninguno de los dos. El stock se maneja en Inventario.</p>
    ${cats.map(cat => `<div class="cat">${esc(cat)}</div>${S.db.products.filter(p => p.cat === cat).map(p => `<form data-form="prod" data-id="${p.id}" class="mrow ${p.active?'':'off'}">
      <div class="row"><div><input name="cat" value="${esc(p.cat)}" list="cats" aria-label="Categoría"></div>
      <div style="flex:2"><input name="name" value="${esc(p.name)}" required aria-label="Nombre"></div>
      <div><input name="price" type="number" min="0" step="500" value="${p.price}" required aria-label="Precio"></div></div>
      <div class="row"><div style="flex:3"><input name="desc" value="${esc(p.desc)}" placeholder="Descripción corta (la ve el cliente)" aria-label="Descripción"></div>
      <label class="fit chk"><input type="checkbox" name="active" ${p.active?'checked':''}> Visible</label>
      <div class="fit"><button class="btn sm cel">Guardar</button> <button type="button" class="btn sm ghost" data-act="delprod" data-id="${p.id}" aria-label="Eliminar">🗑</button></div></div></form>`).join('')}`).join('')}
    <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="card"><h3>Agregar producto</h3><form data-form="newprod"><div class="row">
      <div><label>Categoría</label><input name="cat" list="cats" required></div>
      <div style="flex:2"><label>Nombre</label><input name="name" required></div>
      <div><label>Precio</label><input name="price" type="number" min="0" step="500" required></div></div>
      <div class="row"><div style="flex:3"><label>Descripción (opcional)</label><input name="desc"></div>
      <div class="fit"><button class="btn gold">Agregar</button></div></div></form></div>`;
}

/* ----- Inventario ----- */
function adminInventario() {
  const ps = [...S.db.products].sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
  const n = s => ps.filter(p => stockState(p) === s).length;
  const labels = {ok:'Disponible', low:'Bajo', out:'Agotado', free:'Sin control'};
  const log = [...S.db.stockLog].sort((a, b) => b.created - a.created).slice(0, 15);
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Con control de stock</span><b>${ps.filter(tracked).length}</b></div>
    <div class="stat"><span>Stock bajo</span><b class="${n('low')?'neg':''}">${n('low')}</b></div>
    <div class="stat"><span>Agotados</span><b class="${n('out')?'neg':''}">${n('out')}</b></div></div>
    <div class="card"><h3>Inventario disponible</h3>
    <p class="muted">Las ventas descuentan stock solas y se devuelve si un pedido se rechaza o anula. Un producto "sin control" siempre aparece disponible.</p>
    <div class="tw"><table><thead><tr><th>Producto</th><th>Stock</th><th>Alerta en</th><th>Estado</th><th></th></tr></thead><tbody>
    ${ps.map(p => `<tr><td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.cat)}${p.active ? '' : ' · oculto'}</span></td>
      <td><b>${tracked(p) ? p.stock : '—'}</b></td><td class="muted">${tracked(p) ? p.min : '—'}</td>
      <td><span class="badge b-${stockState(p)}">${labels[stockState(p)]}</span></td>
      <td><button class="btn sm cel" data-act="stock" data-id="${p.id}">Ajustar</button></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h3>Últimos ajustes</h3>${log.length ? `<div class="tw"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Cambio</th><th>Quedó</th><th>Motivo</th></tr></thead><tbody>
    ${log.map(l => `<tr><td class="muted">${fdate(l.created)}</td><td>${esc(l.name)}</td><td class="${l.delta >= 0 ? 'pos' : 'neg'}">${l.delta > 0 ? '+' : ''}${l.delta}</td><td>${l.after ?? '—'}</td><td class="muted">${esc(l.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin ajustes manuales.</div>'}</div>`;
}

function adminAjustes() {
  return `<div class="card"><h3>Métodos de pago</h3><form data-form="settings">
      <label>Instrucciones de transferencia (se muestran al recargar y en la Caja)</label><textarea name="bank" rows="2">${esc(S.db.settings.bank)}</textarea>
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
function menuHTML() {
  const prods = S.db.products.filter(p => p.active);
  const cats = [...new Set(prods.map(p => p.cat))];
  if (!prods.length) return '<div class="card"><div class="empty">El menú estará disponible pronto.</div></div>';
  return cats.map(cat => `<div class="card"><div class="cat" style="margin-top:0">${esc(cat)}</div><div class="menu">
    ${prods.filter(p => p.cat === cat).map(p => { const st = stockState(p); return `<div class="mitem ${st==='out'?'soldout':''}">
      <div class="mt"><b>${esc(p.name)}</b><span class="mp">${COP(p.price)}</span></div>
      ${p.desc ? `<div class="muted">${esc(p.desc)}</div>` : ''}
      ${st === 'out' ? '<span class="badge b-out">Agotado</span>' : st === 'low' ? '<span class="badge b-low">¡Quedan pocas!</span>' : ''}</div>`; }).join('')}</div></div>`).join('');
}
function clientView() {
  const c = client(S.me.cid);
  const pend = pending(c.id);
  const hist = S.db.tx.filter(t => t.clientId === c.id && t.status !== 'pendiente').sort((a, b) => b.created - a.created);
  const tabs = `<div class="tabs"><button class="${ui.ctab==='tarjeta'?'on':''}" data-act="ctab" data-v="tarjeta">Mi tarjeta${pend.length ? ` (${pend.length})` : ''}</button><button class="${ui.ctab==='menu'?'on':''}" data-act="ctab" data-v="menu">Menú</button></div>`;
  if (ui.ctab === 'menu') return topbar(c.name) + `<main>${tabs}${menuHTML()}</main>`;
  return topbar(c.name) + `<main>${tabs}<div class="grid g2" style="align-items:start">
    <div>${cardHTML(c)}${reserved(c.id) ? `<p class="muted">Hay ${COP(reserved(c.id))} pendientes de confirmar en consumos.</p>` : ''}</div>
    <div class="card"><h3>Por confirmar (${pend.length})</h3>
      <p class="muted">Cada recarga y cada uso de tu tarjeta necesita tu confirmación.</p>
      ${pend.length ? pend.map(t => `<div class="card pend" style="margin:8px 0;padding:12px">
        <div><span class="badge b-${t.type}">${txLabel(t)}</span> <b>${COP(t.amount)}</b></div>
        <div class="muted">${fdate(t.created)}${t.type==='recharge' ? ' · ' + methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : ''}</div>
        ${t.items ? `<div class="muted">${itemsText(t.items)}</div>` : ''}
        ${t.note ? `<div class="muted">Nota: ${esc(t.note)}</div>` : ''}
        <div style="margin-top:8px"><button class="btn sm ok" data-act="confirm" data-id="${t.id}">Revisar y confirmar</button></div></div>`).join('') : '<div class="empty">Nada pendiente ✅</div>'}</div></div>
    <div class="card"><h3>Mi historial</h3>${txTable(hist, 'client')}</div>
    <div class="card"><h3>Cambiar mi clave</h3><form data-form="mypass" class="row">
      <div><label>Clave actual</label><input type="password" name="old" required autocomplete="current-password"></div>
      <div><label>Nueva clave (mín. ${MINPASS})</label><input type="password" name="new" minlength="${MINPASS}" required autocomplete="new-password"></div>
      <div class="fit"><button class="btn cel">Cambiar</button></div></form></div></main>`;
}

function txDetail(t) {
  if (t.type === 'recharge') return methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '');
  return (t.type === 'sale' ? methodName(t.method) + ' · ' : '') + itemsText(t.items);
}
function txTable(list, role) {
  if (!list.length) return '<div class="empty">Sin movimientos.</div>';
  return `<div class="tw"><table><thead><tr><th>Fecha</th>${role==='admin'?'<th>Cliente</th>':''}<th>Tipo</th><th>Detalle</th><th>Monto</th><th>Estado</th>${role==='admin'?'<th></th>':''}</tr></thead><tbody>
  ${list.map(t => {
    const c = client(t.clientId);
    const who = t.type === 'sale' ? '<i>Mostrador</i>' : c ? esc(c.name) : '<i>eliminado</i>';
    const sign = t.type === 'recharge' ? '+' : t.type === 'use' ? '−' : '';
    const cls = t.type === 'recharge' ? 'pos' : t.type === 'use' ? 'neg' : 'sale';
    const canVoid = t.status === 'pendiente' || (t.status === 'confirmada' && t.type !== 'recharge');
    return `<tr><td class="muted">${fdate(t.created)}</td>${role==='admin'?`<td>${who}</td>`:''}
      <td><span class="badge b-${t.type}">${txLabel(t)}</span></td>
      <td class="muted">${txDetail(t)}${t.note ? '<br>' + esc(t.note) : ''}</td>
      <td class="${cls}">${sign}${COP(t.amount)}</td>
      <td><span class="badge b-${t.status}">${t.status}</span></td>
      ${role==='admin'?`<td style="white-space:nowrap">${t.type==='sale' && t.status==='confirmada' ? `<button class="btn sm ghost" data-act="ticket" data-id="${t.id}">Ticket</button> ` : ''}${canVoid ? `<button class="btn sm ghost" data-act="cancel" data-id="${t.id}">Anular</button>` : ''}</td>`:''}</tr>`;
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
function openDetail(id) {
  const c = client(id);
  const list = S.db.tx.filter(t => t.clientId === id).sort((a, b) => b.created - a.created);
  const conf = list.filter(t => t.status === 'confirmada');
  const rec = conf.filter(t => t.type === 'recharge').reduce((s, t) => s + t.amount, 0);
  const uses = conf.filter(t => t.type === 'use');
  const used = uses.reduce((s, t) => s + t.amount, 0);
  modal(esc(c.name), `${cardHTML(c)}
    <div class="grid g4" style="margin:12px 0"><div class="stat"><span>Recargado</span><b>${COP(rec)}</b></div><div class="stat"><span>Consumido</span><b>${COP(used)}</b></div>
    <div class="stat"><span>Visitas</span><b>${uses.length}</b></div><div class="stat"><span>Ticket prom.</span><b>${COP(uses.length ? Math.round(used / uses.length) : 0)}</b></div></div>
    <form data-form="editclient" data-id="${id}"><div class="row"><div><label>Nombre</label><input name="name" value="${esc(c.name)}" required></div>
    <div><label>Teléfono</label><input name="phone" value="${esc(c.phone)}" inputmode="tel"></div></div>
    <label>Notas internas (gustos, alergias, cumpleaños…)</label><textarea name="notes" rows="2">${esc(c.notes)}</textarea>
    <p class="muted">Usuario: @${esc(c.user)} · Cliente desde ${fdate(c.created)}</p>
    <button class="btn sm cel">Guardar cambios</button></form>
    <div style="margin-top:8px">${txTable(list, 'client')}</div>
    <form data-form="resetpass" data-id="${id}" class="row" style="margin-top:10px"><div><label>Restablecer clave del cliente</label><input name="new" minlength="${MINPASS}" required placeholder="Nueva clave"></div>
    <div class="fit"><button class="btn sm cel">Guardar</button></div></form>`);
}
function openConfirm(id) {
  const t = S.db.tx.find(x => x.id === id);
  if (!t || t.status !== 'pendiente') return;
  modal(t.type === 'recharge' ? 'Confirmar recarga' : 'Confirmar uso de tu tarjeta', `<form data-form="confirm" data-id="${id}">
    <div class="total" style="text-align:left">${t.type==='recharge'?'+':'−'}${COP(t.amount)}</div>
    <p class="muted">${t.type==='recharge' ? 'Método: ' + methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : itemsText(t.items)}</p>
    ${t.note ? `<p class="muted">Nota: ${esc(t.note)}</p>` : ''}
    <label>Escribe tu clave para confirmar</label><input type="password" name="pass" autocomplete="current-password" required>
    <div class="row" style="margin-top:12px"><button class="btn ok">Confirmar</button>
    <button type="button" class="btn red" data-act="reject" data-id="${id}">Rechazar</button></div></form>`);
}
function openStock(id) {
  const p = product(id); if (!p) return;
  modal('Ajustar stock · ' + esc(p.name), `<form data-form="stock" data-id="${id}">
    <div class="hint">Stock actual: <b>${tracked(p) ? p.stock : 'sin control'}</b></div>
    <label>Tipo de ajuste</label>
    <div class="radio"><label><input type="radio" name="mode" value="in" ${tracked(p)?'checked':''}> ➕ Entrada</label>
    <label><input type="radio" name="mode" value="out"> ➖ Salida / merma</label>
    <label><input type="radio" name="mode" value="set" ${tracked(p)?'':'checked'}> 🔢 Fijar cantidad</label>
    <label><input type="radio" name="mode" value="off"> 🚫 Dejar de controlar</label></div>
    <div class="row"><div><label>Cantidad</label><input name="qty" type="number" min="0" step="1"></div>
    <div><label>Avisar cuando queden ≤</label><input name="min" type="number" min="0" step="1" value="${p.min || 0}"></div></div>
    <label>Motivo (opcional)</label><input name="note" placeholder="Compra a proveedor, conteo, merma…">
    <button class="btn cel" style="width:100%;margin-top:12px">Guardar</button></form>`);
}
function openTicket(id) {
  const t = S.db.tx.find(x => x.id === id); if (!t) return;
  const recv = t.received && t.received >= t.amount;
  modal('Ticket de venta', `<div class="ticket"><div style="text-align:center"><b>🌭 CHORILAB</b><br><span class="muted">${fdate(t.created)} · #${esc(t.id)}</span></div>
    <hr>${(t.items || []).map(i => `<div class="tl"><span>${i.qty}× ${esc(i.name)}</span><span>${COP(i.qty * i.price)}</span></div>`).join('')}<hr>
    <div class="tl"><b>Total</b><b>${COP(t.amount)}</b></div>
    <div class="tl"><span>Pago</span><span>${methodName(t.method)}</span></div>
    ${recv ? `<div class="tl"><span>Recibido</span><span>${COP(t.received)}</span></div><div class="tl"><span>Cambio</span><span>${COP(t.received - t.amount)}</span></div>` : ''}
    ${t.note ? `<div class="muted">Nota: ${esc(t.note)}</div>` : ''}
    <p style="text-align:center;margin:10px 0 0">¡Gracias por tu compra!</p></div>
    <div class="row noprint" style="margin-top:12px"><button class="btn gold" data-act="print">🖨 Imprimir</button><button class="btn ghost" data-act="close">Cerrar</button></div>`);
}

/* ===================== Acciones ===================== */
async function setStatus(id, status) {
  const err = await mutate(st => {
    const t = st.db.tx.find(x => x.id === id);
    if (!t) return 'Movimiento no encontrado';
    if (S.me.role === 'client' && t.clientId !== S.me.cid) return 'No permitido';
    const voidConfirmed = status === 'anulada' && t.status === 'confirmada' && t.type !== 'recharge' && S.me.role === 'admin';
    if (t.status !== 'pendiente' && !voidConfirmed) return 'Este movimiento ya no se puede cambiar';
    if (t.items && (status === 'rechazada' || status === 'anulada')) restock(st.db, t.items);
    t.status = status; t.resolved = Date.now();
  });
  if (err) { toast(err); return false; }
  return true;
}
const checkPass = async pass => { try { await unwrap(pass, S.users[S.me.idh]); return true; } catch (e) { return false; } };

async function checkout() {
  const lines = cartLines(); if (!lines.length) return toast('Agrega productos al pedido');
  const items = lines.map(({p, q}) => ({id:p.id, name:p.name, qty:q, price:p.price}));
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  const tarjeta = ui.pmode === 'tarjeta', cid = ui.pclient, note = ui.pnote.trim();
  if (tarjeta && !(cid && client(cid))) return toast('Elige el cliente de la tarjeta');
  const method = ui.pmethod, txid = uid();
  const received = tarjeta || method !== 'efectivo' ? 0 : Math.round(+String(ui.precv).replace(/\D/g, '')) || 0;
  if (!tarjeta && method === 'efectivo' && received && received < total) return toast('El valor recibido no cubre el total');
  const err = await mutate(st => {
    for (const it of items) {
      const p = st.db.products.find(x => x.id === it.id);
      if (!p) return 'Producto ya no disponible: ' + it.name;
      if (tracked(p) && p.stock < it.qty) return `Stock insuficiente de ${p.name} (quedan ${p.stock})`;
    }
    if (tarjeta) {
      if (!st.db.clients.some(c => c.id === cid)) return 'El cliente ya no existe';
      const bal = st.db.tx.filter(t => t.clientId === cid && t.status === 'confirmada').reduce((s, t) => s + (t.type === 'recharge' ? t.amount : -t.amount), 0);
      const res = st.db.tx.filter(t => t.clientId === cid && t.status === 'pendiente' && t.type === 'use').reduce((s, t) => s + t.amount, 0);
      if (total > bal - res) return 'Saldo insuficiente en la tarjeta';
    }
    items.forEach(it => { const p = st.db.products.find(x => x.id === it.id); if (tracked(p)) p.stock -= it.qty; });
    const now = Date.now();
    st.db.tx.push(tarjeta
      ? {id:txid, clientId:cid, type:'use', amount:total, items, note, status:'pendiente', created:now}
      : {id:txid, clientId:null, type:'sale', amount:total, items, method, received, note, status:'confirmada', created:now, resolved:now});
  });
  if (err) return toast(err);
  resetCart();
  if (tarjeta) { render(); toast('Cobro enviado: queda pendiente de confirmación del cliente'); }
  else { render(); openTicket(txid); }
}

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
    ui.view = 'app'; ui.tab = p.role === 'admin' ? 'caja' : 'resumen'; ui.ctab = 'tarjeta'; ui.q = ''; resetCart(); startPolling(); render();
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
      st.db.clients.push({id:cid, name, phone, user, notes:'', cardNo:newCardNo(st.db), created:Date.now()});
    });
    if (err) return toast(err);
    render(); toast('Cliente creado. Entrégale su usuario y clave.');
  },
  async editclient(f, d) {
    const err = await mutate(st => {
      const c = st.db.clients.find(x => x.id === f.dataset.id); if (!c) return 'Cliente no encontrado';
      c.name = d.get('name').trim() || c.name; c.phone = d.get('phone').trim(); c.notes = d.get('notes').trim();
    });
    if (err) return toast(err);
    render(); toast('Cliente actualizado');
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
      p.cat = d.get('cat').trim() || p.cat; p.name = d.get('name').trim() || p.name; p.desc = d.get('desc').trim();
      p.price = Math.max(0, Math.round(+d.get('price'))); p.active = d.get('active') === 'on';
    });
    if (err) return toast(err);
    render(); toast('Producto actualizado');
  },
  async newprod(f, d) {
    const err = await mutate(st => { st.db.products.push({id:uid(), cat:d.get('cat').trim(), name:d.get('name').trim(), desc:d.get('desc').trim(), price:Math.max(0, Math.round(+d.get('price'))), active:true, stock:null, min:0}); });
    if (err) return toast(err);
    render(); toast('Producto agregado');
  },
  async stock(f, d) {
    const mode = d.get('mode'), qtyRaw = d.get('qty'), qty = Math.floor(+qtyRaw), min = Math.max(0, Math.floor(+d.get('min')) || 0), note = d.get('note').trim();
    if (mode !== 'off' && (qtyRaw === '' || !(qty >= 0))) return toast('Escribe una cantidad');
    const err = await mutate(st => {
      const p = st.db.products.find(x => x.id === f.dataset.id); if (!p) return 'Producto no encontrado';
      const before = tracked(p) ? p.stock : 0;
      if (mode === 'off') { p.stock = null; p.min = 0; st.db.stockLog.push({id:uid(), pid:p.id, name:p.name, delta:0, after:null, reason:'Dejó de controlarse', created:Date.now()}); }
      else {
        if ((mode === 'in' || mode === 'out') && !tracked(p)) return 'Primero usa "Fijar cantidad" para activar el control de stock';
        const after = mode === 'in' ? before + qty : mode === 'out' ? before - qty : qty;
        if (after < 0) return 'No puedes sacar más de lo que hay (' + before + ')';
        p.stock = after; p.min = min;
        st.db.stockLog.push({id:uid(), pid:p.id, name:p.name, delta:after - before, after, reason:note || ({in:'Entrada', out:'Salida / merma', set:'Conteo'})[mode], created:Date.now()});
      }
      st.db.stockLog = st.db.stockLog.slice(-300);
    });
    if (err) return toast(err);
    closeModal(); render(); toast('Inventario actualizado');
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
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'close') closeModal();
  else if (a === 'boot') boot();
  else if (a === 'logout') logout();
  else if (a === 'reload') run(async () => { await refresh(); render(); toast('Datos actualizados'); });
  else if (a === 'tab') { ui.tab = b.dataset.v; ui.q = ''; render(); }
  else if (a === 'ctab') { ui.ctab = b.dataset.v; render(); }
  else if (a === 'recharge') openRecharge(id);
  else if (a === 'use') { ui.tab = 'caja'; ui.pmode = 'tarjeta'; ui.pclient = id; render(); }
  else if (a === 'detail') openDetail(id);
  else if (a === 'confirm') openConfirm(id);
  else if (a === 'stock') openStock(id);
  else if (a === 'ticket') openTicket(id);
  else if (a === 'print') window.print();
  else if (a === 'amt') { const i = $('input[name=amount]'); if (i) i.value = b.dataset.v; }
  /* caja */
  else if (a === 'add') addToCart(id, 1);
  else if (a === 'cinc') addToCart(id, 1);
  else if (a === 'cdec') addToCart(id, -1);
  else if (a === 'clearcart') { ui.cart = {}; render(); }
  else if (a === 'pcat') { ui.pcat = b.dataset.v; render(); }
  else if (a === 'pmode') { ui.pmode = b.dataset.v; render(); }
  else if (a === 'pmethod') { ui.pmethod = b.dataset.v; render(); }
  else if (a === 'pclient') { ui.pclient = id; ui.pcq = ''; render(); }
  else if (a === 'pclientclear') { ui.pclient = null; render(); }
  else if (a === 'checkout') run(checkout);
  /* movimientos */
  else if (a === 'reject') run(async () => { if (await setStatus(id, 'rechazada')) { closeModal(); render(); toast('Movimiento rechazado'); } });
  else if (a === 'cancel') {
    const t = S.db.tx.find(x => x.id === id); if (!t) return;
    const msg = t.status === 'confirmada' ? '¿Anular este movimiento ya confirmado? ' + (t.type === 'use' ? 'Se devolverá el saldo al cliente y el stock.' : 'Se devolverá el stock.') : '¿Anular este movimiento pendiente?';
    if (confirm(msg)) run(async () => { if (await setStatus(id, 'anulada')) render(); });
  }
  else if (a === 'delclient') {
    const c = client(id); if (!c) return;
    if (confirm(`¿Eliminar a ${c.name}? Se borrarán también sus movimientos.`)) run(async () => {
      const idh = await userHash(c.user);
      const err = await mutate(st => { delete st.users[idh]; st.db.clients = st.db.clients.filter(x => x.id !== id); st.db.tx = st.db.tx.filter(t => t.clientId !== id); });
      if (err) return toast(err); render();
    });
  }
  else if (a === 'delprod') {
    if (confirm('¿Eliminar este producto del menú?')) run(async () => {
      const err = await mutate(st => { st.db.products = st.db.products.filter(p => p.id !== id); });
      if (err) return toast(err); delete ui.cart[id]; render();
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
  if (t.matches('[data-search]')) { ui.q = t.value; render(); refocus('[data-search]'); }
  else if (t.matches('[data-psearch]')) { ui.pq = t.value; render(); refocus('[data-psearch]'); }
  else if (t.matches('[data-pcsearch]')) { ui.pcq = t.value; render(); refocus('[data-pcsearch]'); }
  else if (t.id === 'recv') { ui.precv = t.value; const c = $('#chg'); if (c) c.innerHTML = changeText(cartTotal()); }
  else if (t.id === 'pnote') ui.pnote = t.value;
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-filter]')) { ui.filter = t.value; render(); }
  if (t.matches('[data-tfilter]')) { ui.tfilter = t.value; render(); }
  if (t.matches('[data-csort]')) { ui.csort = t.value; render(); }
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
