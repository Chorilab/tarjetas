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
    cash: 'Pago en efectivo directamente en CHORILAB.',
    tag: 'Embutidos artesanales de calidad. Chorizo de 21 cm, pan de masa madre y chimichurri hecho en casa.',
    catSubs: {
      'Para la casa': 'Para llevar y armar los choripanes en tu mesa.',
      'Para comer aquí': 'Combos para disfrutar en el restaurante.',
      'Bebidas': 'Sueltas, para sumar a cualquier pedido.'
    }
  },
  products: [
    {id:'c4', cat:'Para la casa', name:'Combo Choripán x4', price:30000, desc:'4 chorizos 21 cm\n4 panes de masa madre\n1 chimichurri artesanal'},
    {id:'c6', cat:'Para la casa', name:'Combo Choripán x6', price:45000, desc:'6 chorizos 21 cm\n6 panes de masa madre\n2 chimichurri artesanal'},
    {id:'r1', cat:'Para comer aquí', name:'Combo Personal', price:18000, desc:'1 choripán clásico\n1 gaseosa sin azúcar 250 mL'},
    {id:'r2', cat:'Para comer aquí', name:'Combo Pareja', price:32500, desc:'2 choripanes clásicos\n2 gaseosas sin azúcar 250 mL'},
    {id:'r3', cat:'Para comer aquí', name:'Combo Trío', price:39000, desc:'3 choripanes clásicos'},
    {id:'r4', cat:'Para comer aquí', name:'Combo Parche', price:60000, desc:'4 choripanes clásicos\n4 gaseosas sin azúcar 250 mL'},
    {id:'r5', cat:'Para comer aquí', name:'Combo Familiar', price:60000, desc:'5 choripanes clásicos'},
    {id:'b1', cat:'Bebidas', name:'Gaseosa sin azúcar', price:3000, desc:'250 mL'},
    {id:'b2', cat:'Bebidas', name:'Gaseosa sin azúcar', price:5000, desc:'400 mL'},
    {id:'b3', cat:'Bebidas', name:'Agua', price:3000, desc:'600 mL'}
  ],
  clients: [],
  tx: [],
  stockLog: [],
  layaways: [],
  raffles: []
});
/* Completa campos nuevos en bases creadas con versiones anteriores. */
function normalize(db) {
  db.settings = db.settings || {}; db.settings.bank ??= ''; db.settings.cash ??= '';
  db.settings.tag ??= 'Embutidos artesanales de calidad. Chorizo de 21 cm, pan de masa madre y chimichurri hecho en casa.'; db.settings.catSubs ??= {};
  db.products = db.products || []; db.clients = db.clients || []; db.tx = db.tx || []; db.stockLog = db.stockLog || []; db.layaways = db.layaways || []; db.layaways.forEach(l => { l.abonos = l.abonos || []; });
  db.raffles = db.raffles || []; db.raffles.forEach(r => { r.grants = r.grants || []; r.picks = r.picks || []; r.closed = !!r.closed; r.win = r.win || null; r.prize = r.prize || ''; r.desc = r.desc || ''; });
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
  cart:{}, pq:'', pcat:'todas', pmode:'mostrador', pmethod:'efectivo', pclient:null, pcq:'', precv:'', pnote:'', mcart:{}, mopen:false, mpreview:false, lfilter:'todos', lq:'', rid:null, crid:null, rpick:[], rq:'', rfree:false
};

const client = id => S.db.clients.find(c => c.id === id);
const product = id => S.db.products.find(p => p.id === id);
/* Abonos de apartados (los pagados con la tarjeta descuentan del saldo, previa confirmación del cliente) */
const abSt = a => a.status || 'confirmada';
const abOk = a => !a.voided && abSt(a) === 'confirmada';
const sumA = list => list.reduce((s, a) => s + a.amount, 0);
const cardAbs = (db, id, st) => (db.layaways || []).filter(l => l.clientId === id).flatMap(l => l.abonos || []).filter(a => a.method === 'tarjeta' && !a.voided && !a.refunded && abSt(a) === st);
const balOf = (db, id) => db.tx.filter(t => t.clientId === id && t.status === 'confirmada').reduce((s, t) => s + (t.type === 'recharge' ? t.amount : -t.amount), 0) - sumA(cardAbs(db, id, 'confirmada'));
const resOf = (db, id) => db.tx.filter(t => t.clientId === id && t.status === 'pendiente' && t.type === 'use').reduce((s, t) => s + t.amount, 0) + sumA(cardAbs(db, id, 'pendiente'));
const balance = id => balOf(S.db, id);
const reserved = id => resOf(S.db, id);
const pendingAbonos = id => S.db.layaways.filter(l => l.clientId === id && l.status === 'activo').flatMap(l => (l.abonos || []).filter(a => a.method === 'tarjeta' && !a.voided && abSt(a) === 'pendiente').map(a => ({l, a})));
const pending = id => S.db.tx.filter(t => t.clientId === id && t.status === 'pendiente');
const lastActivity = id => S.db.tx.filter(t => t.clientId === id).reduce((m, t) => Math.max(m, t.created), 0);
const methodName = m => m === 'transferencia' ? 'Transferencia' : m === 'efectivo' ? 'Efectivo' : m === 'tarjeta' ? 'Tarjeta de regalo' : '—';
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
  ui.view = 'login'; ui.tab = 'caja'; ui.ctab = 'tarjeta'; ui.q = ''; ui.pq = ''; ui.pcat = 'todas'; ui.pmode = 'mostrador'; ui.mcart = {}; ui.mopen = false; ui.mpreview = false; resetCart(); closeModal(); render();
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
  const lay = S.db.layaways.filter(l => l.status === 'activo' && daysTo(l.dueDate) <= 0).length;
  const tabs = [['caja','🧾 Caja'],['resumen','Resumen'],['clientes','Clientes'],['apartados','Apartados' + (lay ? ` ⏰${lay}` : '')],['rifas','Rifas'],['movimientos','Movimientos' + (pend ? ` (${pend})` : '')],['menu','Menú'],['inventario','Inventario' + (low ? ` ⚠${low}` : '')],['ajustes','Ajustes']];
  const body = {caja:adminCaja, resumen:adminResumen, clientes:adminClientes, apartados:adminApartados, rifas:adminRifas, movimientos:adminMov, menu:adminMenu, inventario:adminInventario, ajustes:adminAjustes}[ui.tab]();
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
function cashDue() {
  const total = cartTotal();
  if (ui.pmode !== 'tarjeta') return total;
  const c = ui.pclient && client(ui.pclient);
  return c ? Math.max(0, total - Math.max(0, balance(c.id) - reserved(c.id))) : 0;
}
const methodSeg = () => `<div class="seg">${['efectivo', 'transferencia'].map(m => `<button class="${ui.pmethod===m?'on':''}" data-act="pmethod" data-v="${m}">${m==='efectivo'?'💵 Efectivo':'🏦 Transferencia'}</button>`).join('')}</div>`;
const payBox = due => ui.pmethod === 'efectivo'
  ? `<label>Recibido (opcional)</label><input id="recv" inputmode="numeric" value="${esc(ui.precv)}" placeholder="Ej. 50000"><div id="chg" class="muted" style="margin-top:4px">${changeText(due)}</div>`
  : `<div class="hint">${esc(S.db.settings.bank)}</div>`;
