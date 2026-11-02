import {
  esc, num, kes, when, day, badge, statusBadge, scheduleBadge, expiryBadge, api, toast, openDialog, closeDialog,
  actions, forms, table, field, select, monthlyChart, applyWidths,
} from './lib.js';
import { ctx } from './ctx.js';

const can = (...roles) => ctx.user.role === 'admin' || roles.includes(ctx.user.role);
const CATEGORIES = ['Routine service', 'Engine', 'Hydraulics', 'Tyres and wheels', 'Brakes', 'Transmission', 'Electrical', 'Body and cab', 'Other'];
const TYPES = ['Motor grader', 'Excavator', 'Water drilling rig', 'Wheel loader', 'Road roller', 'Tipper lorry', 'Water bowser', 'Pickup', 'Other'];

/* ---------- overview ---------- */

export async function overview(main) {
  const s = await api('GET', '/api/reports/summary');
  const tile = (k, v, sub, href) => `<${href ? `a href="${href}"` : 'div'} class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></${href ? 'a' : 'div'}>`;
  main.innerHTML = `
    <header class="page-head"><div><h1>Overview</h1><p class="sub">Financial year ${esc(s.fy)}. Diesel is priced at ${esc(kes(s.dieselPrice))} per litre.</p></div></header>
    <section class="tiles">
      ${tile('Vehicles and equipment', s.counts.total, `${s.counts.active} working, ${s.counts.maintenance} in the workshop`, '#/fleet')}
      ${tile('Fuel this year', kes(s.fuel.cost), `${num(s.fuel.litres)} litres approved`, can('fleet_manager', 'finance') ? '#/fuel' : '')}
      ${tile('Repairs and service', kes(s.maintenance.cost), `${s.maintenance.open} open jobs`, '#/maintenance')}
      ${tile('Fuel waiting for approval', s.fuel.pending, s.fuel.flagged ? `${s.fuel.flagged} look unusual` : 'None look unusual', can('fleet_manager', 'finance') ? '#/fuel' : '')}
    </section>
    <section class="grid g2">
      <div class="card"><h2>Service due</h2>${s.dueSoon.length ? `<ul class="list">${s.dueSoon.map((a) => `<li><span><span class="plate">${esc(a.plate)}</span> <span class="muted">${esc(a.type)}</span></span>${scheduleBadge(a)}</li>`).join('')}</ul>` : '<p class="empty">Nothing is due for service.</p>'}</div>
      <div class="card"><h2>Registration and insurance</h2>${s.expiries.length ? `<ul class="list">${s.expiries.map((e) => `<li><span><span class="plate">${esc(e.plate)}</span> <span class="muted">${esc(e.what)}, ${esc(day(e.date))}</span></span>${expiryBadge(e)}</li>`).join('')}</ul>` : '<p class="empty">Nothing expires in the next 30 days.</p>'}</div>
    </section>
    <section class="grid g2">
      <div class="card"><h2>Cost by month</h2><div class="legend"><span><i class="sw-fuel"></i>Fuel</span><span><i class="sw-maint"></i>Repairs and service</span></div>${monthlyChart(s.monthly)}</div>
      <div class="card"><h2>Budget <span class="small muted">from the ERP</span></h2>${s.budgets.length ? s.budgets.map((b) => {
        const p = b.used_pct ?? 0;
        return `<div class="budget"><div class="top"><strong>${esc(b.vote)}</strong><span class="num">${esc(kes(b.spent))} of ${esc(kes(b.amount))} (${esc(num(p, 0))}%)</span></div><div class="meter ${p > 100 ? 'bad' : p > 85 ? 'warn' : ''}"><span data-w="${p}"></span></div></div>`;
      }).join('') : '<p class="empty">No budget yet. Finance can bring it in from the ERP.</p>'}</div>
    </section>
    <section class="card card-flush"><h2 class="pad-h">Cost by vehicle this year</h2>${table('cost-table', ['Vehicle', 'Type', { t: 'Litres', cls: 'num' }, { t: 'Fuel', cls: 'num' }, { t: 'Repairs', cls: 'num' }, { t: 'Total', cls: 'num' }],
      s.byAsset.map((a) => `<tr><td class="plate">${esc(a.plate)}</td><td>${esc(a.type)}</td><td class="num">${num(a.litres)}</td><td class="num">${num(a.fuel_cost)}</td><td class="num">${num(a.maint_cost)}</td><td class="num"><strong>${num(a.total)}</strong></td></tr>`))}</section>`;
  main.querySelector('.pad-h').style.padding = '1rem 1.1rem 0';
  applyWidths(main);
}

