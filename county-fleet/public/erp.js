import {
  esc, num, kes, when, badge, statusBadge, ROLE_LABEL, api, toast, openDialog, closeDialog,
  actions, forms, table, field, select,
} from './lib.js';
import { ctx } from './ctx.js';

/* ---------- ERP console ---------- */

let oStatus = '';
let timer = null;
export const stopErpTimer = () => { clearInterval(timer); timer = null; };

export async function erp(main) {
  const render = async () => {
    const [o, box] = await Promise.all([api('GET', '/api/erp'), api('GET', `/api/erp/outbox${oStatus ? `?status=${oStatus}` : ''}`)]);
    const s = o.settings;
    const c = o.counts;
    const isAdmin = ctx.user.role === 'admin';
    const keyNote = s.adapter === 'file' ? '' : s.auth === 'oauth'
      ? (o.secrets.oauth ? badge('Client credentials set on the server', 'ok') : badge('Client ID, secret or token address missing on the server', 'bad'))
      : (o.secrets.apiKey || (o.demo.enabled && s.base_url.includes('/mock-erp')) ? badge(o.demo.enabled && s.base_url.includes('/mock-erp') ? 'Using the demo ERP key' : 'API key set on the server', 'ok') : badge('API key missing on the server (ERP_API_KEY)', 'bad'));
    const keep = main.querySelector('details[data-keep]')?.open;
    main.innerHTML = `
      <header class="page-head"><div><h1>ERP connection</h1><p class="sub">Approved fuel, finished jobs and asset changes are queued here and sent to the county ERP. Nothing is lost if the ERP is down.</p></div>
        <div class="actions"><button class="btn" data-action="erp-test">Test connection</button><button class="btn" data-action="erp-pull">Bring in budgets and cost centres</button><button class="btn primary" data-action="erp-sync">Send queue now</button></div></header>
      <section class="tiles">
        <div class="tile"><div class="k">Waiting to send</div><div class="v">${c.queued + c.sending}</div><div class="s">retries happen by themselves</div></div>
        <div class="tile"><div class="k">Needs review</div><div class="v">${c.review}</div><div class="s">the ERP asked for a person to check</div></div>
        <div class="tile"><div class="k">Failed</div><div class="v">${c.failed}</div><div class="s">fix the cause, then retry</div></div>
        <div class="tile"><div class="k">Sent</div><div class="v">${c.synced}</div><div class="s">${o.lastRun ? 'last run ' + esc(when(o.lastRun)) : 'not run yet'}</div></div>
      </section>
      <section class="card card-flush"><h2 class="pad">Queue</h2>
        <div class="pad chips" role="group" aria-label="Filter">${[['', 'All'], ['queued', 'Queued'], ['review', 'Needs review'], ['failed', 'Failed'], ['synced', 'Sent']].map(([v, t]) => `<button class="chip" data-action="o-filter" data-status="${v}" aria-pressed="${oStatus === v}">${t}</button>`).join('')}</div>
        ${table('outbox-table', ['Record', 'What', { t: 'Amount (KES)', cls: 'num' }, 'Status', 'ERP reference', 'Tries', 'Last message', ''],
          box.map((r) => `<tr class="click" data-action="o-open" data-id="${r.id}"><td>${esc(r.ref)}<div class="small muted">${esc(r.asset || '')}</div></td><td>${esc(r.description)}</td><td class="num">${r.amount ? num(r.amount) : '–'}</td><td>${statusBadge(r.status)}</td><td>${esc(r.erp_reference || '–')}</td><td class="num">${r.attempts}</td><td class="small">${esc(r.last_error || '')}</td><td class="right">${r.status === 'failed' ? `<button class="btn sm" data-action="o-retry" data-id="${r.id}">Retry</button>` : r.status === 'review' ? `<button class="btn sm primary" data-action="o-approve" data-id="${r.id}">Review</button>` : ''}</td></tr>`),
          { empty: 'Nothing in the queue.' })}</section>
      <section class="grid g2 top">
        <div class="card"><h2>Settings</h2>
          <form class="form" data-submit="erp-save">
            <div class="row2">${select('How to send', 'adapter', [['rest', 'Online (REST API)'], ['file', 'Export files for import'], ['off', 'Off']], s.adapter)}${select('Which ERP', 'profile', Object.entries(o.profiles), s.profile)}</div>
            ${field('ERP address', 'base_url', { value: s.base_url, hint: 'https://…', attrs: 'inputmode="url" autocomplete="off"' })}
            <div class="row2">${select('Sign-in method', 'auth', [['apikey', 'API key'], ['oauth', 'OAuth client credentials']], s.auth)}${select('When to send', 'schedule', [['realtime', 'As it happens'], ['hourly', 'Every hour'], ['nightly', 'Nightly (after 22:00)']], s.schedule)}</div>
            <p class="small">${keyNote} <span class="muted">Secrets are kept on the server, never in the database or on this page.</span></p>
            <fieldset><legend>Ledger accounts</legend><div class="row3">${field('Fuel', 'map_fuel', { value: s.mapping.fuel, required: true })}${field('Repairs', 'map_maint', { value: s.mapping.maint, required: true })}${field('Assets', 'map_asset', { value: s.mapping.asset, required: true })}</div></fieldset>
            <div class="form-error" hidden></div><div class="form-actions"><button type="submit" class="btn primary">Save settings</button></div>
          </form></div>
        <div class="card"><h2>From the ERP</h2>
          <h3>Budgets</h3>${o.budgets.length ? `<ul class="list">${o.budgets.map((b) => `<li><span>${esc(b.fy)}, ${esc(b.vote)}</span><strong class="num">${esc(kes(b.amount))}</strong></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
          <h3>Cost centres</h3>${o.costCentres.length ? `<ul class="list">${o.costCentres.map((x) => `<li><span>${esc(x.code)} <span class="muted">${esc(x.name)}</span></span>${x.active ? badge('Open', 'ok') : badge('Blocked', 'bad')}</li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
          <p class="small muted">${o.lastPull ? 'Last read ' + esc(when(o.lastPull)) : 'Not read yet.'}</p>
          ${isAdmin && o.demo.enabled ? `<details data-keep ${keep ? 'open' : ''}><summary>Demo controls</summary><p class="small muted">Practise what happens when the ERP misbehaves. Not available in production.</p><div class="actions"><button class="btn sm" data-action="demo" data-do="flaky" data-n="2">Make the ERP fail twice</button><button class="btn sm" data-action="demo" data-do="block" data-code="ROADS-04">Block ROADS-04</button><button class="btn sm" data-action="demo" data-do="unblock" data-code="ROADS-04">Unblock ROADS-04</button></div></details>` : ''}
        </div>
      </section>`;
    main.querySelectorAll('.pad').forEach((e) => { e.style.padding = '1rem 1.1rem 0'; });
  };
  await render();
  ctx.refreshErp = render;
  stopErpTimer();
  timer = setInterval(() => { if (!document.getElementById('dlg').open && !main.contains(document.activeElement.closest?.('form'))) render().catch(() => {}); }, 6000);
}

actions['o-filter'] = ({ status }) => { oStatus = status; ctx.refresh(); };
actions['erp-test'] = async () => { const r = await api('POST', '/api/erp/test', {}); toast(r.ok ? 'Connected to the ERP.' : r.message, r.ok ? '' : 'bad'); };
actions['erp-pull'] = async () => { const r = await api('POST', '/api/erp/pull', {}); toast(`Read ${r.costCentres} cost centres, ${r.budgets} budget lines and ${r.vendors} suppliers.`); ctx.lookups = null; ctx.refresh(); };
actions['erp-sync'] = async () => {
  const r = await api('POST', '/api/erp/sync-now', {});
  if (r.disabled) toast('Nothing sent: the ERP is switched off or has no address yet.', 'bad');
  else toast(`Sent ${r.sent}. Will retry ${r.retry}. Needs review ${r.review}. Failed ${r.failed}.`);
  ctx.refresh();
};
actions['o-retry'] = async ({ id }) => { await api('POST', `/api/erp/outbox/${id}/retry`, {}); toast('Retried.'); ctx.refresh(); };
actions['o-approve'] = async ({ id }) => actions['o-open']({ id });
actions['demo'] = async (d) => { await api('POST', '/api/erp/demo', { action: d.do, code: d.code, n: d.n ? Number(d.n) : undefined }); toast('Demo setting changed.'); ctx.refresh(); };
actions['o-open'] = async ({ id }) => {
  const r = await api('GET', `/api/erp/outbox/${id}`);
  openDialog(`${r.ref}, ${r.description}`, `
    <p>${statusBadge(r.status)} ${r.erp_reference ? `<strong>${esc(r.erp_reference)}</strong>` : ''}</p>
    ${r.last_error ? `<p class="form-error">${esc(r.last_error)}</p>` : ''}
    ${r.status === 'review' ? `<p>The ERP flagged a conflict. If the fleet system is right, send it anyway.</p><div class="actions"><button class="btn primary" data-action="o-approve-send" data-id="${r.id}">Send anyway</button></div>` : ''}
    ${r.status === 'failed' ? `<div class="actions"><button class="btn primary" data-action="o-retry-close" data-id="${r.id}">Retry now</button></div>` : ''}
    <h3>Exactly what is sent</h3><pre class="json">${esc(JSON.stringify(r.envelope, null, 2))}</pre>
    <p class="small muted">Key ${esc(r.idempotency_key)}. The ERP uses this key to ignore a repeat, so a retry can never create a duplicate.</p>`, { wide: true });
};
actions['o-approve-send'] = async ({ id }) => { await api('POST', `/api/erp/outbox/${id}/approve`, {}); closeDialog(); toast('Sent.'); ctx.refresh(); };
actions['o-retry-close'] = async ({ id }) => { await api('POST', `/api/erp/outbox/${id}/retry`, {}); closeDialog(); toast('Retried.'); ctx.refresh(); };
forms['erp-save'] = async (d) => {
  await api('PUT', '/api/erp/settings', {
    adapter: d.adapter, profile: d.profile, base_url: d.base_url || '', auth: d.auth, schedule: d.schedule,
    mapping: { fuel: d.map_fuel, maint: d.map_maint, asset: d.map_asset },
  });
  toast('ERP settings saved.'); ctx.refresh();
};

/* ---------- users ---------- */

export async function users(main) {
  const list = await api('GET', '/api/users');
  main.innerHTML = `
    <header class="page-head"><div><h1>People</h1><p class="sub">Everyone who can sign in. New people get a temporary password they must change.</p></div><div class="actions"><button class="btn primary" data-action="user-new">Add a person</button></div></header>
    <section class="card card-flush">${table('users-table', ['Name', 'Email', 'Role', 'Status', ''],
      list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.id === ctx.user.id ? esc(ROLE_LABEL[u.role]) : `<select data-role-for="${u.id}" aria-label="Role for ${esc(u.name)}">${Object.entries(ROLE_LABEL).map(([v, t]) => `<option value="${v}" ${v === u.role ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`}</td><td>${u.active ? badge('Active', 'ok') : badge('Switched off')}${u.must_change_password ? ' ' + badge('Temporary password', 'warn') : ''}</td><td class="right">${u.id === ctx.user.id ? '' : `<button class="btn sm" data-action="user-reset" data-id="${u.id}" data-name="${esc(u.name)}">Reset password</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-action="user-toggle" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button>`}</td></tr>`))}</section>`;
  main.querySelectorAll('[data-role-for]').forEach((sel) => sel.addEventListener('change', async () => {
    try { await api('PATCH', `/api/users/${sel.dataset.roleFor}`, { role: sel.value }); toast('Role changed.'); } catch (e) { toast(e.message, 'bad'); ctx.refresh(); }
  }));
}
actions['user-new'] = () => openDialog('Add a person', `<form class="form" data-submit="user-save">${field('Full name', 'name', { required: true })}${field('Email', 'email', { type: 'email', required: true })}${select('Role', 'role', Object.entries(ROLE_LABEL).filter(([k]) => k !== 'admin').concat([['admin', ROLE_LABEL.admin]]), 'driver')}<div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Add person</button></div></form>`);
const showTemp = (title, who, pw) => openDialog(title, `<p>Give this temporary password to ${esc(who)}. It is shown only once and must be changed at first sign-in.</p><div class="secret">${esc(pw)}</div><div class="form-actions"><button class="btn primary" data-close>Done</button></div>`);
forms['user-save'] = async (d) => { const r = await api('POST', '/api/users', d); ctx.refresh(); showTemp('Person added', d.name, r.temporaryPassword); };
actions['user-reset'] = async ({ id, name }) => { if (!confirm(`Reset the password for ${name}? They will be signed out.`)) return; const r = await api('POST', `/api/users/${id}/reset-password`, {}); ctx.refresh(); showTemp('Password reset', name, r.temporaryPassword); };
actions['user-toggle'] = async ({ id, active }) => { await api('PATCH', `/api/users/${id}`, { active: Number(active) }); ctx.refresh(); };

/* ---------- audit ---------- */

export async function audit(main) {
  const rows = await api('GET', '/api/audit');
  main.innerHTML = `<header class="page-head"><div><h1>Activity log</h1><p class="sub">The last 200 things anyone did in the system.</p></div><input type="search" placeholder="Search" aria-label="Search activity" data-filter-table="audit-table"></header>
    <section class="card card-flush">${table('audit-table', ['When', 'Who', 'Action', 'Detail'], rows.map((r) => `<tr><td>${esc(when(r.at))}</td><td>${esc(r.user_name || 'system')}</td><td>${esc(r.action)}</td><td class="small">${esc([r.entity, r.entity_id].filter(Boolean).join(' ') + (r.detail ? ': ' + r.detail : ''))}</td></tr>`))}</section>`;
}