function cartPanel() {
  const lines = cartLines(), total = cartTotal(), tarjeta = ui.pmode === 'tarjeta';
  let who = '', split = '', blocked = false, due = 0;
  if (tarjeta) {
    const c = ui.pclient && client(ui.pclient);
    if (c) {
      const av = Math.max(0, balance(c.id) - reserved(c.id));
      who = `<div class="hint"><b>${esc(c.name)}</b> · ${esc(c.cardNo)}<br>Saldo disponible: <b>${COP(av)}</b>
        <button class="btn sm ghost" data-act="pclientclear" style="margin-left:6px">Cambiar</button></div>`;
      if (lines.length && total > av) {
        due = total - av;
        if (av > 0) split = `<div class="hint split">La tarjeta cubre <b>${COP(av)}</b>. Completa los <b>${COP(due)}</b> restantes en caja:</div>` + methodSeg() + payBox(due);
        else { blocked = true; split = `<div class="hint split">Esta tarjeta no tiene saldo disponible. Cobra el pedido en <b>Mostrador</b>.</div>`; }
      }
    } else {
      const qq = ui.pcq.toLowerCase();
      const res = S.db.clients.filter(c => !qq || (c.name + ' ' + c.user + ' ' + c.phone + ' ' + c.cardNo).toLowerCase().includes(qq)).slice(0, 6);
      who = `<input data-pcsearch type="search" placeholder="Buscar cliente (nombre, usuario, tarjeta)" value="${esc(ui.pcq)}">
        <div class="clist">${res.length ? res.map(c => `<button class="crow" data-act="pclient" data-id="${c.id}"><span>${esc(c.name)}<small class="muted"> ${esc(c.cardNo)}</small></span><b>${COP(Math.max(0, balance(c.id) - reserved(c.id)))}</b></button>`).join('') : '<div class="empty">Sin resultados</div>'}</div>`;
    }
  } else {
    who = methodSeg() + payBox(total);
  }
  const label = !tarjeta ? 'Cobrar ' + COP(total) : (due > 0 && !blocked ? 'Enviar cobro · +' + COP(due) + ' en caja' : 'Enviar cobro al cliente');
  return `<h3>Pedido</h3>
    <div class="seg" style="margin:8px 0"><button class="${!tarjeta?'on':''}" data-act="pmode" data-v="mostrador">Mostrador</button><button class="${tarjeta?'on':''}" data-act="pmode" data-v="tarjeta">💳 Tarjeta de regalo</button></div>
    ${who}${split}
    <div class="cart">${lines.length ? lines.map(({p, q}) => `<div class="cline"><div class="n">${esc(p.name)}<div class="muted">${COP(p.price)}</div></div>
      <div class="qty-ctl"><button class="btn sm ghost" data-act="cdec" data-id="${p.id}" aria-label="Menos">−</button><b>${q}</b><button class="btn sm ghost" data-act="cinc" data-id="${p.id}" aria-label="Más">+</button></div>
      <b class="lt">${COP(p.price * q)}</b></div>`).join('') : '<div class="empty">Toca los productos para agregarlos.</div>'}</div>
    <input id="pnote" placeholder="Nota (mesa, nombre, pedido…)" value="${esc(ui.pnote)}">
    <div class="total">Total: ${COP(total)}</div>
    <div class="row" style="margin-top:10px"><button class="btn ghost fit" data-act="clearcart" ${lines.length?'':'disabled'}>Vaciar</button>
      <button class="btn ${tarjeta?'cel':'ok'}" data-act="checkout" ${lines.length && !blocked ? '' : 'disabled'}>${label}</button></div>
    ${tarjeta ? `<p class="muted">El descuento de la tarjeta se aplica cuando el cliente confirme desde su cuenta.${due > 0 && !blocked ? ' El complemento (' + COP(due) + ') se cobra en caja ahora.' : ''}</p>` : ''}`;
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
  const pend = S.db.tx.filter(t => t.status === 'pendiente').length + S.db.layaways.reduce((n, l) => n + (l.abonos || []).filter(a => !a.voided && abSt(a) === 'pendiente').length, 0);
  const tr = conf.filter(t => t.type === 'recharge' && t.method === 'transferencia').reduce((s, t) => s + t.amount, 0);
  const hoy = conf.filter(t => t.type !== 'recharge' && isToday(t.resolved || t.created));
  const hoySales = hoy.filter(t => t.type === 'sale');
  const hoyRec = conf.filter(t => t.type === 'recharge' && isToday(t.resolved || t.created)).reduce((s, t) => s + t.amount, 0);
  const sum = a => a.reduce((s, t) => s + t.amount + (t.topup || 0), 0);
  const hoyTop = hoy.reduce((s, t) => s + (t.topup || 0), 0);
  const layAct = S.db.layaways.filter(l => l.status === 'activo');
  const abonosHoy = S.db.layaways.reduce((s, l) => s + l.abonos.filter(a => abOk(a) && !a.refunded && isToday(a.created)).reduce((x, a) => x + a.amount, 0), 0);
  const prox = [...layAct].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5);
  const cnt = {}; hoy.forEach(t => (t.items || []).forEach(i => { cnt[i.name] = (cnt[i.name] || 0) + i.qty; }));
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const alerts = S.db.products.filter(p => ['low', 'out'].includes(stockState(p)));
  const latest = [...S.db.tx].sort((a, b) => b.created - a.created).slice(0, 6);
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Ventas de hoy</span><b>${COP(sum(hoy))}</b><span>Mostrador ${COP(sum(hoySales))} · Tarjetas ${COP(sum(hoy) - sum(hoySales) - hoyTop)} · Complemento ${COP(hoyTop)}</span></div>
    <div class="stat"><span>Recargas de hoy</span><b>${COP(hoyRec)}</b></div>
    <div class="stat"><span>Pedidos de hoy</span><b>${hoy.length}</b><span>Ticket prom. ${COP(hoy.length ? Math.round(sum(hoy) / hoy.length) : 0)}</span></div>
    <div class="stat"><span>Esperando confirmación</span><b>${pend}</b></div>
    <div class="stat"><span>Clientes</span><b>${S.db.clients.length}</b></div>
    <div class="stat"><span>Apartados activos</span><b>${layAct.length}</b><span>Por cobrar ${COP(layAct.reduce((s, l) => s + layDue(l), 0))}</span></div>
    <div class="stat"><span>Abonos de hoy</span><b>${COP(abonosHoy)}</b></div>
    <div class="stat"><span>Saldo total en tarjetas</span><b>${COP(S.db.clients.reduce((s, c) => s + balance(c.id), 0))}</b></div>
    <div class="stat"><span>Recargas confirmadas</span><b>${COP(rec)}</b><span>Transf. ${COP(tr)} · Efectivo ${COP(rec - tr)}</span></div>
    <div class="stat"><span>Consumos con tarjeta</span><b>${COP(use)}</b></div></div>
    <div class="grid g2">
      <div class="card"><h3>Más vendidos hoy</h3>${top.length ? top.map(([n, q]) => `<div class="prow"><div class="n">${esc(n)}</div><b>${q}</b></div>`).join('') : '<div class="empty">Aún no hay ventas hoy.</div>'}</div>
      <div class="card"><h3>Alertas de inventario</h3>${alerts.length ? alerts.map(p => `<div class="prow"><div class="n">${esc(p.name)}</div><span class="badge b-${stockState(p)}">${stockState(p)==='out'?'Agotado':p.stock+' restantes'}</span></div>`).join('') : '<div class="empty">Todo en orden ✅</div>'}</div></div>
    <div class="card"><h3>Próximas entregas (apartados)</h3>${prox.length ? prox.map(l => `<div class="prow"><div class="n">${esc((client(l.clientId) || {}).name || '—')}<div class="muted">${fday(l.dueDate)} · saldo ${COP(layDue(l))}</div></div>${dueBadge(l)}</div>`).join('') : '<div class="empty">Sin apartados activos.</div>'}</div>
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
        <button class="btn sm gold" data-act="laynew" data-id="${c.id}">Apartar</button>
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
  if (ui.mpreview) return `<div class="row" style="margin-bottom:12px"><div class="fit"><button class="btn ghost" data-act="mpreview">← Volver al editor</button></div><span class="muted">Así ven el menú tus clientes en su cuenta.</span></div>` + menuHTML();
  const cats = [...new Set(S.db.products.map(p => p.cat))];
  const subs = S.db.settings.catSubs || {};
  return `<div class="card"><div class="row" style="margin-bottom:4px"><h3 style="flex:2">Menú de CHORILAB</h3><div class="fit"><button class="btn sm gold" data-act="mpreview">👁 Ver como cliente</button></div></div>
    <p class="muted">Lo que cambies aquí se actualiza en la Caja y en el Menú de tus clientes. Los productos ocultos no aparecen en ninguno de los dos. El stock se maneja en Inventario. En "Qué incluye" escribe una línea por ítem. Las categorías con la palabra "Bebida" se muestran como lista compacta.</p>
    ${cats.map(cat => `<div class="cat">${esc(cat)}</div>
      <form data-form="catsub" data-cat="${esc(cat)}" class="row" style="margin-bottom:6px"><div style="flex:3"><input name="sub" value="${esc(subs[cat] || '')}" placeholder="Subtítulo de la sección (opcional)" aria-label="Subtítulo"></div><div class="fit"><button class="btn sm ghost">Guardar subtítulo</button></div></form>
      ${S.db.products.filter(p => p.cat === cat).map(p => `<form data-form="prod" data-id="${p.id}" class="mrow ${p.active ? '' : 'off'}">
      <div class="row"><div><input name="cat" value="${esc(p.cat)}" list="cats" aria-label="Categoría"></div>
      <div style="flex:2"><input name="name" value="${esc(p.name)}" required aria-label="Nombre"></div>
      <div><input name="price" type="number" min="0" step="500" value="${p.price}" required aria-label="Precio"></div></div>
      <div class="row"><div style="flex:3"><textarea name="desc" rows="3" placeholder="Qué incluye (una línea por ítem)" aria-label="Qué incluye">${esc(p.desc)}</textarea></div>
      <label class="fit chk"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Visible</label>
      <div class="fit"><button class="btn sm cel">Guardar</button> <button type="button" class="btn sm ghost" data-act="delprod" data-id="${p.id}" aria-label="Eliminar">🗑</button></div></div></form>`).join('')}`).join('')}
    <datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="card"><h3>Agregar producto</h3><form data-form="newprod"><div class="row">
      <div><label>Categoría</label><input name="cat" list="cats" required></div>
      <div style="flex:2"><label>Nombre</label><input name="name" required></div>
      <div><label>Precio</label><input name="price" type="number" min="0" step="500" required></div></div>
      <div class="row"><div style="flex:3"><label>Qué incluye (una línea por ítem, opcional)</label><textarea name="desc" rows="3"></textarea></div>
      <div class="fit"><button class="btn gold">Agregar</button></div></div></form></div>`;
}

