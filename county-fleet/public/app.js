import {
  esc, num, kes, when, badge, statusBadge, scheduleBadge, expiryBadge, ROLE_LABEL, api, hooks, toast, openDialog, closeDialog,
  actions, forms, field, select, initEvents, applyWidths,
} from './lib.js';
import { ctx } from './ctx.js';
import { overview, fleet, maintenance, fuel } from './staff.js';
import { erp, users, audit, stopErpTimer } from './erp.js';

const app = document.getElementById('app');
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor" opacity=".18"/><path d="M5 20h22v-5l-4-5h-8v5H5z" fill="#f4c46a"/><circle cx="11" cy="22" r="3" fill="currentColor"/><circle cx="22" cy="22" r="3" fill="currentColor"/></svg>';
const STAFF = ['fleet_manager', 'workshop', 'finance'];

const NAV = [
  { id: 'overview', label: 'Overview', roles: STAFF, view: overview },
  { id: 'fleet', label: 'Fleet', roles: STAFF, view: fleet },
  { id: 'maintenance', label: 'Maintenance', roles: STAFF, view: maintenance },
  { id: 'fuel', label: 'Fuel', roles: ['fleet_manager', 'finance'], view: fuel, badge: true },
  { id: 'erp', label: 'ERP', roles: ['finance'], view: erp },
  { id: 'users', label: 'People', roles: [], view: users },
  { id: 'audit', label: 'Activity', roles: [], view: audit },
];
const allowed = (n) => ctx.user.role === 'admin' || n.roles.includes(ctx.user.role);

/* ---------- sign in ---------- */

function renderLogin(message = '') {
  stopErpTimer();
  ctx.user = null;
  app.innerHTML = `<div class="login"><div class="card"><div class="brand">${LOGO}<span>County Fleet<small>Uasin Gishu County</small></span></div>
    ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
    <form class="form" data-submit="login">${field('Email', 'email', { type: 'email', required: true, attrs: 'autocomplete="username" autofocus' })}${field('Password', 'password', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
    <div class="form-error" hidden></div><button type="submit" class="btn primary">Sign in</button></form></div></div>`;
}
forms.login = async (d) => {
  const r = await api('POST', '/api/login', d);
  ctx.user = r.user;
  await start();
};

function renderChangePassword() {
  stopErpTimer();
  app.innerHTML = `<div class="login"><div class="card"><div class="brand">${LOGO}<span>Choose a new password</span></div>
    <p class="muted">Your password is temporary. Choose your own: at least 10 characters with letters and numbers.</p>
    <form class="form" data-submit="chpw">${field('Temporary password', 'current', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })}${field('New password', 'next', { type: 'password', required: true, attrs: 'autocomplete="new-password" minlength="10"' })}
    <div class="form-error" hidden></div><button type="submit" class="btn primary">Save and continue</button></form></div></div>`;
}
forms.chpw = async (d) => { await api('POST', '/api/change-password', d); ctx.user.mustChangePassword = false; toast('Password changed.'); await start(); };

actions.logout = async () => { try { await api('POST', '/api/logout', {}); } catch { /* already signed out */ } renderLogin(); };

hooks.onUnauthorized = () => renderLogin('Please sign in again.');
hooks.onMustChange = () => renderChangePassword();

/* ---------- staff shell ---------- */

let current = null;
let cleanup = null;

function route() {
  const id = location.hash.replace('#/', '') || 'overview';
  return NAV.find((n) => n.id === id && allowed(n)) || NAV.find(allowed);
}

