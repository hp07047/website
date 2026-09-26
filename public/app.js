const REFRESH_MS = 30_000;
const state = { meta: null, tab: 'rail', rail: 'HB', lr: 'hoboken-terminal', bus: 'journal-square', timer: null };
const $ = (id) => document.getElementById(id);

try {
  const saved = JSON.parse(localStorage.getItem('hudpost-transit') || '{}');
  Object.assign(state, { tab: saved.tab || state.tab, rail: saved.rail || state.rail, lr: saved.lr || state.lr, bus: saved.bus || state.bus });
} catch { /* storage unavailable */ }
function persist() { try { localStorage.setItem('hudpost-transit', JSON.stringify({ tab: state.tab, rail: state.rail, lr: state.lr, bus: state.bus })); } catch { /* ignore */ } }

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function minsUntil(iso) { return Math.round((new Date(iso) - Date.now()) / 60000); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function statusClass(status, delay) {
  const s = String(status || '').toUpperCase();
  if (delay > 0 || /DELAY|LATE/.test(s)) return 'bad';
  if (/BOARD|ABOARD|STAND|APPROACH/.test(s)) return 'warn';
  return 'ok';
}

function setStatus(kind, text, meta = '') {
  const el = $('status');
  el.className = `status is-${kind}`;
  $('status-text').textContent = text;
  $('status-meta').textContent = meta;
}

/* ---------- Rail ---------- */
function renderRailPicker() {
  $('rail-picker').innerHTML = state.meta.rail.map((s) =>
    `<button type="button" data-code="${s.code}" class="${s.code === state.rail ? 'is-active' : ''}">${esc(s.name.replace(' Junction', ''))}</button>`).join('');
  $('rail-picker').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.rail = b.dataset.code; persist(); renderRailPicker(); loadRail();
  };
}
async function loadRail() {
  const board = $('rail-board');
  board.innerHTML = '<div class="loading">Loading departures…</div>';
  try {
    const [data, msgs] = await Promise.all([api(`/api/rail/departures?station=${state.rail}`), api(`/api/rail/messages?station=${state.rail}`).catch(() => [])]);
    renderAlerts(msgs);
    const rows = data.departures.filter((d) => d.scheduled && minsUntil(d.scheduled) > -2).slice(0, 12);
    board.innerHTML = rows.length ? rows.map((d) => {
      const m = minsUntil(d.scheduled);
      const cls = statusClass(d.status, d.delayMin);
      return `<div class="row">
        <div class="row__time">${m <= 0 ? 'Now' : m + '<small>min</small>'}<small>${fmtTime(d.scheduled)}</small></div>
        <div class="row__main">
          <div class="row__dest">${esc(d.destination)} <span class="line" style="background:${esc(d.colors.bg || '#888')};color:${esc(d.colors.fg || '#fff')}">${esc(d.lineAbbr || d.line || '')}</span></div>
          <div class="row__sub">${esc(d.line || '')}${d.trainId ? ` · Train ${esc(d.trainId)}` : ''}${d.inlineMessage ? ` · ${esc(d.inlineMessage)}` : ''}</div>
        </div>
        <div class="row__right">
          <span class="badge ${cls}">${esc(d.delayMin > 0 ? `${d.delayMin} min late` : d.status || 'Scheduled')}</span>
          <span class="track">${d.track ? `Track ${esc(d.track)}` : 'Track TBA'}</span>
        </div>
      </div>`;
    }).join('') : $('tpl-empty').innerHTML;
  } catch (err) {
    board.innerHTML = `<div class="error">Couldn't load rail departures (${esc(err.message)}).</div>`;
  }
}