/* ---------- fleet ---------- */

async function lookups() {
  if (!ctx.lookups) ctx.lookups = await api('GET', '/api/lookups');
  return ctx.lookups;
}

export async function fleet(main) {
  const assets = await api('GET', '/api/assets');
  ctx.assets = assets;
  main.innerHTML = `
    <header class="page-head"><div><h1>Fleet</h1><p class="sub">${assets.length} vehicles and pieces of equipment</p></div>
      <div class="actions"><input type="search" placeholder="Search by number, type or place" aria-label="Search fleet" data-filter-table="fleet-table">${can('fleet_manager') ? '<button class="btn primary" data-action="asset-new">Add vehicle or equipment</button>' : ''}</div></header>
    <section class="card card-flush">${table('fleet-table', ['Number', 'Type', 'Driver', 'Where', 'Status', { t: 'Meter', cls: 'num' }, 'Next service', 'Registration', 'Insurance'],
      assets.map((a) => `<tr class="click" data-action="asset-open" data-id="${a.id}"><td class="plate">${esc(a.plate)}</td><td>${esc(a.type)}<div class="small muted">${esc(a.make_model)}</div></td><td>${esc(a.driver_name || '–')}</td><td>${esc(a.location || '–')}</td><td>${statusBadge(a.status)}</td><td class="num">${num(a.meter)} ${esc(a.unit)}</td><td>${scheduleBadge(a)}</td><td>${expiryBadge(a.registration)}</td><td>${expiryBadge(a.insurance)}</td></tr>`),
      { empty: 'No vehicles yet.' })}</section>`;
}