/* ----- Apartados ----- */
const dstr = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const todayStr = () => dstr(Date.now());
const fday = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', {weekday:'short', day:'numeric', month:'short', year:'numeric'}) : '—';
const daysTo = s => Math.round((new Date(s + 'T00:00:00') - new Date(new Date().setHours(0, 0, 0, 0))) / 864e5);
const layPaid = l => sumA((l.abonos || []).filter(abOk));
const layPend = l => sumA((l.abonos || []).filter(a => !a.voided && abSt(a) === 'pendiente'));
const layDue = l => Math.max(0, l.total - layPaid(l));
const layOpen = l => Math.max(0, l.total - layPaid(l) - layPend(l));
const layById = id => S.db.layaways.find(x => x.id === id);
const laySort = (a, b) => (a.status === 'activo') !== (b.status === 'activo') ? (a.status === 'activo' ? -1 : 1) : a.status === 'activo' ? a.dueDate.localeCompare(b.dueDate) : (b.cancelled || b.delivered || b.created) - (a.cancelled || a.delivered || a.created);
function dueBadge(l) {
  if (l.status === 'entregado') return `<span class="badge b-confirmada">Entregado ${new Date(l.delivered).toLocaleDateString('es-CO', {dateStyle:'medium'})}</span>`;
  if (l.status === 'cancelado') return '<span class="badge b-anulada">Cancelado</span>';
  const n = daysTo(l.dueDate);
  return n < 0 ? `<span class="badge b-out">Atrasado ${-n} d</span>` : n === 0 ? '<span class="badge b-low">Entrega hoy</span>' : n <= 3 ? `<span class="badge b-low">En ${n} d</span>` : `<span class="badge b-ok">En ${n} d</span>`;
}
function layCard(l, role) {
  const adm = role === 'admin';
  const c = client(l.clientId), paid = layPaid(l), due = layDue(l), pend = layPend(l), open = layOpen(l);
  const active = l.status === 'activo', cancelled = l.status === 'cancelado';
  const pct = l.total ? Math.min(100, Math.round(paid / l.total * 100)) : 100;
  const refundPend = cancelled && l.refundDue && !l.refundDone;
  const btns = `<div class="fit" style="white-space:nowrap">
    ${adm && active && open > 0 ? `<button class="btn sm ok" data-act="layabono" data-id="${l.id}">Abonar</button> ` : ''}
    ${adm && active && due === 0 ? `<button class="btn sm cel" data-act="laydeliver" data-id="${l.id}">Entregar</button> ` : ''}
    ${adm && refundPend ? `<button class="btn sm ok" data-act="layrefund" data-id="${l.id}">Marcar devuelto</button> ` : ''}
    ${!adm && active && pend > 0 ? `<button class="btn sm ok" data-act="ctab" data-v="tarjeta">Confirmar abono</button> ` : ''}
    <button class="btn sm ghost" data-act="laydetail" data-id="${l.id}">Ver</button></div>`;
  const notes = [];
  if (active && pend > 0) notes.push(adm ? `<b>Por confirmar: ${COP(pend)}</b> pagados con la tarjeta, esperando la clave del cliente.` : `<b>Tienes ${COP(pend)} por confirmar</b>: revisa "Mi tarjeta" y confirma el abono con tu clave.`);
  if (cancelled) {
    if (l.refundCard) notes.push(`↩ ${COP(l.refundCard)} volvieron al saldo de la tarjeta de regalo.`);
    if (l.refundDue) notes.push(l.refundDone ? `Devueltos ${COP(l.refundDue)} al cliente (efectivo/transferencia).` : `<b class="neg">Pendiente devolver ${COP(l.refundDue)} al cliente (efectivo/transferencia).</b>`);
  }
  return `<div class="card lay ${active ? '' : 'done'}">
    <div class="row" style="align-items:flex-start"><div style="flex:2 1 220px">
      ${adm ? `<b>${c ? esc(c.name) : '<i>cliente eliminado</i>'}</b><br>` : ''}
      <span class="muted">${itemsText(l.items)}</span>${l.note ? `<br><span class="muted">Nota: ${esc(l.note)}</span>` : ''}</div>
      <div class="fit" style="text-align:right"><div class="muted">Entrega</div><b>${fday(l.dueDate)}</b><br>${dueBadge(l)}</div></div>
    <div class="lbar" role="img" aria-label="Abonado ${pct}%"><i style="width:${pct}%"></i></div>
    <div class="row" style="margin-top:8px"><div><span class="muted">Abonado</span><br><b class="pos">${COP(paid)}</b></div>
      <div><span class="muted">Saldo</span><br>${cancelled ? '<b>—</b>' : `<b class="${due ? 'neg' : 'pos'}">${COP(due)}</b>`}</div>
      <div><span class="muted">Total</span><br><b>${COP(l.total)}</b></div>${btns}</div>
    ${notes.length ? `<div class="muted" style="margin-top:8px">${notes.join(' ')}</div>` : ''}</div>`;
}
function adminApartados() {
  const L = S.db.layaways, q = ui.lq.toLowerCase();
  const act = L.filter(l => l.status === 'activo');
  const late = act.filter(l => daysTo(l.dueDate) <= 0).length;
  const refunds = L.filter(l => l.status === 'cancelado' && l.refundDue && !l.refundDone);
  const cnt = {activo: act.length, entregado: L.filter(l => l.status === 'entregado').length, cancelado: L.filter(l => l.status === 'cancelado').length, todos: L.length};
  const list = L.filter(l => {
    if (ui.lfilter !== 'todos' && l.status !== ui.lfilter) return false;
    if (!q) return true;
    const c = client(l.clientId) || {};
    return ((c.name || '') + ' ' + (c.user || '') + ' ' + (c.cardNo || '') + ' ' + l.items.map(i => i.name).join(' ')).toLowerCase().includes(q);
  }).sort(laySort);
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Apartados activos</span><b>${act.length}</b></div>
    <div class="stat"><span>Abonado en activos</span><b>${COP(act.reduce((s, l) => s + layPaid(l), 0))}</b></div>
    <div class="stat"><span>Por cobrar</span><b>${COP(act.reduce((s, l) => s + layDue(l), 0))}</b></div>
    <div class="stat"><span>Entrega hoy o atrasados</span><b class="${late ? 'neg' : ''}">${late}</b></div>
    ${refunds.length ? `<div class="stat"><span>Devoluciones pendientes</span><b class="neg">${COP(refunds.reduce((s, l) => s + l.refundDue, 0))}</b><span>${refunds.length} apartado(s) cancelado(s)</span></div>` : ''}</div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2 1 160px">Apartados (${list.length})</h3>
      <input data-lsearch type="search" placeholder="Buscar…" value="${esc(ui.lq)}">
      <select data-lfilter aria-label="Estado">${[['todos', 'Todos'], ['activo', 'Activos'], ['entregado', 'Entregados'], ['cancelado', 'Cancelados']].map(([v, t]) => `<option value="${v}" ${ui.lfilter === v ? 'selected' : ''}>${t} (${cnt[v]})</option>`).join('')}</select>
      <div class="fit"><button class="btn gold" data-act="laynew">+ Nuevo apartado</button></div></div>
      <p class="muted">Un apartado reserva productos para un cliente: el stock se descuenta al crearlo, el cliente va abonando (en caja o con su tarjeta de regalo) y se entrega cuando el saldo llega a $0. Los cancelados quedan en la lista, con su devolución.</p></div>
    ${list.length ? list.map(l => layCard(l, 'admin')).join('') : '<div class="card"><div class="empty">No hay apartados en esta vista.</div></div>'}`;
}
function clientApartados(c) {
  const list = S.db.layaways.filter(l => l.clientId === c.id).sort(laySort);
  return `<p class="muted" style="margin-top:0">Aquí ves lo que tienes apartado, cuánto llevas abonado y la fecha de entrega.</p>`
    + (list.length ? list.map(l => layCard(l, 'client')).join('') : '<div class="card"><div class="empty">No tienes apartados.</div></div>');
}

/* ----- Rifas ----- */
const raffleById = id => S.db.raffles.find(r => r.id === id);
const raffleState = r => r.win ? 'sorteada' : r.closed ? 'cerrada' : todayStr() < r.start ? 'programada' : todayStr() > r.end ? 'finalizada' : 'activa';
const rRank = {activa:0, programada:1, finalizada:2, sorteada:3, cerrada:4};
const rW = r => String(r.size - 1).length;
const rNum = (r, n) => String(n).padStart(rW(r), '0');
const rGrant = (r, cid) => r.grants.filter(g => g.clientId === cid).reduce((s, g) => s + g.qty, 0);
const rPicksOf = (r, cid) => r.picks.filter(p => p.clientId === cid).map(p => p.n).sort((a, b) => a - b);
const rLeft = (r, cid) => rGrant(r, cid) - rPicksOf(r, cid).length;
const rGranted = r => r.grants.reduce((s, g) => s + g.qty, 0);
const rOwner = (r, n) => r.picks.find(p => p.n === n);
const rSort = (a, b) => rRank[raffleState(a)] - rRank[raffleState(b)] || b.start.localeCompare(a.start);
const rBadge = r => ({activa:'<span class="badge b-ok">Activa</span>', programada:'<span class="badge b-low">Programada</span>', finalizada:'<span class="badge b-use">Periodo terminado</span>', sorteada:'<span class="badge b-confirmada">Con ganador</span>', cerrada:'<span class="badge b-anulada">Cerrada</span>'})[raffleState(r)];
const rRange = r => `${rNum(r, 0)}–${rNum(r, r.size - 1)}`;
const nchips = (r, list) => list.length ? `<div class="nchips">${list.map(n => `<span class="nchip">${rNum(r, n)}</span>`).join('')}</div>` : '';
const rHidden = (label, cls) => !!((ui.rq && !label.includes(ui.rq)) || (ui.rfree && /taken|mine|occ/.test(cls)));
function rFilter() {
  const qi = $('[data-rsearch]'), fi = $('[data-rfree]');
  ui.rq = qi ? qi.value.trim() : ''; ui.rfree = !!(fi && fi.checked);
  document.querySelectorAll('.rn').forEach(b => { b.hidden = rHidden(b.textContent, b.className); });
}
function updPick(r) {
  const left = rLeft(r, S.me.cid);
  document.querySelectorAll('.rn.sel').forEach(x => x.classList.remove('sel'));
  ui.rpick.forEach(n => { const x = document.querySelector(`.rn[data-n="${n}"]`); if (x) x.classList.add('sel'); });
  const c = $('#rcnt'); if (c) c.innerHTML = `<b>${ui.rpick.length}</b> de ${left} por elegir` + (ui.rpick.length ? ' · ' + ui.rpick.map(n => rNum(r, n)).join(', ') : '');
  const bt = $('[data-act=rconfirm]'); if (bt) bt.disabled = !ui.rpick.length;
}
function rCard(r) {
  const st = raffleState(r), pct = Math.round(r.picks.length / r.size * 100), granted = rGranted(r);
  return `<div class="card lay ${['activa', 'programada'].includes(st) ? '' : 'done'}"><div class="row" style="align-items:flex-start"><div style="flex:2 1 220px">
    <b>🎟 ${esc(r.name)}</b> ${rBadge(r)}<br><span class="muted">${r.prize ? 'Premio: ' + esc(r.prize) + ' · ' : ''}${r.size} números (${rRange(r)})</span></div>
    <div class="fit" style="text-align:right"><div class="muted">Periodo</div><b>${fday(r.start)}</b><br><span class="muted">hasta</span> <b>${fday(r.end)}</b></div></div>
    <div class="lbar" role="img" aria-label="Elegidos ${pct}%"><i style="width:${pct}%"></i></div>
    <div class="row" style="margin-top:8px"><div><span class="muted">Elegidos</span><br><b>${r.picks.length} / ${r.size}</b></div>
      <div><span class="muted">Cupos asignados</span><br><b>${granted}</b></div><div><span class="muted">Por elegir</span><br><b>${granted - r.picks.length}</b></div>
      <div class="fit"><button class="btn sm cel" data-act="ropen" data-id="${r.id}">Gestionar</button></div></div></div>`;
}
function adminRifas() {
  const r = ui.rid && raffleById(ui.rid);
  if (r) return adminRifaDetail(r);
  const list = [...S.db.raffles].sort(rSort), act = list.filter(x => raffleState(x) === 'activa');
  return `<div class="grid g4" style="margin-bottom:16px">
    <div class="stat"><span>Rifas activas</span><b>${act.length}</b></div>
    <div class="stat"><span>Números elegidos (activas)</span><b>${act.reduce((s, x) => s + x.picks.length, 0)}</b></div>
    <div class="stat"><span>Cupos sin usar (activas)</span><b>${act.reduce((s, x) => s + rGranted(x) - x.picks.length, 0)}</b></div></div>
    <div class="card"><div class="row"><h3 style="flex:2 1 160px">Rifas (${list.length})</h3><div class="fit"><button class="btn gold" data-act="rnew">+ Nueva rifa</button></div></div>
      <p class="muted">Crea una rifa con su periodo, la cantidad de números (10, 100 o 1000) y sus reglas. Luego asigna a cada cliente cuántos números puede elegir: él los escoge desde su cuenta, en la pestaña Rifas, mientras la rifa esté activa.</p></div>
    ${list.length ? list.map(rCard).join('') : '<div class="card"><div class="empty">Aún no hay rifas.</div></div>'}`;
}
function adminRifaDetail(r) {
  const st = raffleState(r), granted = rGranted(r), pct = Math.round(r.picks.length / r.size * 100);
  const cl = [...new Set(r.grants.map(g => g.clientId))].map(client).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const hist = [...r.grants].sort((a, b) => b.created - a.created).slice(0, 12);
  const wo = r.win && rOwner(r, r.win.n), wc = wo && client(wo.clientId);
  const canGrant = ['activa', 'programada'].includes(st);
  return `<div class="row" style="margin-bottom:12px"><div class="fit"><button class="btn ghost" data-act="rback">← Rifas</button></div></div>
    <div class="card"><div class="row" style="align-items:flex-start"><div style="flex:2 1 260px"><h3>🎟 ${esc(r.name)} ${rBadge(r)}</h3>
      <div class="muted">${r.prize ? 'Premio: <b>' + esc(r.prize) + '</b> · ' : ''}${r.size} números (${rRange(r)}) · ${fday(r.start)} → ${fday(r.end)}</div></div>
      <div class="fit" style="white-space:nowrap"><button class="btn sm cel" data-act="redit" data-id="${r.id}">Editar</button>
      ${r.win ? '' : `<button class="btn sm ghost" data-act="rclose" data-id="${r.id}">${r.closed ? 'Reabrir' : 'Cerrar rifa'}</button>`}
      <button class="btn sm ghost" data-act="rdelete" data-id="${r.id}" aria-label="Eliminar">🗑</button></div></div>
      <div class="cat">Descripción y reglas</div><div class="rules">${r.desc ? esc(r.desc) : '<span class="muted">Sin descripción.</span>'}</div>
      <div class="lbar" role="img" aria-label="Elegidos ${pct}%"><i style="width:${pct}%"></i></div>
      <div class="row" style="margin-top:8px"><div><span class="muted">Elegidos</span><br><b>${r.picks.length} / ${r.size}</b></div>
        <div><span class="muted">Cupos asignados</span><br><b>${granted}</b></div><div><span class="muted">Por elegir</span><br><b>${granted - r.picks.length}</b></div>
        <div><span class="muted">Sin asignar</span><br><b>${r.size - granted}</b></div></div></div>
    <div class="card"><div class="row" style="margin-bottom:8px"><h3 style="flex:2 1 160px">Cupos por cliente</h3>
      <div class="fit"><button class="btn gold" data-act="rgrant" data-id="${r.id}" ${canGrant ? '' : 'disabled'}>+ Asignar cupos</button></div></div>
      ${canGrant ? '' : '<p class="muted">Esta rifa ya no admite nuevos cupos. Puedes reabrirla o ajustar sus fechas con Editar.</p>'}
      ${cl.length ? `<div class="tw"><table><thead><tr><th>Cliente</th><th>Aprobados</th><th>Elegidos</th><th>Por elegir</th><th>Números</th><th></th></tr></thead><tbody>
      ${cl.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${rGrant(r, c.id)}</td><td>${rPicksOf(r, c.id).length}</td><td><b>${rLeft(r, c.id)}</b></td><td>${nchips(r, rPicksOf(r, c.id)) || '<span class="muted">—</span>'}</td>
        <td><button class="btn sm ghost" data-act="rgrant" data-id="${r.id}" data-cid="${c.id}" ${canGrant ? '' : 'disabled'}>Ajustar</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aún no asignas cupos a ningún cliente.</div>'}
      ${hist.length ? `<div class="cat">Últimas asignaciones</div>${hist.map(g => `<div class="prow"><div class="n">${esc((client(g.clientId) || {}).name || 'cliente eliminado')}<div class="muted">${fdate(g.created)}${g.note ? ' · ' + esc(g.note) : ''}</div></div><b class="${g.qty > 0 ? 'pos' : 'neg'}">${g.qty > 0 ? '+' : ''}${g.qty}</b></div>`).join('')}` : ''}</div>
    <div class="card"><h3>Número ganador</h3>
      ${r.win ? `<div class="hint" style="margin:8px 0">🏆 <b>${rNum(r, r.win.n)}</b> · ${wc ? esc(wc.name) : 'Nadie eligió este número'}</div>` : ''}
      ${st === 'programada' ? '<p class="muted">La rifa aún no empieza.</p>' : `<form data-form="rwin" data-id="${r.id}" class="row"><div><label>${r.win ? 'Cambiar el número ganador' : 'Registrar el número ganador'} (${rRange(r)})</label><input name="n" type="number" min="0" max="${r.size - 1}" step="1" required></div>
        <div class="fit"><button class="btn sm cel">Guardar</button>${r.win ? ' <button type="button" class="btn sm ghost" data-act="rwinclear" data-id="' + r.id + '">Quitar ganador</button>' : ''}</div></form>`}</div>
    <div class="card"><h3>Números</h3><p class="muted">Los amarillos ya fueron elegidos: toca uno para ver quién lo tiene o liberarlo.</p>
      <div class="rgrid ${r.size === 10 ? 'big' : ''}">${Array.from({length: r.size}, (_, n) => { const o = rOwner(r, n), c = o && client(o.clientId);
        return o ? `<button class="rn occ" data-act="rnumadm" data-id="${r.id}" data-n="${n}" title="${esc(c ? c.name : 'cliente eliminado')}">${rNum(r, n)}</button>` : `<button class="rn" disabled>${rNum(r, n)}</button>`; }).join('')}</div></div>`;
}
function rClientCard(c, r) {
  const st = raffleState(r), mine = rPicksOf(r, c.id), g = rGrant(r, c.id), left = g - mine.length;
  const wonMine = r.win && mine.includes(r.win.n);
  return `<div class="card lay ${['activa', 'programada'].includes(st) ? '' : 'done'}"><div class="row" style="align-items:flex-start"><div style="flex:2 1 220px">
    <b>🎟 ${esc(r.name)}</b> ${rBadge(r)}<br><span class="muted">${r.prize ? 'Premio: ' + esc(r.prize) + ' · ' : ''}${r.size} números (${rRange(r)})</span></div>
    <div class="fit" style="text-align:right"><div class="muted">Periodo</div><b>${fday(r.start)}</b><br><span class="muted">hasta</span> <b>${fday(r.end)}</b></div></div>
    ${r.win ? `<div class="hint">🏆 Número ganador: <b>${rNum(r, r.win.n)}</b>${wonMine ? ' · <b>¡Es tuyo, felicitaciones!</b>' : ''}</div>` : ''}
    <details style="margin-top:8px"><summary>Ver descripción y reglas</summary><div class="rules" style="margin-top:6px">${r.desc ? esc(r.desc) : 'Sin descripción.'}</div></details>
    <div class="row" style="margin-top:8px"><div><span class="muted">Cupos aprobados</span><br><b>${g}</b></div><div><span class="muted">Elegidos</span><br><b>${mine.length}</b></div><div><span class="muted">Por elegir</span><br><b class="${left > 0 && st === 'activa' ? 'pos' : ''}">${left}</b></div>
      <div class="fit"><button class="btn sm ${st === 'activa' && left > 0 ? 'ok' : 'ghost'}" data-act="cropen" data-id="${r.id}">${st === 'activa' && left > 0 ? 'Elegir mis números' : 'Ver números'}</button></div></div>
    ${mine.length ? `<div style="margin-top:8px"><span class="muted">Mis números</span>${nchips(r, mine)}</div>` : ''}</div>`;
}
function clientRifas(c) {
  const r = ui.crid && raffleById(ui.crid);
  if (r) return clientRifaDetail(c, r);
  const list = [...S.db.raffles].sort(rSort);
  return `<p class="muted" style="margin-top:0">Aquí ves las rifas de CHORILAB, tus cupos aprobados y eliges tus números.</p>`
    + (list.length ? list.map(x => rClientCard(c, x)).join('') : '<div class="card"><div class="empty">Por ahora no hay rifas.</div></div>');
}
function clientRifaDetail(c, r) {
  const st = raffleState(r), mine = rPicksOf(r, c.id), g = rGrant(r, c.id), left = g - mine.length, canPick = st === 'activa' && left > 0;
  ui.rpick = ui.rpick.filter(n => !rOwner(r, n)).slice(0, Math.max(0, left));
  const msg = st === 'programada' ? `La elección de números abre el ${fday(r.start)}.`
    : st === 'finalizada' ? 'El periodo de esta rifa terminó: ya no se pueden elegir números.'
    : st === 'cerrada' ? 'Esta rifa está cerrada.' : st === 'sorteada' ? 'Esta rifa ya tiene número ganador.'
    : g === 0 ? 'Aún no tienes cupos aprobados en esta rifa. Pídelos en CHORILAB y aparecerán aquí.'
    : left === 0 ? 'Ya elegiste todos tus números. ¡Mucha suerte! 🍀' : '';
  const wonMine = r.win && mine.includes(r.win.n);
  return `<div class="row" style="margin-bottom:12px"><div class="fit"><button class="btn ghost" data-act="rback">← Rifas</button></div></div>
    <div class="card"><h3>🎟 ${esc(r.name)} ${rBadge(r)}</h3>
      <div class="muted">${r.prize ? 'Premio: <b>' + esc(r.prize) + '</b> · ' : ''}${r.size} números (${rRange(r)}) · ${fday(r.start)} → ${fday(r.end)}</div>
      ${r.win ? `<div class="hint">🏆 Número ganador: <b>${rNum(r, r.win.n)}</b>${wonMine ? ' · <b>¡Es tuyo, felicitaciones!</b>' : ''}</div>` : ''}
      <div class="cat">Descripción y reglas</div><div class="rules">${r.desc ? esc(r.desc) : 'Sin descripción.'}</div>
      <div class="row" style="margin-top:10px"><div><span class="muted">Cupos aprobados</span><br><b>${g}</b></div><div><span class="muted">Elegidos</span><br><b>${mine.length}</b></div><div><span class="muted">Por elegir</span><br><b class="${canPick ? 'pos' : ''}">${left}</b></div></div>
      ${mine.length ? `<div style="margin-top:8px"><span class="muted">Mis números</span>${nchips(r, mine)}</div>` : ''}
      ${msg ? `<div class="hint">${msg}</div>` : ''}</div>
    <div class="card"><h3>Números</h3>
      <p class="muted">${canPick ? 'Toca los números que quieras (hasta ' + left + '). Una vez confirmados no se pueden cambiar.' : 'Verde: tuyos · Gris tachado: ya elegidos por otras personas.'}</p>
      <div class="row"><div><input data-rsearch type="search" inputmode="numeric" placeholder="Buscar número…" value="${esc(ui.rq)}" autocomplete="off"></div>
        <label class="fit chk"><input type="checkbox" data-rfree ${ui.rfree ? 'checked' : ''}> Solo libres</label>
        ${canPick ? '<div class="fit"><button class="btn sm ghost" data-act="rrandom">🎲 Al azar</button> <button class="btn sm ghost" data-act="rclear">Limpiar</button></div>' : ''}</div>
      <div class="rgrid ${r.size === 10 ? 'big' : ''}">${Array.from({length: r.size}, (_, n) => {
        const o = rOwner(r, n), cls = mine.includes(n) ? 'mine' : o ? 'taken' : ui.rpick.includes(n) ? 'sel' : '', lab = rNum(r, n);
        return `<button class="rn ${cls}" data-act="rpick" data-n="${n}" ${canPick && !o ? '' : 'disabled'} ${rHidden(lab, cls) ? 'hidden' : ''}>${lab}</button>`; }).join('')}</div>
      ${canPick ? `<div class="rbar"><div id="rcnt"><b>${ui.rpick.length}</b> de ${left} por elegir${ui.rpick.length ? ' · ' + ui.rpick.map(n => rNum(r, n)).join(', ') : ''}</div><button class="btn ok" data-act="rconfirm" ${ui.rpick.length ? '' : 'disabled'}>Confirmar mis números</button></div>` : ''}</div>`;
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
  return `<div class="card"><h3>Menú y métodos de pago</h3><form data-form="settings">
      <label>Frase del menú (debajo del título)</label><textarea name="tag" rows="2">${esc(S.db.settings.tag)}</textarea>
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
/* ----- Página de menú (la ven los clientes; el admin la previsualiza) ----- */
const descLines = p => String(p.desc || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const isDrinkCat = c => /bebida/i.test(c);
const mLines = () => Object.entries(ui.mcart).map(([id, q]) => { const p = product(id); return p && p.active && stockState(p) !== 'out' && q > 0 ? {p, q: tracked(p) ? Math.min(q, p.stock) : q} : null; }).filter(Boolean);
const mTotal = ls => ls.reduce((s, l) => s + l.q * l.p.price, 0);
function mAdd(id, d) {
  const p = product(id); if (!p || !p.active) return;
  const n = (ui.mcart[id] || 0) + d;
  if (n <= 0) delete ui.mcart[id];
  else { if (tracked(p) && n > p.stock) return toast('Solo quedan ' + p.stock + ' de ' + p.name); ui.mcart[id] = n; }
  render();
}
function mCopy() {
  const ls = mLines(); if (!ls.length) return toast('Aún no has elegido nada');
  const txt = 'Pedido CHORILAB\n' + ls.map(({p, q}) => `${q} x ${p.name} - ${COP(q * p.price)}`).join('\n') + '\nTotal: ' + COP(mTotal(ls));
  try { navigator.clipboard.writeText(txt).then(() => toast('Pedido copiado'), () => toast('No se pudo copiar')); } catch (e) { toast('No se pudo copiar'); }
}
const mnCtrl = p => {
  const q = ui.mcart[p.id] || 0;
  if (stockState(p) === 'out') return '<button class="mn-add" disabled>Agotado</button>';
  return q === 0
    ? `<button class="mn-add" data-act="minc" data-id="${p.id}">Agregar</button>`
    : `<div class="mn-step"><button data-act="mdec" data-id="${p.id}" aria-label="Quitar uno">−</button><output>${q}</output><button data-act="minc" data-id="${p.id}" aria-label="Agregar uno">+</button></div>`;
};
const mnCard = p => {
  const sel = (ui.mcart[p.id] || 0) > 0 ? ' sel' : '', st = stockState(p), ls = descLines(p);
  return `<article class="mn-item${sel}${st === 'out' ? ' off' : ''}">${st === 'low' ? '<span class="mn-badge">¡Quedan pocas!</span>' : ''}<h3>${esc(p.name)}</h3>
    ${ls.length ? `<ul>${ls.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div style="flex:1"></div>'}
    <div class="mn-row"><span class="mn-price">${COP(p.price)}</span>${mnCtrl(p)}</div></article>`;
};
const mnDrink = p => {
  const sel = (ui.mcart[p.id] || 0) > 0 ? ' sel' : '', ls = descLines(p);
  return `<div class="mn-drink${sel}${stockState(p) === 'out' ? ' off' : ''}"><div class="n">${esc(p.name)}${ls[0] ? `<small>${esc(ls[0])}</small>` : ''}</div>
    <div class="r"><span class="mn-price">${COP(p.price)}</span>${mnCtrl(p)}</div></div>`;
};
function mnPanel(ls) {
  if (!ls.length) return '<p class="mn-emptyp">Aún no has elegido nada. Agrega un combo o una bebida.</p>';
  return '<h4>Tu pedido</h4>' + ls.map(({p, q}) => `<div class="mn-line"><div>${esc(p.name)}<br><small>${COP(p.price)} c/u</small></div>
    <div class="mn-step"><button data-act="mdec" data-id="${p.id}" aria-label="Quitar uno">−</button><output>${q}</output><button data-act="minc" data-id="${p.id}" aria-label="Agregar uno">+</button></div>
    <div class="sb">${COP(q * p.price)}</div></div>`).join('')
    + '<div class="mn-tools"><button class="mn-ghost" data-act="mcopy">Copiar pedido</button><button class="mn-ghost" data-act="mclear">Vaciar</button></div>';
}
function menuHTML() {
  const prods = S.db.products.filter(p => p.active);
  const cats = [...new Set(prods.map(p => p.cat))];
  const subs = S.db.settings.catSubs || {};
  const ls = mLines(), qty = ls.reduce((s, l) => s + l.q, 0), tot = mTotal(ls);
  const sections = cats.map(cat => {
    const drinks = isDrinkCat(cat);
    return `<section class="mn-sec"><h2>${esc(cat)}</h2>${subs[cat] ? `<p class="mn-subt">${esc(subs[cat])}</p>` : ''}
      <div class="${drinks ? 'mn-drinks' : 'mn-grid'}">${prods.filter(p => p.cat === cat).map(drinks ? mnDrink : mnCard).join('')}</div></section>`;
  }).join('');
  return `<div class="mn"><div class="mn-flag ar" aria-hidden="true"></div><div class="mn-flag de" aria-hidden="true"></div>
    <header class="mn-hero"><div class="mn-eyebrow">Choripanería · Menú</div><h1>CHORI<span>LAB</span></h1><p class="mn-tag">${esc(S.db.settings.tag)}</p></header>
    ${sections || '<p class="mn-emptyp" style="color:#55616D">El menú estará disponible pronto.</p>'}
    <footer class="mn-foot">Precios en pesos colombianos (COP). Elige tus productos y revisa el total en la barra inferior.</footer></div>
    <div class="mn-bar" role="region" aria-label="Tu pedido"><div class="mn-barin">
      ${ui.mopen ? `<div class="mn-panel">${mnPanel(ls)}</div>` : ''}
      <div class="mn-sum"><div class="mn-stats"><div><span class="lbl">Productos</span><span class="val">${qty}</span></div><div class="tot"><span class="lbl">Total</span><span class="val">${COP(tot)}</span></div></div>
      <button class="mn-toggle" data-act="mtoggle" aria-expanded="${ui.mopen}">${ui.mopen ? 'Ocultar' : 'Ver pedido'}</button></div></div></div>`;
}

function clientView() {
  const c = client(S.me.cid);
  const pend = pending(c.id);
  const pendAb = pendingAbonos(c.id);
  const hist = S.db.tx.filter(t => t.clientId === c.id && t.status !== 'pendiente').sort((a, b) => b.created - a.created);
  const tabs = `<div class="tabs"><button class="${ui.ctab==='tarjeta'?'on':''}" data-act="ctab" data-v="tarjeta">Mi tarjeta${pend.length + pendAb.length ? ` (${pend.length + pendAb.length})` : ''}</button><button class="${ui.ctab==='menu'?'on':''}" data-act="ctab" data-v="menu">Menú</button><button class="${ui.ctab==='apartados'?'on':''}" data-act="ctab" data-v="apartados">Mis apartados${(n => n ? ' (' + n + ')' : '')(S.db.layaways.filter(l => l.clientId === c.id && l.status === 'activo').length)}</button><button class="${ui.ctab==='rifas'?'on':''}" data-act="ctab" data-v="rifas">Rifas${(n => n ? ' (' + n + ')' : '')(S.db.raffles.filter(r => raffleState(r) === 'activa' && rLeft(r, c.id) > 0).length)}</button></div>`;
  if (ui.ctab === 'menu') return topbar(c.name) + `<main>${tabs}${menuHTML()}</main>`;
  if (ui.ctab === 'apartados') return topbar(c.name) + `<main>${tabs}${clientApartados(c)}</main>`;
  if (ui.ctab === 'rifas') return topbar(c.name) + `<main>${tabs}${clientRifas(c)}</main>`;
  return topbar(c.name) + `<main>${tabs}<div class="grid g2" style="align-items:start">
    <div>${cardHTML(c)}${reserved(c.id) ? `<p class="muted">Hay ${COP(reserved(c.id))} por confirmar (consumos y abonos de apartados).</p>` : ''}</div>
    <div class="card"><h3>Por confirmar (${pend.length + pendAb.length})</h3>
      <p class="muted">Cada recarga y cada uso de tu tarjeta necesita tu confirmación.</p>
      ${pendAb.map(({l, a}) => `<div class="card pend" style="margin:8px 0;padding:12px">
        <div><span class="badge b-sale">Abono apartado</span> <b>${COP(a.amount)}</b></div>
        <div class="muted">${fdate(a.created)} · Tarjeta de regalo</div>
        <div class="muted">${itemsText(l.items)} · Entrega ${fday(l.dueDate)}</div>
        <div style="margin-top:8px"><button class="btn sm ok" data-act="confirmabono" data-id="${l.id}" data-aid="${a.id}">Revisar y confirmar</button></div></div>`).join('')}
      ${pend.length ? pend.map(t => `<div class="card pend" style="margin:8px 0;padding:12px">
        <div><span class="badge b-${t.type}">${txLabel(t)}</span> <b>${COP(t.amount)}</b></div>
        <div class="muted">${fdate(t.created)}${t.type==='recharge' ? ' · ' + methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '') : ''}</div>
        ${t.items ? `<div class="muted">${itemsText(t.items)}</div>` : ''}
        ${t.topup ? `<div class="muted">Total del pedido: ${COP(t.amount + t.topup)} · el resto (${COP(t.topup)}) se paga en ${methodName(t.topupMethod).toLowerCase()}</div>` : ''}
        ${t.note ? `<div class="muted">Nota: ${esc(t.note)}</div>` : ''}
        <div style="margin-top:8px"><button class="btn sm ok" data-act="confirm" data-id="${t.id}">Revisar y confirmar</button></div></div>`).join('') : (pendAb.length ? '' : '<div class="empty">Nada pendiente ✅</div>')}</div></div>
    <div class="card"><h3>Mi historial</h3>${txTable(hist, 'client')}</div>
    <div class="card"><h3>Cambiar mi clave</h3><form data-form="mypass" class="row">
      <div><label>Clave actual</label><input type="password" name="old" required autocomplete="current-password"></div>
      <div><label>Nueva clave (mín. ${MINPASS})</label><input type="password" name="new" minlength="${MINPASS}" required autocomplete="new-password"></div>
      <div class="fit"><button class="btn cel">Cambiar</button></div></form></div></main>`;
}

function txDetail(t) {
  if (t.type === 'recharge') return methodName(t.method) + (t.ref ? ' · Ref: ' + esc(t.ref) : '');
  return (t.type === 'sale' ? methodName(t.method) + ' · ' : '') + itemsText(t.items) + (t.topup ? ' · Complemento ' + methodName(t.topupMethod).toLowerCase() + ' ' + COP(t.topup) : '');
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
      ${role==='admin'?`<td style="white-space:nowrap">${(t.type==='sale' || t.type==='use') && t.status==='confirmada' ? `<button class="btn sm ghost" data-act="ticket" data-id="${t.id}">Ticket</button> ` : ''}${canVoid ? `<button class="btn sm ghost" data-act="cancel" data-id="${t.id}">Anular</button>` : ''}</td>`:''}</tr>`;
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
    ${t.topup ? `<p class="muted">Total del pedido ${COP(t.amount + t.topup)}: ${COP(t.amount)} con tu tarjeta y ${COP(t.topup)} en ${methodName(t.topupMethod).toLowerCase()}.</p>` : ''}
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
function lcList(q, plain) {
  q = (q || '').toLowerCase();
  const res = S.db.clients.filter(c => !q || (c.name + ' ' + c.user + ' ' + (c.phone || '') + ' ' + c.cardNo).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
  return res.length ? res.map(c => `<button type="button" class="crow" data-act="lcpick" data-id="${c.id}"><span>${esc(c.name)}<small class="muted"> ${esc(c.cardNo)}${c.phone ? ' · ' + esc(c.phone) : ''}</small></span>${plain ? '' : `<b>${COP(Math.max(0, balance(c.id) - reserved(c.id)))}</b>`}</button>`).join('') : '<div class="empty">Sin resultados</div>';
}
const lcSel = (c, plain) => `<b>${esc(c.name)}</b> · ${esc(c.cardNo)}${plain ? '' : ' · saldo en tarjeta <b>' + COP(Math.max(0, balance(c.id) - reserved(c.id))) + '</b>'} <button type="button" class="btn sm ghost" data-act="lcchange" style="margin-left:6px">Cambiar</button>`;
function updCardHint() {
  const f = $('form[data-form=laynew]'); if (!f) return;
  const c = client(f.elements.cid.value);
  const av = c ? Math.max(0, balance(c.id) - reserved(c.id)) : 0;
  const hint = $('#payhint'), radio = f.querySelector('input[name=method][value=tarjeta]');
  hint.dataset.card = c ? (av > 0 ? `Se descuenta de la tarjeta de ${c.name} (disponible ${COP(av)}). El cliente debe confirmarlo con su clave desde su cuenta.` : `${c.name} no tiene saldo disponible en la tarjeta.`) : 'Elige primero un cliente.';
  radio.disabled = !(c && av > 0);
  if (radio.disabled && radio.checked) { f.querySelector('input[name=method][value=efectivo]').checked = true; $('#refbox').hidden = true; hint.textContent = S.db.settings.cash; }
  else if (radio.checked) hint.textContent = hint.dataset.card;
}
function updLay() {
  const f = $('form[data-form=laynew]'); if (!f) return;
  let s = 0, n = 0;
  f.querySelectorAll('.qty').forEach(i => { const q = Math.floor(+i.value) || 0; if (q > 0) { s += q * +i.dataset.price; n += q; } });
  const ab = Math.max(0, Math.round(+f.elements.amount.value || 0));
  $('#tot').textContent = COP(s);
  $('#cnt').textContent = n ? n + (n === 1 ? ' unidad' : ' unidades') : 'sin productos';
  f.elements.amount.max = s || '';
  $('#lsaldo').innerHTML = s ? (ab > s ? '<span class="neg">El abono supera el total.</span>' : `Saldo después del abono: <b>${COP(s - ab)}</b>`) : '';
}
function openLayNew(cid) {
  if (!S.db.clients.length) return toast('Primero crea un cliente');
  const prods = S.db.products.filter(p => p.active && stockState(p) !== 'out');
  const cats = [...new Set(prods.map(p => p.cat))];
  const pre = cid && client(cid);
  modal('Nuevo apartado', `<form data-form="laynew" data-optref>
    <label>Cliente</label>
    <input type="hidden" name="cid" value="${pre ? pre.id : ''}">
    <div id="lcsel" class="hint" style="margin-top:0" ${pre ? '' : 'hidden'}>${pre ? lcSel(pre) : ''}</div>
    <div id="lcbox" ${pre ? 'hidden' : ''}><input data-lcsearch type="search" placeholder="Buscar cliente por nombre, usuario, teléfono o tarjeta" autocomplete="off"><div class="clist" id="lclist">${lcList('')}</div></div>
    ${cats.map(cat => `<div class="cat">${esc(cat)}</div>${prods.filter(p => p.cat === cat).map(p =>
      `<div class="prow"><div class="n">${esc(p.name)}<div class="muted">${COP(p.price)}${tracked(p) ? ' · ' + p.stock + ' disp.' : ''}</div></div>
      <input class="qty" type="number" min="0" ${tracked(p) ? `max="${p.stock}"` : ''} value="0" name="q_${p.id}" data-price="${p.price}" aria-label="Cantidad ${esc(p.name)}"></div>`).join('')}`).join('')}
    <div class="row"><div><label>Fecha de entrega</label><input type="date" name="due" required min="${todayStr()}"></div>
    <div><label>Abono inicial (COP, opcional)</label><input name="amount" type="number" min="0" step="1" value="0"></div></div>
    <div id="lsaldo" class="muted" style="margin-top:4px"></div>
    <label>Método del abono</label>
    <div class="radio"><label><input type="radio" name="method" value="efectivo" checked> 💵 Efectivo</label>
    <label><input type="radio" name="method" value="transferencia"> 🏦 Transferencia</label>
    <label><input type="radio" name="method" value="tarjeta"> 💳 Tarjeta de regalo</label></div>
    <div class="hint" id="payhint">${esc(S.db.settings.cash)}</div>
    <div id="refbox" hidden><label>Referencia / comprobante de la transferencia</label><input name="ref"></div>
    <label>Nota (opcional)</label><input name="note" placeholder="Ej. para el cumpleaños de Sofía">
    <p class="muted">Los precios quedan fijos al crear el apartado y el stock se reserva desde ahora.</p>
    <div class="sticky-foot"><div class="total" style="margin:0">Total: <span id="tot">${COP(0)}</span> <small class="muted" id="cnt">sin productos</small></div>
      <button class="btn gold">Crear apartado</button></div></form>`);
  updCardHint(); updLay();
}
function openLayAbono(id) {
  const l = layById(id); if (!l) return;
  const c = client(l.clientId), open = layOpen(l), av = c ? Math.max(0, balance(c.id) - reserved(c.id)) : 0;
  if (open <= 0) return toast('No falta nada por abonar');
  const cardMsg = av > 0 ? `Se descuenta de la tarjeta (disponible ${COP(av)}). El cliente debe confirmarlo con su clave desde su cuenta.` : 'El cliente no tiene saldo disponible en la tarjeta.';
  modal('Abonar · ' + esc(c ? c.name : ''), `<form data-form="layabono" data-id="${id}">
    <div class="hint">Total ${COP(l.total)} · Abonado ${COP(layPaid(l))}${layPend(l) ? ' · Por confirmar ' + COP(layPend(l)) : ''} · <b>Falta ${COP(open)}</b></div>
    <label>Monto del abono (COP)</label><input name="amount" type="number" min="1" max="${open}" step="1" required>
    <div class="chips"><button type="button" class="btn sm ghost" data-act="amt" data-v="${open}">Pagar lo que falta (${COP(open)})</button>
      ${av > 0 ? `<button type="button" class="btn sm ghost" data-act="amtcard" data-v="${Math.min(open, av)}">Usar saldo de la tarjeta (${COP(Math.min(open, av))})</button>` : ''}</div>
    <label>Método de pago</label>
    <div class="radio"><label><input type="radio" name="method" value="efectivo" checked> 💵 Efectivo</label>
    <label><input type="radio" name="method" value="transferencia"> 🏦 Transferencia</label>
    <label><input type="radio" name="method" value="tarjeta" ${av > 0 ? '' : 'disabled'}> 💳 Tarjeta de regalo</label></div>
    <div class="hint" id="payhint" data-card="${esc(cardMsg)}">${esc(S.db.settings.cash)}</div>
    <div id="refbox" hidden><label>Referencia / comprobante de la transferencia</label><input name="ref"></div>
    <label>Nota (opcional)</label><input name="note">
    <button class="btn ok" style="width:100%;margin-top:12px">Registrar abono</button></form>`);
}
function openConfirmAbono(lid, aid) {
  const l = layById(lid), a = l && (l.abonos || []).find(x => x.id === aid);
  if (!l || !a || a.voided || abSt(a) !== 'pendiente' || l.clientId !== S.me.cid) return toast('Este abono ya no está pendiente');
  modal('Confirmar abono con tu tarjeta', `<form data-form="confirmabono" data-id="${lid}" data-aid="${aid}">
    <div class="total" style="text-align:left">−${COP(a.amount)}</div>
    <p class="muted">Abono al apartado: ${itemsText(l.items)}<br>Entrega: ${fday(l.dueDate)} · Total ${COP(l.total)} · Abonado ${COP(layPaid(l))}</p>
    ${a.note ? `<p class="muted">Nota: ${esc(a.note)}</p>` : ''}
    <label>Escribe tu clave para confirmar</label><input type="password" name="pass" autocomplete="current-password" required>
    <div class="row" style="margin-top:12px"><button class="btn ok">Confirmar</button>
    <button type="button" class="btn red" data-act="layreject" data-id="${lid}" data-aid="${aid}">Rechazar</button></div></form>`);
}
function openLayDetail(id) {
  const l = layById(id); if (!l) return;
  const adm = S.me.role === 'admin';
  if (!adm && l.clientId !== S.me.cid) return;
  const c = client(l.clientId), paid = layPaid(l), due = layDue(l), pend = layPend(l), open = layOpen(l), active = l.status === 'activo';
  const st = {activo:'Activo', entregado:'Entregado', cancelado:'Cancelado'}[l.status];
  const abLine = a => {
    const s = abSt(a);
    const tag = a.voided ? ' <i>(anulado)</i>' : a.refunded ? ' <i>(devuelto a la tarjeta)</i>' : s === 'pendiente' ? ' <i>(por confirmar)</i>' : s === 'rechazada' ? ' <i>(rechazado)</i>' : '';
    const dead = a.voided || a.refunded || s === 'rechazada';
    const canVoid = adm && active && !dead;
    return `<div class="tl"><span>${fdate(a.created)} · ${methodName(a.method)}${a.ref ? ' · ' + esc(a.ref) : ''}${a.note ? ' · ' + esc(a.note) : ''}${tag}</span><span>${dead ? '<s>' + COP(a.amount) + '</s>' : COP(a.amount)}${canVoid ? ` <button class="btn sm ghost noprint" data-act="layvoid" data-id="${l.id}" data-aid="${a.id}">Anular</button>` : ''}</span></div>`;
  };
  modal('Apartado · ' + esc(c ? c.name : 'cliente eliminado'), `<div class="ticket"><div style="text-align:center"><b>🌭 CHORILAB</b><br><span class="muted">Comprobante de apartado · #${esc(l.id)}</span></div>
    <hr><div class="tl"><span>Cliente</span><span>${esc(c ? c.name : '—')}</span></div>
    <div class="tl"><span>Entrega</span><b>${fday(l.dueDate)}</b></div><div class="tl"><span>Estado</span><span>${st}</span></div><hr>
    ${l.items.map(i => `<div class="tl"><span>${i.qty}× ${esc(i.name)}</span><span>${COP(i.qty * i.price)}</span></div>`).join('')}<hr>
    <div class="tl"><b>Total</b><b>${COP(l.total)}</b></div><div class="tl"><span>Abonado</span><span>${COP(paid)}</span></div>
    ${pend ? `<div class="tl"><span>Por confirmar</span><span>${COP(pend)}</span></div>` : ''}
    ${l.status === 'cancelado' ? '' : `<div class="tl"><b>Saldo</b><b>${COP(due)}</b></div>`}
    <hr><div class="muted">Abonos</div>
    ${(l.abonos || []).length ? l.abonos.map(abLine).join('') : '<div class="muted">Sin abonos todavía.</div>'}
    ${l.status === 'cancelado' ? `<hr><div class="muted">${l.refundCard ? '↩ ' + COP(l.refundCard) + ' devueltos al saldo de la tarjeta.<br>' : ''}${l.refundDue ? (l.refundDone ? 'Devueltos ' + COP(l.refundDue) + ' al cliente (efectivo/transferencia).' : 'Pendiente devolver ' + COP(l.refundDue) + ' al cliente (efectivo/transferencia).') : ''}</div>` : ''}
    ${l.note ? `<hr><div class="muted">Nota: ${esc(l.note)}</div>` : ''}</div>
    ${adm && active ? `<form data-form="laydue" data-id="${id}" class="row noprint" style="margin-top:12px"><div><label>Cambiar fecha de entrega</label><input type="date" name="due" value="${esc(l.dueDate)}" min="${todayStr()}" required></div><div class="fit"><button class="btn sm cel">Guardar fecha</button></div></form>` : ''}
    <div class="row noprint" style="margin-top:12px">
      ${adm && active && open > 0 ? `<button class="btn ok fit" data-act="layabono" data-id="${id}">Abonar</button>` : ''}
      ${adm && active && due === 0 ? `<button class="btn cel fit" data-act="laydeliver" data-id="${id}">Marcar entregado</button>` : ''}
      ${adm && l.status === 'cancelado' && l.refundDue && !l.refundDone ? `<button class="btn ok fit" data-act="layrefund" data-id="${id}">Marcar devuelto</button>` : ''}
      <button class="btn gold fit" data-act="print">🖨 Imprimir</button>
      ${adm && active ? `<button class="btn red fit" data-act="laycancel" data-id="${id}">Cancelar apartado</button>` : ''}</div>
    ${adm && active && due > 0 ? '<p class="muted noprint">Para entregar, primero cobra el saldo pendiente con un abono.</p>' : ''}`);
}
const pickerHTML = (pre, plain) => `<input type="hidden" name="cid" value="${pre ? pre.id : ''}">
    <div id="lcsel" class="hint" style="margin-top:0" ${pre ? '' : 'hidden'}>${pre ? lcSel(pre, plain) : ''}</div>
    <div id="lcbox" ${pre ? 'hidden' : ''}><input data-lcsearch type="search" placeholder="Buscar cliente por nombre, usuario, teléfono o tarjeta" autocomplete="off"><div class="clist" id="lclist">${lcList('', plain)}</div></div>`;
function openRifaForm(id) {
  const r = id && raffleById(id);
  const v = r || {name:'', prize:'', desc:'', size:100, start:todayStr(), end:dstr(Date.now() + 14 * 864e5)};
  modal(r ? 'Editar rifa' : 'Nueva rifa', `<form data-form="rifa" ${r ? `data-id="${r.id}"` : ''}>
    <label>Nombre de la rifa</label><input name="name" value="${esc(v.name)}" required placeholder="Ej. Rifa de Navidad">
    <label>Premio (opcional)</label><input name="prize" value="${esc(v.prize)}" placeholder="Ej. Cena para 4 personas">
    <label>Descripción y reglas</label><textarea name="desc" rows="6" placeholder="Ej. Cada compra de $30.000 da derecho a un número. El ganador es quien tenga el número que coincida con las últimas cifras de la lotería del viernes…">${esc(v.desc)}</textarea>
    <label>Cantidad de números</label>
    <div class="radio">${[[10, '10 · 0 a 9'], [100, '100 · 00 a 99'], [1000, '1000 · 000 a 999']].map(([n, t]) => `<label><input type="radio" name="size" value="${n}" ${v.size === n ? 'checked' : ''}> ${t}</label>`).join('')}</div>
    <div class="row"><div><label>Empieza</label><input type="date" name="start" value="${esc(v.start)}" required></div><div><label>Termina</label><input type="date" name="end" value="${esc(v.end)}" required></div></div>
    <p class="muted">Los clientes solo pueden elegir números entre esas dos fechas (ambas incluidas). ${r && r.picks.length ? 'Ya hay números elegidos: no se puede cambiar la cantidad de números.' : ''}</p>
    <button class="btn gold" style="width:100%">${r ? 'Guardar cambios' : 'Crear rifa'}</button></form>`);
}
function openRifaGrant(rid, cid) {
  const r = raffleById(rid); if (!r) return;
  if (!['activa', 'programada'].includes(raffleState(r))) return toast('Esta rifa ya no admite asignar cupos');
  if (!S.db.clients.length) return toast('Primero crea un cliente');
  const pre = cid && client(cid);
  modal('Cupos · ' + esc(r.name), `<form data-form="rgrant" data-id="${rid}" data-plain>
    <div class="hint" style="margin-top:0">Números sin asignar: <b>${r.size - rGranted(r)}</b> de ${r.size}</div>
    <label>Cliente</label>${pickerHTML(pre, true)}
    <label>Acción</label>
    <div class="radio"><label><input type="radio" name="mode" value="add" checked> ➕ Agregar cupos</label><label><input type="radio" name="mode" value="remove"> ➖ Quitar cupos</label></div>
    <label>Cantidad de números</label><input name="qty" type="number" min="1" max="${r.size}" step="1" required>
    <label>Nota (opcional)</label><input name="note" placeholder="Ej. compró 3 combos">
    <p class="muted">El cliente elige esos números desde su cuenta, en la pestaña Rifas, mientras la rifa esté activa.</p>
    <button class="btn gold" style="width:100%">Guardar</button></form>`);
}
function openRifaNum(rid, n) {
  const r = raffleById(rid), o = r && rOwner(r, n); if (!r || !o) return;
  const c = client(o.clientId);
  modal('Número ' + rNum(r, n), `<p>Lo tiene <b>${esc(c ? c.name : 'un cliente eliminado')}</b>${c ? ' (' + esc(c.cardNo) + ')' : ''}.</p>
    <p class="muted">Elegido el ${fdate(o.created)}. Si lo liberas, el cliente recupera ese cupo y puede elegir otro número.</p>
    <div class="row"><button class="btn red fit" data-act="rrelease" data-id="${rid}" data-n="${n}">Liberar número</button><button class="btn ghost fit" data-act="close">Cerrar</button></div>`);
}
function openTicket(id) {
  const t = S.db.tx.find(x => x.id === id); if (!t) return;
  const isUse = t.type === 'use', top = t.topup || 0, total = t.amount + top;
  const cash = isUse ? top : t.amount, pm = isUse ? t.topupMethod : t.method;
  const recv = pm === 'efectivo' && t.received && t.received >= cash;
  modal('Ticket de venta', `<div class="ticket"><div style="text-align:center"><b>🌭 CHORILAB</b><br><span class="muted">${fdate(t.created)} · #${esc(t.id)}</span></div>
    <hr>${(t.items || []).map(i => `<div class="tl"><span>${i.qty}× ${esc(i.name)}</span><span>${COP(i.qty * i.price)}</span></div>`).join('')}<hr>
    <div class="tl"><b>Total</b><b>${COP(total)}</b></div>
    ${isUse ? `<div class="tl"><span>Tarjeta de regalo</span><span>${COP(t.amount)}</span></div>
      ${top ? `<div class="tl"><span>Complemento (${methodName(pm)})</span><span>${COP(top)}</span></div>` : ''}`
      : `<div class="tl"><span>Pago</span><span>${methodName(t.method)}</span></div>`}
    ${recv ? `<div class="tl"><span>Recibido</span><span>${COP(t.received)}</span></div><div class="tl"><span>Cambio</span><span>${COP(t.received - cash)}</span></div>` : ''}
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
  const rawRecv = method === 'efectivo' ? Math.round(+String(ui.precv).replace(/\D/g, '')) || 0 : 0;
  let topup = 0;
  const err = await mutate(st => {
    for (const it of items) {
      const p = st.db.products.find(x => x.id === it.id);
      if (!p) return 'Producto ya no disponible: ' + it.name;
      if (tracked(p) && p.stock < it.qty) return `Stock insuficiente de ${p.name} (quedan ${p.stock})`;
    }
    let cardPart = total; topup = 0;
    if (tarjeta) {
      if (!st.db.clients.some(c => c.id === cid)) return 'El cliente ya no existe';
      const av = balOf(st.db, cid) - resOf(st.db, cid);
      if (av <= 0) return 'La tarjeta no tiene saldo disponible. Cobra el pedido en Mostrador.';
      cardPart = Math.min(total, av); topup = total - cardPart;
    }
    const cashDueNow = tarjeta ? topup : total;
    if (cashDueNow > 0 && rawRecv && rawRecv < cashDueNow) return 'El valor recibido no cubre ' + COP(cashDueNow);
    items.forEach(it => { const p = st.db.products.find(x => x.id === it.id); if (tracked(p)) p.stock -= it.qty; });
    const now = Date.now();
    st.db.tx.push(tarjeta
      ? {id:txid, clientId:cid, type:'use', amount:cardPart, items, note, status:'pendiente', created:now, ...(topup ? {topup, topupMethod:method, received:rawRecv} : {})}
      : {id:txid, clientId:null, type:'sale', amount:total, items, method, received:rawRecv, note, status:'confirmada', created:now, resolved:now});
  });
  if (err) return toast(err);
  resetCart();
  if (tarjeta) { render(); toast('Cobro enviado: pendiente de confirmación del cliente' + (topup ? ` · Cobra ${COP(topup)} en ${methodName(method).toLowerCase()}` : '')); }
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
        const bal = balOf(st.db, t.clientId);
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
  async catsub(f, d) {
    const cat = f.dataset.cat, sub = d.get('sub').trim();
    const err = await mutate(st => { st.db.settings.catSubs = st.db.settings.catSubs || {}; if (sub) st.db.settings.catSubs[cat] = sub; else delete st.db.settings.catSubs[cat]; });
    toast(err || 'Subtítulo guardado');
  },
  async laynew(f, d) {
    const cid = d.get('cid'), due = d.get('due'), note = (d.get('note') || '').trim();
    if (!cid || !client(cid)) return toast('Elige el cliente del apartado');
    const items = []; let total = 0;
    S.db.products.forEach(p => { const q = Math.floor(+d.get('q_' + p.id) || 0); if (q > 0) { items.push({id:p.id, name:p.name, qty:q, price:p.price}); total += q * p.price; } });
    if (!items.length) return toast('Selecciona al menos un producto');
    if (!due) return toast('Indica la fecha de entrega');
    if (due < todayStr()) return toast('La fecha de entrega no puede ser anterior a hoy');
    const amount = Math.max(0, Math.round(+d.get('amount') || 0)), method = d.get('method'), ref = (d.get('ref') || '').trim();
    if (amount > total) return toast('El abono no puede ser mayor al total (' + COP(total) + ')');
    if (amount > 0 && method === 'transferencia' && !ref) return toast('Indica la referencia de la transferencia');
    const card = amount > 0 && method === 'tarjeta';
    const err = await mutate(st => {
      if (!st.db.clients.some(c => c.id === cid)) return 'El cliente ya no existe';
      for (const it of items) {
        const p = st.db.products.find(x => x.id === it.id);
        if (!p) return 'Producto ya no disponible: ' + it.name;
        if (tracked(p) && p.stock < it.qty) return `Stock insuficiente de ${p.name} (quedan ${p.stock})`;
      }
      if (card) { const av = balOf(st.db, cid) - resOf(st.db, cid); if (amount > av) return 'Saldo insuficiente en la tarjeta (disponible ' + COP(Math.max(0, av)) + ')'; }
      items.forEach(it => { const p = st.db.products.find(x => x.id === it.id); if (tracked(p)) p.stock -= it.qty; });
      const now = Date.now();
      st.db.layaways.push({id:uid(), clientId:cid, items, total, dueDate:due, note, status:'activo', created:now,
        abonos: amount ? [{id:uid(), amount, method, ref, note:'Abono inicial', created:now, ...(card ? {status:'pendiente'} : {})}] : []});
    });
    if (err) return toast(err);
    closeModal(); render(); toast(card ? 'Apartado creado: el abono con tarjeta queda pendiente de confirmación del cliente' : 'Apartado creado');
  },
  async layabono(f, d) {
    const amount = Math.round(+d.get('amount')), method = d.get('method'), ref = (d.get('ref') || '').trim(), note = (d.get('note') || '').trim();
    if (!(amount > 0)) return toast('Monto inválido');
    if (method === 'transferencia' && !ref) return toast('Indica la referencia de la transferencia');
    const card = method === 'tarjeta';
    const err = await mutate(st => {
      const l = st.db.layaways.find(x => x.id === f.dataset.id);
      if (!l || l.status !== 'activo') return 'Este apartado ya no está activo';
      const ab = l.abonos || [];
      const open = l.total - sumA(ab.filter(abOk)) - sumA(ab.filter(a => !a.voided && abSt(a) === 'pendiente'));
      if (amount > open) return 'El abono supera lo que falta (' + COP(Math.max(0, open)) + ')';
      if (card) { const av = balOf(st.db, l.clientId) - resOf(st.db, l.clientId); if (amount > av) return 'Saldo insuficiente en la tarjeta (disponible ' + COP(Math.max(0, av)) + ')'; }
      l.abonos.push({id:uid(), amount, method, ref, note, created:Date.now(), ...(card ? {status:'pendiente'} : {})});
    });
    if (err) return toast(err);
    closeModal(); render(); toast(card ? 'Abono enviado: queda pendiente de confirmación del cliente' : 'Abono registrado');
  },
  async confirmabono(f, d) {
    if (!(await checkPass(d.get('pass') || ''))) return toast('Clave incorrecta');
    const err = await mutate(st => {
      const l = st.db.layaways.find(x => x.id === f.dataset.id && x.clientId === S.me.cid);
      const a = l && l.status === 'activo' && l.abonos.find(x => x.id === f.dataset.aid);
      if (!a || a.voided || abSt(a) !== 'pendiente') return 'Este abono ya no está pendiente';
      if (a.amount > balOf(st.db, l.clientId)) return 'Saldo insuficiente';
      a.status = 'confirmada'; a.confirmedAt = Date.now();
    });
    if (err) return toast(err);
    closeModal(); render(); toast('Abono confirmado ✅');
  },
  async laydue(f, d) {
    const due = d.get('due'); if (!due) return toast('Indica la fecha');
    if (due < todayStr()) return toast('La fecha de entrega no puede ser anterior a hoy');
    const err = await mutate(st => {
      const l = st.db.layaways.find(x => x.id === f.dataset.id);
      if (!l || l.status !== 'activo') return 'Este apartado ya no está activo';
      l.dueDate = due;
    });
    if (err) return toast(err);
    render(); openLayDetail(f.dataset.id); toast('Fecha actualizada');
  },
  async rifa(f, d) {
    const id = f.dataset.id, nid = uid();
    const name = d.get('name').trim(), prize = d.get('prize').trim(), desc = d.get('desc').trim(), size = +d.get('size'), start = d.get('start'), end = d.get('end');
    if (!name) return toast('Escribe el nombre de la rifa');
    if (![10, 100, 1000].includes(size)) return toast('Elige 10, 100 o 1000 números');
    if (!start || !end) return toast('Indica el periodo de la rifa');
    if (end < start) return toast('La fecha final no puede ser anterior a la inicial');
    if (!id && end < todayStr()) return toast('La rifa ya estaría terminada: elige una fecha final desde hoy');
    const err = await mutate(st => {
      if (id) {
        const r = st.db.raffles.find(x => x.id === id); if (!r) return 'La rifa ya no existe';
        if (size !== r.size) {
          if (r.picks.length) return 'No puedes cambiar la cantidad de números: ya hay números elegidos';
          if (rGranted(r) > size) return 'Hay ' + rGranted(r) + ' cupos asignados, más que los ' + size + ' números';
          r.size = size;
        }
        Object.assign(r, {name, prize, desc, start, end});
      } else st.db.raffles.push({id:nid, name, prize, desc, size, start, end, closed:false, win:null, grants:[], picks:[], created:Date.now()});
    });
    if (err) return toast(err);
    if (!id) ui.rid = nid;
    closeModal(); render(); toast(id ? 'Rifa actualizada' : 'Rifa creada: ahora asigna cupos a tus clientes');
  },
  async rgrant(f, d) {
    const rid = f.dataset.id, cid = d.get('cid'), mode = d.get('mode'), qty = Math.floor(+d.get('qty')), note = (d.get('note') || '').trim();
    if (!cid || !client(cid)) return toast('Elige el cliente');
    if (!(qty > 0)) return toast('Indica una cantidad mayor a 0');
    const err = await mutate(st => {
      const r = st.db.raffles.find(x => x.id === rid); if (!r) return 'La rifa ya no existe';
      if (!['activa', 'programada'].includes(raffleState(r))) return 'Esta rifa ya no admite asignar cupos';
      if (!st.db.clients.some(c => c.id === cid)) return 'El cliente ya no existe';
      if (mode === 'remove') {
        const free = rGrant(r, cid) - rPicksOf(r, cid).length;
        if (qty > free) return 'Solo puedes quitar ' + Math.max(0, free) + ' cupo(s): los demás ya fueron elegidos';
        r.grants.push({id:uid(), clientId:cid, qty:-qty, note, created:Date.now()});
      } else {
        const free = r.size - rGranted(r);
        if (qty > free) return 'Solo quedan ' + free + ' número(s) sin asignar en esta rifa';
        r.grants.push({id:uid(), clientId:cid, qty, note, created:Date.now()});
      }
    });
    if (err) return toast(err);
    closeModal(); render(); toast(mode === 'remove' ? 'Cupos quitados' : 'Cupos asignados: el cliente ya puede elegir sus números');
  },
  async rwin(f, d) {
    if (d.get('n') === '') return toast('Escribe el número ganador');
    const n = Math.floor(+d.get('n'));
    const err = await mutate(st => {
      const r = st.db.raffles.find(x => x.id === f.dataset.id); if (!r) return 'La rifa ya no existe';
      if (raffleState(r) === 'programada') return 'La rifa aún no empieza';
      if (!Number.isInteger(n) || n < 0 || n >= r.size) return 'El número debe estar entre ' + rNum(r, 0) + ' y ' + rNum(r, r.size - 1);
      r.win = {n, created:Date.now()};
    });
    if (err) return toast(err);
    render(); toast('Número ganador registrado');
  },
  async settings(f, d) {
    const err = await mutate(st => { st.db.settings.bank = d.get('bank').trim(); st.db.settings.cash = d.get('cash').trim(); st.db.settings.tag = d.get('tag').trim(); });
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
  else if (a === 'tab') { ui.tab = b.dataset.v; ui.q = ''; ui.mpreview = false; ui.rid = null; render(); }
  else if (a === 'ctab') { ui.ctab = b.dataset.v; ui.crid = null; ui.rpick = []; render(); }
  else if (a === 'recharge') openRecharge(id);
  else if (a === 'use') { ui.tab = 'caja'; ui.pmode = 'tarjeta'; ui.pclient = id; render(); }
  else if (a === 'detail') openDetail(id);
  else if (a === 'confirm') openConfirm(id);
  else if (a === 'stock') openStock(id);
  else if (a === 'laynew') openLayNew(id);
  else if (a === 'layabono') openLayAbono(id);
  else if (a === 'laydetail') openLayDetail(id);
  else if (a === 'confirmabono') openConfirmAbono(id, b.dataset.aid);
  else if (a === 'layreject') {
    const aid = b.dataset.aid;
    run(async () => {
      const err = await mutate(st => {
        const l = st.db.layaways.find(x => x.id === id && x.clientId === S.me.cid);
        const ab = l && l.status === 'activo' && l.abonos.find(x => x.id === aid);
        if (!ab || ab.voided || abSt(ab) !== 'pendiente') return 'Este abono ya no está pendiente';
        ab.status = 'rechazada'; ab.resolved = Date.now();
      });
      if (err) return toast(err);
      closeModal(); render(); toast('Abono rechazado');
    });
  }
  else if (a === 'lcpick') {
    const c = client(id), f = b.closest('form'); if (!c || !f) return;
    f.elements.cid.value = id; $('#lcsel').innerHTML = lcSel(c, f.hasAttribute('data-plain')); $('#lcsel').hidden = false; $('#lcbox').hidden = true; if (f.dataset.form === 'laynew') updCardHint();
  }
  else if (a === 'lcchange') { $('#lcbox').hidden = false; $('#lcsel').hidden = true; const i = $('[data-lcsearch]'); if (i) i.focus(); }
  else if (a === 'laydeliver') {
    if (confirm('¿Marcar este apartado como entregado?')) run(async () => {
      const err = await mutate(st => {
        const l = st.db.layaways.find(x => x.id === id);
        if (!l || l.status !== 'activo') return 'Este apartado ya no está activo';
        const paid = sumA((l.abonos || []).filter(abOk));
        if (paid < l.total) return 'Aún hay saldo pendiente: ' + COP(l.total - paid);
        l.status = 'entregado'; l.delivered = Date.now();
      });
      if (err) return toast(err);
      closeModal(); render(); toast('Apartado entregado ✅');
    });
  }
  else if (a === 'laycancel') {
    const l = layById(id); if (!l) return;
    const back = sumA((l.abonos || []).filter(x => x.method === 'tarjeta' && abOk(x) && !x.refunded));
    const other = sumA((l.abonos || []).filter(x => x.method !== 'tarjeta' && abOk(x)));
    let msg = '¿Cancelar este apartado? El stock reservado vuelve al inventario.';
    if (back) msg += ' ' + COP(back) + ' pagados con la tarjeta vuelven al saldo de la tarjeta automáticamente.';
    if (other) msg += ' ' + COP(other) + ' abonados en efectivo/transferencia debes devolverlos al cliente (queda como devolución pendiente).';
    if (confirm(msg)) run(async () => {
      const err = await mutate(st => {
        const x = st.db.layaways.find(y => y.id === id);
        if (!x || x.status !== 'activo') return 'Este apartado ya no está activo';
        const now = Date.now(); let cardBack = 0, cashBack = 0;
        (x.abonos || []).forEach(ab => {
          if (ab.voided) return;
          if (ab.method === 'tarjeta') {
            if (abSt(ab) === 'confirmada') { ab.refunded = true; ab.refundedAt = now; cardBack += ab.amount; }
            else if (abSt(ab) === 'pendiente') { ab.status = 'rechazada'; ab.resolved = now; }
          } else if (abSt(ab) === 'confirmada') cashBack += ab.amount;
        });
        restock(st.db, x.items);
        x.status = 'cancelado'; x.cancelled = now; x.refundCard = cardBack; x.refundDue = cashBack; x.refundDone = false;
      });
      if (err) return toast(err);
      ui.lfilter = 'todos'; closeModal(); render(); toast('Apartado cancelado: sigue en la lista como "Cancelado"');
    });
  }
  else if (a === 'layrefund') {
    const l = layById(id); if (!l) return;
    if (confirm('¿Ya le devolviste ' + COP(l.refundDue) + ' al cliente?')) run(async () => {
      const err = await mutate(st => {
        const x = st.db.layaways.find(y => y.id === id);
        if (!x || x.status !== 'cancelado' || !x.refundDue || x.refundDone) return 'No hay una devolución pendiente';
        x.refundDone = true; x.refundedAt = Date.now();
      });
      if (err) return toast(err);
      closeModal(); render(); toast('Devolución registrada');
    });
  }
  else if (a === 'layvoid') {
    const aid = b.dataset.aid, l = layById(id), ab = l && (l.abonos || []).find(x => x.id === aid);
    if (!ab) return;
    const msg = '¿Anular este abono? Quedará marcado como anulado en el historial.' + (ab.method === 'tarjeta' && abSt(ab) === 'confirmada' ? ' Los ' + COP(ab.amount) + ' vuelven al saldo de la tarjeta.' : '');
    if (confirm(msg)) run(async () => {
      const err = await mutate(st => {
        const x = st.db.layaways.find(y => y.id === id);
        const z = x && x.status === 'activo' && x.abonos.find(w => w.id === aid);
        if (!z || z.voided || z.refunded || abSt(z) === 'rechazada') return 'Abono no encontrado';
        z.voided = true; z.voidedAt = Date.now();
      });
      if (err) return toast(err);
      render(); openLayDetail(id);
    });
  }
  /* rifas */
  else if (a === 'rnew') openRifaForm();
  else if (a === 'redit') openRifaForm(id);
  else if (a === 'ropen') { ui.rid = id; ui.rq = ''; ui.rfree = false; render(); window.scrollTo(0, 0); }
  else if (a === 'cropen') { ui.crid = id; ui.rpick = []; ui.rq = ''; ui.rfree = false; render(); window.scrollTo(0, 0); }
  else if (a === 'rback') { ui.rid = null; ui.crid = null; ui.rpick = []; render(); }
  else if (a === 'rgrant') openRifaGrant(id, b.dataset.cid);
  else if (a === 'rnumadm') openRifaNum(id, +b.dataset.n);
  else if (a === 'rclose') {
    const r = raffleById(id); if (!r) return;
    if (confirm(r.closed ? '¿Reabrir la rifa? Los clientes podrán volver a elegir números dentro del periodo.' : '¿Cerrar la rifa? Los clientes ya no podrán elegir números.')) run(async () => {
      const err = await mutate(st => { const x = st.db.raffles.find(y => y.id === id); if (!x) return 'La rifa ya no existe'; x.closed = !x.closed; });
      if (err) return toast(err); render();
    });
  }
  else if (a === 'rdelete') {
    const r = raffleById(id); if (!r) return;
    if (r.picks.length) return toast('Ya hay números elegidos: en lugar de eliminarla, ciérrala');
    if (confirm('¿Eliminar la rifa "' + r.name + '"? También se borran los cupos asignados.')) run(async () => {
      const err = await mutate(st => { const x = st.db.raffles.find(y => y.id === id); if (x && x.picks.length) return 'Ya hay números elegidos: ciérrala en lugar de eliminarla'; st.db.raffles = st.db.raffles.filter(y => y.id !== id); });
      if (err) return toast(err); ui.rid = null; render(); toast('Rifa eliminada');
    });
  }
  else if (a === 'rrelease') {
    const r = raffleById(id), n = +b.dataset.n; if (!r) return;
    if (confirm('¿Liberar el número ' + rNum(r, n) + '? El cliente recupera ese cupo.')) run(async () => {
      const err = await mutate(st => { const x = st.db.raffles.find(y => y.id === id); const i = x ? x.picks.findIndex(p => p.n === n) : -1; if (i < 0) return 'Ese número ya estaba libre'; x.picks.splice(i, 1); });
      if (err) return toast(err); closeModal(); render(); toast('Número liberado');
    });
  }
  else if (a === 'rwinclear') {
    if (confirm('¿Quitar el número ganador registrado?')) run(async () => {
      const err = await mutate(st => { const x = st.db.raffles.find(y => y.id === id); if (!x) return 'La rifa ya no existe'; x.win = null; });
      if (err) return toast(err); render();
    });
  }
  else if (a === 'rpick') {
    const r = raffleById(ui.crid); if (!r || raffleState(r) !== 'activa') return;
    const n = +b.dataset.n, left = rLeft(r, S.me.cid), i = ui.rpick.indexOf(n);
    if (i >= 0) ui.rpick.splice(i, 1);
    else { if (rOwner(r, n)) return; if (ui.rpick.length >= left) return toast('Solo puedes elegir ' + left + (left === 1 ? ' número' : ' números')); ui.rpick.push(n); }
    updPick(r);
  }
  else if (a === 'rclear') { const r = raffleById(ui.crid); ui.rpick = []; if (r) updPick(r); }
  else if (a === 'rrandom') {
    const r = raffleById(ui.crid); if (!r || raffleState(r) !== 'activa') return;
    const left = rLeft(r, S.me.cid), free = [];
    for (let n = 0; n < r.size; n++) if (!rOwner(r, n)) free.push(n);
    const k = Math.min(left, free.length);
    for (let i = 0; i < k; i++) { const j = i + crypto.getRandomValues(new Uint32Array(1))[0] % (free.length - i); [free[i], free[j]] = [free[j], free[i]]; }
    ui.rpick = free.slice(0, k); render();
  }
  else if (a === 'rconfirm') {
    const r = raffleById(ui.crid); if (!r || !ui.rpick.length) return;
    const nums = [...ui.rpick].sort((x, y) => x - y), rid = r.id, cid = S.me.cid;
    if (confirm('¿Confirmar ' + (nums.length === 1 ? 'el número ' : 'los números ') + nums.map(n => rNum(r, n)).join(', ') + '? Una vez confirmados no podrás cambiarlos.')) run(async () => {
      const err = await mutate(st => {
        const x = st.db.raffles.find(y => y.id === rid); if (!x) return 'La rifa ya no existe';
        if (raffleState(x) !== 'activa') return 'La elección de números no está abierta para esta rifa';
        const left = rGrant(x, cid) - rPicksOf(x, cid).length;
        if (nums.length > left) return 'Solo tienes ' + Math.max(0, left) + ' cupo(s) disponible(s)';
        for (const n of nums) {
          if (!Number.isInteger(n) || n < 0 || n >= x.size) return 'Número inválido';
          if (rOwner(x, n)) return 'El número ' + rNum(x, n) + ' ya fue elegido por otra persona. Elige otro.';
        }
        const now = Date.now(); nums.forEach(n => x.picks.push({n, clientId:cid, created:now}));
      });
      if (err) { render(); return toast(err); }
      ui.rpick = []; render(); toast('¡Números reservados! Mucha suerte 🍀');
    });
  }
  else if (a === 'ticket') openTicket(id);
  else if (a === 'print') window.print();
  else if (a === 'amt') { const i = $('input[name=amount]'); if (i) i.value = b.dataset.v; }
  else if (a === 'amtcard') {
    const i = $('input[name=amount]'); if (i) i.value = b.dataset.v;
    const r = $('input[name=method][value=tarjeta]'); if (r && !r.disabled) { r.checked = true; r.dispatchEvent(new Event('change', {bubbles:true})); }
  }
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
  /* menú */
  else if (a === 'minc') mAdd(id, 1);
  else if (a === 'mdec') mAdd(id, -1);
  else if (a === 'mclear') { ui.mcart = {}; render(); }
  else if (a === 'mtoggle') { ui.mopen = !ui.mopen; render(); }
  else if (a === 'mcopy') mCopy();
  else if (a === 'mpreview') { ui.mpreview = !ui.mpreview; render(); }
  /* movimientos */
  else if (a === 'reject') run(async () => { if (await setStatus(id, 'rechazada')) { closeModal(); render(); toast('Movimiento rechazado'); } });
  else if (a === 'cancel') {
    const t = S.db.tx.find(x => x.id === id); if (!t) return;
    const msg = t.status === 'confirmada' ? '¿Anular este movimiento ya confirmado? ' + (t.type === 'use' ? 'Se devolverá el saldo al cliente y el stock.' + (t.topup ? ' El complemento cobrado en ' + methodName(t.topupMethod).toLowerCase() + ' (' + COP(t.topup) + ') debes devolverlo aparte.' : '') : 'Se devolverá el stock.') : '¿Anular este movimiento pendiente?';
    if (confirm(msg)) run(async () => { if (await setStatus(id, 'anulada')) render(); });
  }
  else if (a === 'delclient') {
    const c = client(id); if (!c) return;
    if (S.db.layaways.some(l => l.clientId === id && l.status === 'activo')) return toast('Tiene apartados activos: entrégalos o cancélalos antes de eliminarlo');
    if (S.db.raffles.some(r => ['activa', 'programada'].includes(raffleState(r)) && r.picks.some(p => p.clientId === id))) return toast('Tiene números en una rifa vigente: libéralos antes de eliminarlo');
    if (confirm(`¿Eliminar a ${c.name}? Se borrarán también sus movimientos y apartados.`)) run(async () => {
      const idh = await userHash(c.user);
      const err = await mutate(st => { delete st.users[idh]; st.db.clients = st.db.clients.filter(x => x.id !== id); st.db.tx = st.db.tx.filter(t => t.clientId !== id); st.db.layaways = st.db.layaways.filter(l => l.clientId !== id); st.db.raffles.forEach(r => { r.grants = r.grants.filter(g => g.clientId !== id); r.picks = r.picks.filter(p => p.clientId !== id); }); });
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
  else if (t.matches('[data-lsearch]')) { ui.lq = t.value; render(); refocus('[data-lsearch]'); }
  else if (t.matches('[data-psearch]')) { ui.pq = t.value; render(); refocus('[data-psearch]'); }
  else if (t.matches('[data-pcsearch]')) { ui.pcq = t.value; render(); refocus('[data-pcsearch]'); }
  else if (t.matches('[data-rsearch]')) rFilter();
  else if (t.matches('[data-lcsearch]')) { const l = $('#lclist'); if (l) l.innerHTML = lcList(t.value, !!(t.form && t.form.hasAttribute('data-plain'))); }
  else if (t.classList.contains('qty') || (t.name === 'amount' && t.form && t.form.dataset.form === 'laynew')) updLay();
  else if (t.id === 'recv') { ui.precv = t.value; const c = $('#chg'); if (c) c.innerHTML = changeText(cashDue()); }
  else if (t.id === 'pnote') ui.pnote = t.value;
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-filter]')) { ui.filter = t.value; render(); }
  if (t.matches('[data-tfilter]')) { ui.tfilter = t.value; render(); }
  if (t.matches('[data-csort]')) { ui.csort = t.value; render(); }
  if (t.matches('[data-lfilter]')) { ui.lfilter = t.value; render(); }
  if (t.matches('[data-rfree]')) rFilter();
  if (t.name === 'method') {
    const tr = t.value === 'transferencia', tj = t.value === 'tarjeta', h = $('#payhint');
    $('#refbox').hidden = !tr; h.textContent = tj ? (h.dataset.card || '') : tr ? S.db.settings.bank : S.db.settings.cash;
    { const rb = $('#refbox input'); if (rb) rb.required = tr && !t.form.hasAttribute('data-optref'); }
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

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'Enter' && e.target.matches) {
    if (e.target.matches('[data-lcsearch]')) { e.preventDefault(); const b = $('#lclist .crow'); if (b) b.click(); }
    else if (e.target.matches('form[data-form=laynew] .qty')) e.preventDefault();
  }
});
boot();
})();