/* ---------- Light rail ---------- */
function renderLrSelect() {
  $('lr-select').innerHTML = state.meta.lightRail.map((s) => `<option value="${s.id}" ${s.id === state.lr ? 'selected' : ''}>${esc(s.name)} — ${esc(s.town)}</option>`).join('');
  $('lr-select').onchange = (e) => { state.lr = e.target.value; persist(); loadLr(); };
}
async function loadLr() {
  const board = $('lr-board');
  board.innerHTML = '<div class="loading">Loading departures…</div>';
  try {
    const data = await api(`/api/lightrail/departures?station=${state.lr}`);
    const rows = data.departures.filter((d) => minsUntil(d.scheduled) > -1).slice(0, 10);
    board.innerHTML = (rows.length ? rows.map((d) => {
      const m = minsUntil(d.scheduled);
      return `<div class="row">
        <div class="row__time">${m <= 0 ? 'Now' : m + '<small>min</small>'}<small>${fmtTime(d.scheduled)}</small></div>
        <div class="row__main"><div class="row__dest">${esc(d.destination)}</div><div class="row__sub">${esc(d.direction)}</div></div>
        <div class="row__right"><span class="badge ${statusClass(d.status, 0)}">${esc(d.status)}</span></div>
      </div>`;
    }).join('') : $('tpl-empty').innerHTML)
      + `<div class="note">Light rail times are ${data.departures[0]?.source === 'schedule' ? 'scheduled, not live' : 'live'}. NJ Transit's developer portal doesn't expose a documented real-time HBLR feed yet.</div>`;
  } catch (err) {
    board.innerHTML = `<div class="error">Couldn't load light rail departures (${esc(err.message)}).</div>`;
  }
}

/* ---------- Bus ---------- */
function renderBusSelect() {
  $('bus-select').innerHTML = state.meta.bus.hubs.map((h) => `<option value="${h.id}" ${h.id === state.bus ? 'selected' : ''}>${esc(h.name)} — ${esc(h.town)}</option>`).join('');
  $('bus-select').onchange = (e) => { state.bus = e.target.value; persist(); loadBus(); };
}
async function loadBus() {
  const board = $('bus-board');
  const hub = state.meta.bus.hubs.find((h) => h.id === state.bus);
  $('bus-routes').innerHTML = hub.routes.map((r) => `<span class="chip" title="${esc(state.meta.bus.routeNames[r] || '')}">${esc(r)}</span>`).join('');
  board.innerHTML = '<div class="loading">Loading departures…</div>';
  try {
    const data = await api(`/api/bus/departures?hub=${state.bus}`);
    board.innerHTML = (data.departures.length ? data.departures.map((d) => {
      const eta = String(d.eta || '');
      const cls = /DELAY/i.test(eta) ? 'bad' : /APPROACH|^[0-3] MIN/i.test(eta) ? 'warn' : 'ok';
      return `<div class="row">
        <div class="row__time"><span class="route">${esc(d.route)}</span></div>
        <div class="row__main">
          <div class="row__dest">${esc(d.headsign)}</div>
          <div class="row__sub">${esc(state.meta.bus.routeNames[d.route] || '')}${d.lane ? ` · Lane ${esc(d.lane)}` : ''}${d.passengerLoad ? ` · ${esc(d.passengerLoad.toLowerCase())} load` : ''}</div>
        </div>
        <div class="row__right"><span class="badge ${cls}">${esc(eta)}</span><span class="track">Sched ${esc(d.scheduled || '')}</span></div>
      </div>`;
    }).join('') : $('tpl-empty').innerHTML)
      + (data.message ? `<div class="note">${esc(data.message)}</div>` : '');
  } catch (err) {
    board.innerHTML = `<div class="error">Couldn't load bus departures (${esc(err.message)}).</div>`;
  }
}

/* ---------- Alerts ---------- */
function renderAlerts(msgs) {
  const el = $('alerts');
  if (!msgs?.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = msgs.slice(0, 3).map((m) => `<div class="alert">${esc(m.text)}${m.published ? `<time datetime="${m.published}">${fmtTime(m.published)}</time>` : ''}</div>`).join('');
}

/* ---------- Tabs & refresh ---------- */
function setTab(tab) {
  state.tab = tab; persist();
  document.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
  ['rail', 'lightrail', 'bus'].forEach((t) => { $(`panel-${t}`).hidden = t !== tab; });
  refresh();
}
function refresh() {
  ({ rail: loadRail, lightrail: loadLr, bus: loadBus })[state.tab]();
  const modes = state.meta.modes;
  const live = modes.rail === 'live' || modes.bus === 'live';
  setStatus(live ? 'live' : 'mock', live ? 'Live NJ Transit data' : 'Demo data (no NJ Transit credentials)', `Updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
}

(async function init() {
  document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
  try {
    state.meta = await api('/api/meta');
  } catch (err) {
    setStatus('error', 'Server unavailable', err.message); return;
  }
  renderRailPicker(); renderLrSelect(); renderBusSelect();
  setTab(state.tab);
  state.timer = setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