actions['asset-open'] = async ({ id }) => {
  const d = await api('GET', `/api/assets/${id}`);
  const a = d.asset;
  const jobs = d.jobs.length
    ? d.jobs.map((j) => `<tr><td>${esc(day(j.closed_at || j.opened_at))}</td><td>${esc(j.kind === 'service' ? 'Service' : 'Repair')}: ${esc(j.description)}${j.parts.length ? `<div class="small muted">${j.parts.map((p) => `${esc(p.description)} × ${num(p.qty)}`).join(', ')}</div>` : ''}</td><td>${statusBadge(j.status)}</td><td class="num">${j.status === 'closed' ? num(j.total_cost) : '–'}</td></tr>`).join('')
    : '';
  openDialog(`${a.plate}, ${a.type}`, `
    <div class="actions">${can('fleet_manager') ? `<button class="btn" data-action="asset-edit" data-id="${a.id}">Edit details</button>` : ''}${can('fleet_manager', 'workshop') ? `<button class="btn" data-action="meter-new" data-id="${a.id}">Record ${a.fuel_basis === 'km' ? 'odometer' : 'engine hours'}</button><button class="btn primary" data-action="job-new" data-asset="${a.id}">Open a job</button>` : ''}</div>
    <dl class="kv"><dt>Make and model</dt><dd>${esc(a.make_model || '–')}</dd><dt>Status</dt><dd>${statusBadge(a.status)}</dd><dt>Driver</dt><dd>${esc(a.driver_name || 'Not assigned')}</dd><dt>Location</dt><dd>${esc(a.location || '–')}</dd>
    <dt>${a.fuel_basis === 'km' ? 'Odometer' : 'Engine hours'}</dt><dd>${num(a.meter)} ${esc(a.unit)}</dd><dt>Next service</dt><dd>${a.schedule.next_due != null ? `at ${num(a.schedule.next_due)} ${esc(a.unit)} ` : ''}${scheduleBadge(a)}</dd>
    <dt>Fuel use</dt><dd>${a.fuel_rate ? `${num(a.fuel_rate, 1)} ${a.fuel_basis === 'km' ? 'litres per 100 km' : 'litres per hour'}` : 'Not set'}</dd><dt>Cost centre</dt><dd>${esc(a.cost_centre || '–')}</dd><dt>ERP asset number</dt><dd>${esc(a.erp_asset_no || '–')}</dd>
    <dt>Registration</dt><dd>${esc(day(a.registration_expiry))} ${expiryBadge(a.registration)}</dd><dt>Insurance</dt><dd>${esc(day(a.insurance_expiry))} ${expiryBadge(a.insurance)}</dd></dl>
    <h3>Maintenance history</h3>${jobs ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Work</th><th>Status</th><th class="num">Cost (KES)</th></tr></thead><tbody>${jobs}</tbody></table></div>` : '<p class="muted">No jobs recorded yet.</p>'}
    <h3>Recent fuel</h3>${d.fuel.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Litres</th><th class="num">Cost (KES)</th><th>Check</th><th>Status</th></tr></thead><tbody>${d.fuel.slice(0, 8).map((f) => `<tr><td>${esc(when(f.created_at))}</td><td class="num">${num(f.litres, 1)}</td><td class="num">${num(f.total)}</td><td>${f.variance_pct == null ? '–' : badge(`${f.variance_pct > 0 ? '+' : ''}${num(f.variance_pct, 0)}%`, f.flag ? 'bad' : 'ok')}</td><td>${statusBadge(f.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No fuel recorded yet.</p>'}`, { wide: true });
};

async function assetForm(a = null) {
  const lk = await lookups();
  const v = (k, d = '') => (a && a[k] != null ? a[k] : d);
  return `<form class="form" data-submit="asset-save"><input type="hidden" name="id" value="${a ? a.id : ''}">
    <div class="row2">${field('Number plate or tag', 'plate', { value: v('plate'), required: true })}<label>Type<input name="type" list="types" value="${esc(v('type'))}" required><datalist id="types">${TYPES.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label></div>
    <div class="row3">${select('Kind', 'category', [['heavy', 'Heavy equipment'], ['transport', 'Road vehicle']], v('category', 'heavy'))}${field('Make and model', 'make_model', { value: v('make_model') })}${select('Status', 'status', [['idle', 'Idle'], ['active', 'Working'], ['maintenance', 'In workshop'], ['retired', 'Retired']], v('status', 'idle'))}</div>
    <div class="row3">${field('Year made', 'year_made', { type: 'number', value: v('year_made') })}${field('Year bought', 'year_purchased', { type: 'number', value: v('year_purchased') })}${field('Where it is', 'location', { value: v('location') })}</div>
    <fieldset><legend>Fuel and service</legend>
      <div class="row3">${select('Fuel is measured by', 'fuel_basis', [['km', 'Distance (km)'], ['hrs', 'Engine hours']], v('fuel_basis', 'km'))}${field('Fuel use', 'fuel_rate', { type: 'number', value: v('fuel_rate'), hint: 'L/100 km or L/hour', attrs: 'step="0.1" min="0"' })}${field('Service every', 'service_interval', { type: 'number', value: v('service_interval'), hint: 'km or hours', attrs: 'min="0"' })}</div>
      <div class="row2">${field('Current reading', 'meter', { type: 'number', value: v('meter'), attrs: 'step="any" min="0"' })}${field('Reading at last service', 'last_service_meter', { type: 'number', value: v('last_service_meter'), attrs: 'step="any" min="0"' })}</div></fieldset>
    <div class="row2">${field('Registration expires', 'registration_expiry', { type: 'date', value: v('registration_expiry') })}${field('Insurance expires', 'insurance_expiry', { type: 'date', value: v('insurance_expiry') })}</div>
    <fieldset><legend>Finance and driver</legend>
      <div class="row3"><label>Cost centre<input name="cost_centre" list="ccs" value="${esc(v('cost_centre'))}"><datalist id="ccs">${lk.costCentres.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join('')}</datalist></label>${field('ERP asset number', 'erp_asset_no', { value: v('erp_asset_no') })}${select('Driver', 'assigned_driver_id', [['', 'Not assigned'], ...lk.drivers.map((d) => [d.id, d.name])], v('assigned_driver_id'))}</div></fieldset>
    <div class="form-error" hidden></div>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${a ? 'Save changes' : 'Add to fleet'}</button></div></form>`;
}

actions['asset-new'] = async () => openDialog('Add vehicle or equipment', await assetForm(), { wide: true });
actions['asset-edit'] = async ({ id }) => {
  const d = await api('GET', `/api/assets/${id}`);
  openDialog(`Edit ${d.asset.plate}`, await assetForm(d.asset), { wide: true });
};
forms['asset-save'] = async (d) => {
  const id = d.id;
  delete d.id;
  const body = { ...d };
  if (id) body.assigned_driver_id = d.assigned_driver_id ? Number(d.assigned_driver_id) : null;
  else if (d.assigned_driver_id) body.assigned_driver_id = Number(d.assigned_driver_id);
  await api(id ? 'PATCH' : 'POST', id ? `/api/assets/${id}` : '/api/assets', body);
  ctx.lookups = null;
  closeDialog();
  toast(id ? 'Saved.' : 'Added to the fleet.');
  ctx.refresh();
};

actions['meter-new'] = async ({ id }) => {
  const a = ctx.assets?.find((x) => x.id === Number(id)) || (await api('GET', `/api/assets/${id}`)).asset;
  openDialog(`Record ${a.fuel_basis === 'km' ? 'odometer' : 'engine hours'}`, `<form class="form" data-submit="meter-save"><input type="hidden" name="id" value="${a.id}">
    <p class="muted">${esc(a.plate)} last read ${num(a.meter)} ${esc(a.unit)}.</p>${field(`New reading (${a.unit})`, 'meter', { type: 'number', value: a.meter, required: true, attrs: `min="${a.meter}" step="any"` })}
    <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save reading</button></div></form>`);
};
forms['meter-save'] = async (d) => { await api('POST', `/api/assets/${d.id}/meter`, { meter: Number(d.meter) }); closeDialog(); toast('Reading saved.'); ctx.refresh(); };

/* ---------- maintenance ---------- */

let mTab = 'schedule';
export async function maintenance(main) {
  const [assets, jobs] = await Promise.all([api('GET', '/api/assets'), api('GET', '/api/jobs')]);
  ctx.assets = assets;
  const order = { overdue: 0, soon: 1, ok: 2, none: 3 };
  const sched = [...assets].sort((a, b) => order[a.schedule.state] - order[b.schedule.state] || (a.schedule.remaining ?? 1e12) - (b.schedule.remaining ?? 1e12));
  const edit = can('fleet_manager', 'workshop');
  main.innerHTML = `
    <header class="page-head"><div><h1>Maintenance</h1><p class="sub">Services are due by engine hours or kilometres, whichever applies to the machine.</p></div>
      <div class="actions">${edit ? '<button class="btn primary" data-action="job-new">Open a job</button>' : ''}</div></header>
    <div class="chips" role="group" aria-label="Show"><button class="chip" data-action="m-tab" data-tab="schedule" aria-pressed="${mTab === 'schedule'}">Service schedule</button><button class="chip" data-action="m-tab" data-tab="jobs" aria-pressed="${mTab === 'jobs'}">Jobs (${jobs.filter((j) => j.status !== 'closed').length} open)</button></div>
    <p></p>
    <section class="card card-flush">${mTab === 'schedule'
      ? table('sched-table', ['Number', 'Type', { t: 'Now', cls: 'num' }, { t: 'Last service', cls: 'num' }, { t: 'Next due', cls: 'num' }, 'Status', ''],
        sched.map((a) => `<tr><td class="plate">${esc(a.plate)}</td><td>${esc(a.type)}</td><td class="num">${num(a.meter)} ${esc(a.unit)}</td><td class="num">${num(a.last_service_meter)}</td><td class="num">${a.schedule.next_due != null ? num(a.schedule.next_due) : '–'}</td><td>${scheduleBadge(a)}${a.open_jobs ? ' ' + badge('Job open', 'info') : ''}</td><td class="right">${edit && !a.open_jobs && a.schedule.state !== 'none' ? `<button class="btn sm" data-action="job-new" data-asset="${a.id}" data-kind="service">Open service</button>` : ''}</td></tr>`))
      : table('jobs-table', ['Job', 'Vehicle', 'Work', 'Status', 'Technician', { t: 'Cost (KES)', cls: 'num' }, 'Date', ''],
        jobs.map((j) => `<tr><td>#${j.id}</td><td class="plate">${esc(j.plate)}</td><td>${esc(j.kind === 'service' ? 'Service' : 'Repair')}: ${esc(j.description)}<div class="small muted">${esc(j.category)}</div></td><td>${statusBadge(j.status)}</td><td>${esc(j.technician || '–')}</td><td class="num">${j.status === 'closed' ? num(j.total_cost) : '–'}</td><td>${esc(day(j.closed_at || j.opened_at))}</td><td class="right">${edit && j.status === 'open' ? `<button class="btn sm" data-action="job-start" data-id="${j.id}">Start</button> ` : ''}${edit && j.status !== 'closed' ? `<button class="btn sm primary" data-action="job-close-form" data-id="${j.id}">Finish</button>` : ''}</td></tr>`),
        { empty: 'No jobs yet.' })}</section>`;
}
actions['m-tab'] = ({ tab }) => { mTab = tab; ctx.refresh(); };

actions['job-new'] = async ({ asset, kind }) => {
  const assets = ctx.assets || (ctx.assets = await api('GET', '/api/assets'));
  closeDialog();
  openDialog('Open a job', `<form class="form" data-submit="job-save">
    ${select('Vehicle or equipment', 'asset_id', assets.map((a) => [a.id, `${a.plate}, ${a.type}`]), asset, { required: true })}
    <div class="row2">${select('Kind of job', 'kind', [['repair', 'Repair'], ['service', 'Routine service']], kind || 'repair')}<label>Category<input name="category" list="cats" value="${kind === 'service' ? 'Routine service' : ''}" required><datalist id="cats">${CATEGORIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
    <label>What needs doing<textarea name="description" required>${kind === 'service' ? 'Routine service and filter change' : ''}</textarea></label>
    <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Open job</button></div></form>`);
};
forms['job-save'] = async (d) => {
  await api('POST', '/api/jobs', { ...d, asset_id: Number(d.asset_id) });
  closeDialog(); toast('Job opened. The vehicle is now marked as in the workshop.'); mTab = 'jobs'; ctx.refresh();
};
actions['job-start'] = async ({ id }) => {
  await api('POST', `/api/jobs/${id}/start`, {});
  toast('Job started.'); ctx.refresh();
};

const partRow = () => `<div class="part-row"><input name="part_desc[]" placeholder="Part"><input name="part_qty[]" type="number" min="0" step="any" placeholder="Qty" aria-label="Quantity"><input name="part_cost[]" type="number" min="0" step="any" placeholder="Cost each" aria-label="Cost each"></div>`;
actions['job-close-form'] = async ({ id }) => {
  const j = await api('GET', `/api/jobs/${id}`);
  const asset = (ctx.assets || []).find((a) => a.id === j.asset_id);
  openDialog(`Finish job #${j.id}, ${j.plate}`, `<form class="form" data-submit="job-close"><input type="hidden" name="id" value="${j.id}">
    <p><strong>${esc(j.description)}</strong></p>
    <div class="row3">${field('Technician', 'technician', { value: j.technician || '' })}${field('Labour cost (KES)', 'labour_cost', { type: 'number', value: '0', required: true, attrs: 'min="0" step="any"' })}${field(`Reading at service (${j.fuel_basis === 'km' ? 'km' : 'hrs'})`, 'meter_at_service', { type: 'number', value: asset ? asset.meter : '', attrs: 'min="0" step="any"' })}</div>
    <fieldset id="parts"><legend>Parts used</legend>${partRow()}${partRow()}</fieldset>
    <button type="button" class="btn sm" data-action="part-add">Add another part</button>
    <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Finish and send to Finance</button></div></form>`);
};
actions['part-add'] = () => document.getElementById('parts').insertAdjacentHTML('beforeend', partRow());
forms['job-close'] = async (d) => {
  const parts = [];
  (d['part_desc[]'] || []).forEach((desc, i) => { if (desc) parts.push({ description: desc, qty: Number(d['part_qty[]'][i] || 1), unit_cost: Number(d['part_cost[]'][i] || 0) }); });
  const body = { labour_cost: Number(d.labour_cost || 0), parts };
  if (d.technician) body.technician = d.technician;
  if (d.meter_at_service) body.meter_at_service = Number(d.meter_at_service);
  const j = await api('POST', `/api/jobs/${d.id}/close`, body);
  closeDialog(); toast(`Job finished. Total cost ${kes(j.total_cost)}. It is queued for the ERP.`); ctx.refresh();
};

/* ---------- fuel ---------- */

let fStatus = 'submitted';
export async function fuel(main) {
  const [logs, me] = await Promise.all([api('GET', `/api/fuel${fStatus ? `?status=${fStatus}` : ''}`), api('GET', '/api/settings')]);
  const decide = can('fleet_manager', 'finance');
  main.innerHTML = `
    <header class="page-head"><div><h1>Fuel</h1><p class="sub">Fills from drivers wait here. Approving one sends the cost to the ERP.</p></div>
      <div class="actions">${can('fleet_manager') ? '<button class="btn" data-action="fuel-new">Record a fill</button>' : ''}${can('finance') ? `<button class="btn" data-action="price-edit" data-price="${me.dieselPrice}">Diesel price: ${esc(kes(me.dieselPrice))}/L</button>` : ''}</div></header>
    <div class="chips" role="group" aria-label="Filter">${[['submitted', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']].map(([v, t]) => `<button class="chip" data-action="f-filter" data-status="${v}" aria-pressed="${fStatus === v}">${t}</button>`).join('')}</div><p></p>
    <section class="card card-flush">${table('fuel-table', ['When', 'Vehicle', 'Driver', { t: 'Litres', cls: 'num' }, { t: 'Expected', cls: 'num' }, 'Check', { t: 'Cost (KES)', cls: 'num' }, 'Status', ''],
      logs.map((f) => `<tr><td>${esc(when(f.created_at))}</td><td class="plate">${esc(f.plate)}</td><td>${esc(f.driver_name || '–')}</td><td class="num">${num(f.litres, 1)}</td><td class="num">${f.expected_litres != null ? num(f.expected_litres, 0) : '–'}</td><td>${f.variance_pct == null ? '<span class="muted">No reading</span>' : badge(`${f.variance_pct > 0 ? '+' : ''}${num(f.variance_pct, 0)}%`, f.flag ? 'bad' : 'ok')}</td><td class="num">${num(f.total)}</td><td>${statusBadge(f.status)}</td><td class="right">${decide && f.status === 'submitted' ? `<button class="btn sm primary" data-action="f-decide" data-id="${f.id}" data-decision="approve">Approve</button> <button class="btn sm danger" data-action="f-decide" data-id="${f.id}" data-decision="reject">Reject</button>` : ''}</td></tr>`),
      { empty: fStatus === 'submitted' ? 'No fuel is waiting for approval.' : 'No records.' })}</section>`;
}
actions['f-filter'] = ({ status }) => { fStatus = status; ctx.refresh(); };
actions['f-decide'] = async ({ id, decision }) => {
  await api('POST', `/api/fuel/${id}/decision`, { decision });
  toast(decision === 'approve' ? 'Approved and queued for the ERP.' : 'Rejected.'); ctx.refresh();
};
actions['price-edit'] = ({ price }) => openDialog('Diesel price', `<form class="form" data-submit="price-save">${field('Price per litre (KES)', 'price', { type: 'number', value: price, required: true, attrs: 'min="1" step="0.01"' })}<div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div></form>`);
forms['price-save'] = async (d) => { await api('PUT', '/api/settings/diesel-price', { price: Number(d.price) }); closeDialog(); toast('Price saved.'); ctx.refresh(); };
actions['fuel-new'] = async () => {
  const assets = ctx.assets || (ctx.assets = await api('GET', '/api/assets'));
  openDialog('Record a fill', `<form class="form" data-submit="fuel-save">${select('Vehicle or equipment', 'asset_id', assets.map((a) => [a.id, `${a.plate}, ${a.type}`]), '', { required: true })}
    <div class="row3">${field('Litres', 'litres', { type: 'number', required: true, attrs: 'min="0.1" step="any"' })}${field('Reading now', 'meter_reading', { type: 'number', hint: 'km or hours', attrs: 'min="0" step="any"' })}${field('Price per litre', 'unit_price', { type: 'number', hint: 'blank = current', attrs: 'min="1" step="0.01"' })}</div>
    <div class="form-error" hidden></div><div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save fill</button></div></form>`);
};
forms['fuel-save'] = async (d) => {
  const body = { asset_id: Number(d.asset_id), litres: Number(d.litres) };
  if (d.meter_reading) body.meter_reading = Number(d.meter_reading);
  if (d.unit_price) body.unit_price = Number(d.unit_price);
  await api('POST', '/api/fuel', body);
  closeDialog(); toast('Fill recorded and waiting for approval.'); ctx.refresh();
};