async function renderView() {
  const r = route();
  const main = document.getElementById('main');
  if (!main) return;
  document.querySelectorAll('.nav a').forEach((a) => (a.getAttribute('href') === `#/${r.id}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (current !== r.id) stopErpTimer();
  current = r.id;
  document.title = `${r.label} · County Fleet`;
  try {
    await r.view(main);
    applyWidths(main);
  } catch (e) {
    if (e.status === 401 || e.data?.mustChangePassword) return;
    main.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
  }
}

function renderShell() {
  const items = NAV.filter(allowed);
  app.innerHTML = `<div class="shell"><aside class="side"><div class="brand">${LOGO}<span>County Fleet<small>Uasin Gishu County</small></span></div>
    <nav class="nav" aria-label="Main">${items.map((n) => `<a href="#/${n.id}">${esc(n.label)}${n.badge ? '<span class="pill" id="pill-fuel" hidden></span>' : ''}</a>`).join('')}</nav>
    <div class="who"><div>${esc(ctx.user.name)}<br><span class="small">${esc(ROLE_LABEL[ctx.user.role])}</span></div><button data-action="logout">Sign out</button></div></aside>
    <main id="main" tabindex="-1"><p class="boot">Loading…</p></main></div>`;
  ctx.refresh = renderView;
  renderView();
  refreshPill();
}

async function refreshPill() {
  const pill = document.getElementById('pill-fuel');
  if (!pill) return;
  try {
    const rows = await api('GET', '/api/fuel?status=submitted');
    pill.textContent = rows.length;
    pill.hidden = !rows.length;
  } catch { /* the pill is only a convenience */ }
}
setInterval(() => { if (ctx.user && ctx.user.role !== 'driver') refreshPill(); }, 30000);
window.addEventListener('hashchange', () => { if (ctx.user && ctx.user.role !== 'driver') renderView(); });

/* ---------- driver (phone) ---------- */

async function renderDriver() {
  const render = async () => {
    const h = await api('GET', '/api/driver/home');
    ctx.driver = h;
    const unit = (a) => (a.fuel_basis === 'km' ? 'km' : 'hours');
    app.innerHTML = `<div class="phone">
      <header class="phone-head"><div><div class="muted small">Signed in as</div><strong>${esc(ctx.user.name)}</strong></div><button class="btn sm" data-action="logout">Sign out</button></header>
      ${h.assets.length ? h.assets.map((a) => `<section class="card vehicle"><div class="muted small">${esc(a.type)}</div><div class="name">${esc(a.plate)}</div>
        <div>${statusBadge(a.status)} ${scheduleBadge(a)}</div>
        <dl class="kv"><dt>${a.fuel_basis === 'km' ? 'Odometer' : 'Engine hours'}</dt><dd>${num(a.meter)} ${esc(a.unit)}</dd><dt>Working at</dt><dd>${esc(a.location || '–')}</dd><dt>Registration</dt><dd>${expiryBadge(a.registration)}</dd><dt>Insurance</dt><dd>${expiryBadge(a.insurance)}</dd></dl></section>`).join('')
        : '<section class="card"><p>No vehicle is assigned to you yet. Ask the fleet manager.</p></section>'}
      ${h.assets.length ? `<div class="big-actions"><button class="btn primary" data-action="d-fuel">Record fuel</button><button class="btn" data-action="d-fault">Report a fault</button></div>` : ''}
      ${h.jobs.length ? `<section class="card"><h2>In the workshop</h2><ul class="list">${h.jobs.map((j) => `<li><span>${esc(j.description)}<div class="small muted">${esc(j.plate)}</div></span>${statusBadge(j.status)}</li>`).join('')}</ul></section>` : ''}
      <section class="card"><h2>My recent fuel</h2>${h.fuel.length ? `<ul class="list">${h.fuel.map((f) => `<li><span>${num(f.litres, 1)} L, ${esc(f.plate)}<div class="small muted">${esc(when(f.created_at))}</div></span>${statusBadge(f.status)}</li>`).join('')}</ul>` : '<p class="muted">Nothing recorded yet.</p>'}</section>
    </div>`;
  };
  ctx.refresh = render;
  await render();
}

const pickAsset = (h) => (h.assets.length > 1 ? select('Vehicle', 'asset_id', h.assets.map((a) => [a.id, `${a.plate}, ${a.type}`]), h.assets[0].id) : `<input type="hidden" name="asset_id" value="${h.assets[0].id}">`);

actions['d-fuel'] = () => {
  const h = ctx.driver;
  const a = h.assets[0];
  openDialog('Record fuel', `<form class="form" data-submit="d-fuel-save">${pickAsset(h)}
    ${field('Litres put in', 'litres', { type: 'number', required: true, attrs: 'min="0.1" step="any" inputmode="decimal"' })}
    ${field(a.fuel_basis === 'km' ? 'Odometer now (km)' : 'Engine hours now', 'meter_reading', { type: 'number', hint: `last was ${num(a.meter)}`, attrs: `min="${a.meter}" step="any" inputmode="decimal"` })}
    ${field('Price per litre (KES)', 'unit_price', { type: 'number', value: h.dieselPrice, attrs: 'min="1" step="0.01" inputmode="decimal"' })}
    <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`);
};
forms['d-fuel-save'] = async (d) => {
  const body = { asset_id: Number(d.asset_id), litres: Number(d.litres) };
  if (d.meter_reading) body.meter_reading = Number(d.meter_reading);
  if (d.unit_price) body.unit_price = Number(d.unit_price);
  const f = await api('POST', '/api/fuel', body);
  closeDialog();
  toast(f.flag ? `Saved. That is ${num(Math.abs(f.variance_pct), 0)}% ${f.variance_pct > 0 ? 'more' : 'less'} than expected, so a manager will check it.` : `Saved. ${kes(f.total)} sent for approval.`);
  ctx.refresh();
};
actions['d-fault'] = () => openDialog('Report a fault', `<form class="form" data-submit="d-fault-save">${pickAsset(ctx.driver)}
  ${select('What is wrong?', 'category', ['Engine', 'Hydraulics', 'Tyres and wheels', 'Brakes', 'Transmission', 'Electrical', 'Body and cab', 'Other'].map((x) => [x, x]))}
  <label>Tell the workshop what you see<textarea name="description" required placeholder="For example: oil leaking under the boom, warning light on"></textarea></label>
  <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Send report</button></div></form>`);
forms['d-fault-save'] = async (d) => {
  await api('POST', '/api/report-fault', { ...d, asset_id: Number(d.asset_id) });
  closeDialog(); toast('Fault reported. The workshop has been told.'); ctx.refresh();
};

/* ---------- start ---------- */

async function start() {
  if (ctx.user.mustChangePassword) return renderChangePassword();
  ctx.assets = null; ctx.lookups = null;
  if (ctx.user.role === 'driver') return renderDriver();
  if (!location.hash) history.replaceState(null, '', '#/overview');
  renderShell();
}

initEvents();
try {
  const me = await api('GET', '/api/me');
  ctx.user = me.user;
  await start();
} catch (e) {
  if (e.status !== 401 && !e.data?.mustChangePassword) renderLogin(e.status === 0 ? e.message : '');
  else if (e.data?.mustChangePassword) renderChangePassword();
  else renderLogin();
}
