/* Shared helpers. Every piece of server data goes through esc() before it is put in HTML. */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (n, d = 0) => (n == null ? '–' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: d }));
export const kes = (n) => (n == null ? '–' : 'KES ' + Math.round(Number(n)).toLocaleString('en-KE'));
export const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));

const NAIROBI = { timeZone: 'Africa/Nairobi' };
const toDate = (s) => new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
export const when = (s) => (s ? toDate(s).toLocaleString('en-KE', { ...NAIROBI, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
export const day = (s) => (s ? new Date(String(s).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-KE', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '–');
export const monthName = (ym) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-KE', { timeZone: 'UTC', month: 'short' });

export const badge = (text, kind = '') => `<span class="badge ${kind ? 'b-' + kind : ''}">${esc(text)}</span>`;

const STATUS_KIND = {
  active: 'ok', idle: '', maintenance: 'warn', retired: '',
  submitted: 'info', approved: 'ok', rejected: 'bad',
  open: 'info', in_progress: 'warn', closed: 'ok',
  queued: 'info', sending: 'info', synced: 'ok', failed: 'bad', review: 'warn',
  ok: 'ok', soon: 'warn', overdue: 'bad', expired: 'bad', none: '',
};
const STATUS_LABEL = { in_progress: 'In progress', submitted: 'Waiting', maintenance: 'In workshop', idle: 'Idle', active: 'Working', review: 'Needs review', synced: 'Sent', failed: 'Failed', queued: 'Queued' };
export const statusBadge = (s) => badge(STATUS_LABEL[s] || s.charAt(0).toUpperCase() + s.slice(1).replace('_', ' '), STATUS_KIND[s] ?? '');

export const ROLE_LABEL = { admin: 'Administrator', fleet_manager: 'Fleet manager', workshop: 'Workshop', finance: 'Finance', driver: 'Driver' };

export const scheduleBadge = (a) => {
  const s = a.schedule;
  if (s.state === 'none') return badge('No schedule');
  const left = `${num(Math.abs(s.remaining))} ${a.unit}`;
  if (s.state === 'overdue') return badge(`Overdue by ${left}`, 'bad');
  if (s.state === 'soon') return badge(`Due in ${left}`, 'warn');
  return badge(`${left} left`, 'ok');
};
export const expiryBadge = (e) => {
  if (e.state === 'none') return badge('Not set');
  if (e.state === 'expired') return badge(`Expired ${Math.abs(e.days)} d ago`, 'bad');
  if (e.state === 'soon') return badge(`${e.days} d left`, 'warn');
  return badge('Valid', 'ok');
};

/* ---------- api ---------- */

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export const hooks = { onUnauthorized: () => {}, onMustChange: () => {} };

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'X-Fleet-Client': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') hooks.onUnauthorized();
    if (res.status === 403 && data.mustChangePassword) hooks.onMustChange();
    throw new ApiError(res.status, data.error || data.message || 'Something went wrong', data);
  }
  return data;
}

/* ---------- ui ---------- */

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toast').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4000);
}

const dlg = () => document.getElementById('dlg');
export function openDialog(title, bodyHtml, { wide = false } = {}) {
  const d = dlg();
  d.className = wide ? 'wide' : '';
  d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="icon" data-close aria-label="Close">×</button></div><div class="dlg-body">${bodyHtml}</div>`;
  applyWidths(d);
  if (!d.open) d.showModal();
  const first = d.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
}
export const closeDialog = () => { if (dlg().open) dlg().close(); };

/** Widths are set from script because the page's security policy does not allow inline style attributes. */
export function applyWidths(root) {
  root.querySelectorAll('[data-w]').forEach((e) => { e.style.width = Math.max(0, Math.min(100, Number(e.dataset.w))) + '%'; });
}

export const actions = {};
export const forms = {};

export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) {
    if (typeof v !== 'string') continue;
    if (k.endsWith('[]')) (out[k] ||= []).push(v.trim());
    else if (v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

export function initEvents() {
  document.addEventListener('click', async (e) => {
    if (e.target === dlg()) return closeDialog();
    const el = e.target.closest('[data-action], [data-close]');
    if (!el) return;
    if (el.hasAttribute('data-close')) return closeDialog();
    const fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    if (el.disabled) return;
    el.disabled = true;
    try { await fn(el.dataset, el); } catch (err) { toast(err.message, 'bad'); } finally { el.disabled = false; }
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-submit]');
    if (!form) return;
    e.preventDefault();
    const fn = forms[form.dataset.submit];
    if (!fn) return;
    const errBox = form.querySelector('.form-error');
    if (errBox) errBox.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try { await fn(formData(form), form); } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else toast(err.message, 'bad');
    } finally { if (btn) btn.disabled = false; }
  });
  document.addEventListener('input', (e) => {
    const box = e.target.closest('[data-filter-table]');
    if (!box) return;
    const q = box.value.trim().toLowerCase();
    document.querySelectorAll(`#${box.dataset.filterTable} tbody tr`).forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
  });
}

/* ---------- small html builders ---------- */

export const table = (id, heads, rows, { empty = 'Nothing here yet.' } = {}) =>
  rows.length
    ? `<div class="table-wrap"><table id="${id}"><thead><tr>${heads.map((h) => (typeof h === 'string' ? `<th>${esc(h)}</th>` : `<th class="${h.cls || ''}">${esc(h.t)}</th>`)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="empty">${esc(empty)}</p>`;

export const field = (label, name, { type = 'text', value = '', hint = '', required = false, attrs = '' } = {}) =>
  `<label><span>${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</span><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${attrs}></label>`;

export const select = (label, name, options, value = '', { required = false } = {}) =>
  `<label><span>${esc(label)}</span><select name="${esc(name)}" ${required ? 'required' : ''}>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;

/** Grouped bars: fuel and maintenance cost per month. */
export function monthlyChart(monthly) {
  const W = 640, H = 250, L = 52, R = 10, T = 12, B = 30;
  const max = Math.max(1, ...monthly.flatMap((m) => [m.fuel, m.maintenance]));
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((v) => v >= raw);
  const top = nice * 4;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / monthly.length;
  const ticks = [0, 1, 2, 3, 4].map((i) => (top / 4) * i);
  const summary = monthly.map((m) => `${monthName(m.month)}: fuel ${kes(m.fuel)}, maintenance ${kes(m.maintenance)}`).join('; ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly cost. ${esc(summary)}">
    ${ticks.map((t) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
    ${monthly.map((m, i) => {
      const x = L + i * bw + bw * 0.18, w = bw * 0.32;
      return `<rect class="bar-fuel" x="${x}" y="${y(m.fuel)}" width="${w}" height="${H - B - y(m.fuel)}" rx="3"><title>${esc(monthName(m.month))} fuel: ${esc(kes(m.fuel))}</title></rect>
        <rect class="bar-maint" x="${x + w + 3}" y="${y(m.maintenance)}" width="${w}" height="${H - B - y(m.maintenance)}" rx="3"><title>${esc(monthName(m.month))} maintenance: ${esc(kes(m.maintenance))}</title></rect>
        <text x="${L + i * bw + bw / 2}" y="${H - 9}" text-anchor="middle">${esc(monthName(m.month))}</text>`;
    }).join('')}
  </svg>`;
}
