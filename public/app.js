/* Hudson County Transit — front end.
   Design rules (from rider complaints about the official apps):
   1. Zero clicks to the answer: starred stops render on load with the next departures.
   2. Delays and tracks are always inline. A boarding train never loses its time.
   3. "Nearby" sorts by distance, never alphabetically.
   4. Every card says how old its data is; stale data is flagged, never silently shown as fresh.
   5. Scheduled (non-live) rows are labeled as such. */

const REFRESH_MS = 30_000, TICK_MS = 5_000, STALE_MS = 90_000;
const MODE_LABEL = { rail: 'Rail', lightrail: 'Light Rail', bus: 'Bus', ferry: 'Ferry', path: 'PATH', bikes: 'Citi Bike', shuttles: 'Shuttle' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const mins = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const isIso = (v) => typeof v === 'string' && v.includes('T');

const state = {
  meta: null, favorites: [], mode: 'rail', area: 'hoboken', open: null, query: '', loc: null,
  boards: new Map(), // key -> { data, fetchedAt, error, inflight }
};
try { Object.assign(state, JSON.parse(localStorage.getItem('hct') || '{}')); } catch { /* no storage */ }
function persist() { try { localStorage.setItem('hct', JSON.stringify({ favorites: state.favorites, mode: state.mode, area: state.area, loc: state.loc })); } catch { /* ignore */ } }

/* ---------- data ---------- */
const keyOf = (mode, id) => `${mode}:${id}`;
function urlFor(mode, id) {
  return { rail: `/api/rail/departures?station=${id}`, lightrail: `/api/lightrail/departures?station=${id}`,
    bus: `/api/bus/departures?hub=${id}`, ferry: `/api/ferry/departures?terminal=${id}`, nyc: `/api/nyc?area=${id}`,
    path: `/api/path/departures?station=${id}`, bikes: `/api/bikes?limit=40${state.loc ? `&lat=${state.loc.lat}&lon=${state.loc.lon}` : ''}`,
    shuttles: `/api/shuttles?system=${id}`, roads: '/api/roads', weather: '/api/weather' }[mode];
}
async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}
async function load(mode, id, { force = false } = {}) {
  const key = keyOf(mode, id);
  const b = state.boards.get(key) || {};
  if (b.inflight) return b.inflight;
  if (!force && b.fetchedAt && Date.now() - b.fetchedAt < 15_000) return b;
  b.inflight = api(urlFor(mode, id)).then((data) => { b.data = data; b.fetchedAt = Date.now(); b.error = null; })
    .catch((err) => { b.error = err.message; }) // keep last-good data
    .finally(() => { b.inflight = null; state.boards.set(key, b); render(); });
  state.boards.set(key, b);
  return b.inflight;
}

function stopsOf(mode) {
  const m = state.meta;
  const bikeStations = state.boards.get('bikes:all')?.data?.stations || [];
  return { rail: m.rail.map((s) => ({ ...s, id: s.code })), lightrail: m.lightRail, bus: m.bus.hubs, ferry: m.ferry.map((t) => ({ ...t })),
    path: m.path, bikes: bikeStations.map((b) => ({ ...b, town: `${b.bikes} bikes · ${b.docks} docks` })), shuttles: m.shuttles }[mode];
}
function stopName(mode, id) { return stopsOf(mode).find((s) => s.id === id)?.name || id; }
const isFav = (mode, id) => state.favorites.some((f) => f.mode === mode && f.id === id);
function toggleFav(mode, id) {
  state.favorites = isFav(mode, id) ? state.favorites.filter((f) => !(f.mode === mode && f.id === id)) : [...state.favorites, { mode, id }];
  persist(); refreshAll();
}
function distKm(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const fmtDist = (km) => (km < 0.16 ? `${Math.round(km * 3281)} ft` : `${(km * 0.621).toFixed(1)} mi`);

/* ---------- normalize any mode's departure into one row shape ---------- */
function toRow(mode, d) {
  if (mode === 'bus') {
    const eta = String(d.eta || '');
    const m = eta.match(/(\d+)\s*MIN/i);
    return { badge: eta || 'Scheduled', cls: /DELAY/i.test(eta) ? 'bad' : /APPROACH|^[0-3]\s*MIN/i.test(eta) ? 'warn' : eta ? 'ok' : 'sched',
      etaMin: /APPROACH/i.test(eta) ? 0 : m ? Number(m[1]) : null, scheduledText: isIso(d.scheduled) ? fmt(d.scheduled) : d.scheduled, dest: d.headsign, tag: `<span class="route">${esc(d.route)}</span>`,
      sub: [state.meta.bus.routeNames[d.route], d.lane ? `Lane ${d.lane}` : null, d.passengerLoad ? `${d.passengerLoad.toLowerCase()} load` : null, d.from].filter(Boolean).join(' · '),
      right2: d.lane ? `Lane ${d.lane}` : '', live: !!eta };
  }
  const delay = d.delayMin || 0;
  const status = String(d.status || '').toUpperCase();
  const live = d.source !== 'schedule' && d.source !== 'mock' ? true : d.source === 'mock';
  let cls = 'ok', badge = d.status || 'On time';
  if (delay > 0 || /LATE|DELAY/.test(status)) { cls = 'bad'; badge = delay > 0 ? `${delay} min late` : d.status; }
  else if (/BOARD|ABOARD|STAND|APPROACH/.test(status)) cls = 'warn';
  else if (/CANCEL/.test(status)) { cls = 'bad'; badge = 'Cancelled'; }
  else if (d.source === 'schedule' || status === 'SCHEDULED') { cls = 'sched'; badge = 'Scheduled'; }
  const est = d.scheduled ? new Date(new Date(d.scheduled).getTime() + delay * 60000).toISOString() : null;
  let tag = mode === 'rail' && d.lineAbbr ? `<span class="line" style="background:${esc(d.colors?.bg || '#888')};color:${esc(d.colors?.fg || '#fff')}">${esc(d.lineAbbr)}</span>` : '';
  if (mode === 'path' && d.lineColor) tag = `<span class="line" style="background:${esc(d.lineColor)};color:#fff">PATH</span>`;
  if (mode === 'path' && d.etaText && cls === 'ok') badge = d.etaText;
  const sub = [mode === 'rail' ? d.line : mode === 'lightrail' || mode === 'path' ? d.direction : d.routeName, d.trainId ? `Train ${d.trainId}` : null, d.inlineMessage, d.from].filter(Boolean).join(' · ');
  const track = mode === 'rail' ? (d.track ? `Track ${d.track}` : 'Track TBA') : '';
  return { badge, cls, etaMin: est ? mins(est) : null, scheduledIso: d.scheduled, estIso: est, delay, dest: d.destination, tag, sub, right2: track, live: d.source !== 'schedule' };
}
function rowHtml(mode, d) {
  const r = toRow(mode, d);
  let eta = '—', under = '';
  if (r.etaMin !== null) eta = r.etaMin <= 0 ? 'Now' : `${r.etaMin}<small>min</small>`;
  if (r.scheduledIso) under = r.delay > 0 ? `<s>${fmt(r.scheduledIso)}</s> <b>${fmt(r.estIso)}</b>` : fmt(r.scheduledIso);
  else if (r.scheduledText) under = `Sched ${esc(r.scheduledText)}`;
  return `<div class="row">
    <div class="row__eta">${eta}<small>${under}</small></div>
    <div class="row__main"><div class="row__dest">${r.tag} ${esc(r.dest)}</div><div class="row__sub">${esc(r.sub)}</div></div>
    <div class="row__right"><span class="badge ${r.cls}">${esc(r.badge)}</span>${r.right2 ? `<span class="track ${/TBA/.test(r.right2) ? 'tba' : ''}">${esc(r.right2)}</span>` : ''}</div>
  </div>`;
}
function rowsHtml(mode, list, limit) {
  const rows = (list || []).filter((d) => !isIso(d.scheduled) || mins(d.scheduled) > -2).slice(0, limit);
  return rows.length ? rows.map((d) => rowHtml(mode, d)).join('') : '<div class="empty">Nothing in the next hour.</div>';
}
function bikesHtml(stations, limit) {
  const list = (stations || []).slice(0, limit);
  if (!list.length) return '<div class="empty">No stations found.</div>';
  return list.map((s) => {
    const pct = s.capacity ? Math.round((s.bikes / s.capacity) * 100) : 0;
    return `<div class="bike">
      <div><div class="bike__name">${esc(s.name)}</div><div class="bike__sub">${s.km != null ? fmtDist(s.km) + ' · ' : ''}${!s.renting ? 'Not renting · ' : ''}${!s.returning ? 'Not accepting returns · ' : ''}${s.updated ? 'reported ' + fmt(s.updated) : ''}</div></div>
      <div class="bike__nums">
        <div class="${s.bikes <= 2 ? 'low' : ''}"><b>${s.bikes}</b><small>bikes</small></div>
        <div><b>${s.ebikes}</b><small>e-bikes</small></div>
        <div class="${s.docks <= 2 ? 'low' : ''}"><b>${s.docks}</b><small>docks</small></div>
      </div>
      <div class="bike__bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
}
function shuttleHtml(d, sys) {
  const veh = d.vehicles || [];
  const byRoute = {};
  for (const v of veh) (byRoute[v.route] ||= []).push(v);
  const routes = d.routes?.length ? d.routes : sys.routes;
  return `<div class="shuttle">
    <b>${veh.length ? `${veh.length} shuttle${veh.length > 1 ? 's' : ''} on the road now` : 'No shuttles reporting right now'}</b>
    ${routes.map((r) => `<span class="veh ${byRoute[r]?.length ? 'on' : ''}">${esc(r)}${byRoute[r]?.length ? ` · ${byRoute[r].length} live${byRoute[r][0].lastStop ? ` · near ${esc(byRoute[r][0].lastStop)}` : ''}` : ''}</span>`).join('')}
    <div class="row__sub" style="margin-top:6px">${esc(sys.fare)} · ${esc(sys.hours)}${sys.tips ? ` · ${esc(sys.tips)}` : ''}${d.error ? ` · <span class="stale">tracking unavailable: ${esc(d.error)}</span>` : ''}</div>
  </div>`;
}
function boardHtml(mode, id, limit = 8) {
  if (mode === 'bikes') {
    const all = state.boards.get('bikes:all');
    if (!all || (!all.data && !all.error)) return '<div class="loading">Loading…</div>';
    if (!all.data) return `<div class="error">Couldn't load (${esc(all.error)}).</div>`;
    const list = id === 'all' ? all.data.stations : all.data.stations.filter((s) => s.id === id);
    return bikesHtml(list, limit);
  }
  const b = state.boards.get(keyOf(mode, id));
  if (!b || (!b.data && !b.error)) return '<div class="loading">Loading…</div>';
  if (!b.data) return `<div class="error">Couldn't load (${esc(b.error)}).</div>`;
  if (mode === 'shuttles') return shuttleHtml(b.data, state.meta.shuttles.find((x) => x.id === id));
  const msg = b.data.message ? `<div class="note">${esc(b.data.message)}</div>` : '';
  return rowsHtml(mode, b.data.departures, limit) + msg;
}
function ageText(b) {
  if (!b?.fetchedAt) return '';
  const s = Math.round((Date.now() - b.fetchedAt) / 1000);
  const stale = Date.now() - b.fetchedAt > STALE_MS || b.error;
  return `<span class="${stale ? 'stale' : ''}">${stale ? 'Stale · ' : ''}updated ${s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`}${b.error ? ' · refresh failed' : ''}</span>`;
}

/* ---------- render ---------- */
function render() { renderFresh(); renderWx(); renderRoads(); renderFavs(); renderNyc(); renderAll(); renderOther(); }

function renderWx() {
  const b = state.boards.get('weather:now'); const w = b?.data; const el = $('wx');
  if (!w) { el.textContent = ''; return; }
  const rain = w.rainAt ? `<b>rain ${mins(w.rainAt) <= 0 ? 'now' : 'by ' + fmt(w.rainAt)}</b>` : w.precipPct >= 40 ? `<b>${w.precipPct}% rain</b>` : '';
  const wind = w.windMph >= 20 ? `<b>wind ${w.windMph} mph</b>` : '';
  el.innerHTML = [`${w.tempF}°`, esc(w.short), rain, wind].filter(Boolean).join(' · ');
}
function renderRoads() {
  const b = state.boards.get('roads:now'); const el = $('roads');
  if (!b?.data) { el.innerHTML = ''; return; }
  el.innerHTML = b.data.map((r) => {
    const cls = /incident|closed/i.test(r.state) ? 'bad' : /heavy|delay/i.test(r.state) ? 'warn' : 'ok';
    return `<div class="road"><div class="road__name">${esc(r.name)}</div>
      <span class="road__state ${cls}">${esc(r.state)}</span>${r.inboundMin != null ? ` <span class="road__note">· ${r.inboundMin} min inbound</span>` : ''}
      ${r.note ? `<div class="road__note">${esc(r.note)}</div>` : ''}</div>`;
  }).join('') + (b.data[0]?.source === 'mock' ? '<div class="road road__note" style="align-self:center;border:0">Road status is demo data until 511NJ is connected.</div>' : '');
}
function renderOther() {
  const el = $('other');
  if (el.dataset.done) return; el.dataset.done = '1';
  el.innerHTML = state.meta.other.map((s) => `<div class="svc"><b>${esc(s.name)}</b><span class="kind">${esc(s.kind)} · ${esc(s.area)}</span>
    <div>${esc(s.cost)}${s.hours ? ` · ${esc(s.hours)}` : ''}</div>${s.status ? `<div class="warn">${esc(s.status)}</div>` : ''}${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Operator site ↗</a>` : ''}</div>`).join('');
}

function renderFresh() {
  const modes = state.meta.modes;
  const live = Object.values(modes).includes('live');
  const boards = [...state.boards.values()].filter((b) => b.fetchedAt);
  const newest = boards.length ? Math.max(...boards.map((b) => b.fetchedAt)) : null;
  const anyStale = boards.some((b) => b.error || Date.now() - b.fetchedAt > STALE_MS);
  const el = $('fresh');
  el.className = `fresh ${anyStale ? 'is-stale' : live ? 'is-live' : 'is-mock'}`;
  $('fresh-text').textContent = (live ? 'Live' : 'Demo data') + (newest ? ` · ${Math.max(0, Math.round((Date.now() - newest) / 1000))}s ago` : '');
}

function renderFavs() {
  const el = $('fav-cards');
  if (!state.favorites.length) {
    const defaults = [['rail', 'HB'], ['bus', 'journal-square'], ['lightrail', 'newport'], ['ferry', 'hoboken-njt']];
    el.innerHTML = `<div class="empty-fav">Star any stop below and it'll be waiting here every time you open the page. Or start with:
      <div class="chips">${defaults.map(([m, id]) => `<button class="chip" data-fav="${m}:${id}">☆ ${esc(stopName(m, id))}</button>`).join('')}</div></div>`;
    return;
  }
  el.innerHTML = state.favorites.map(({ mode, id }) => {
    const b = state.boards.get(mode === 'bikes' ? 'bikes:all' : keyOf(mode, id));
    const stale = b?.fetchedAt && (b.error || Date.now() - b.fetchedAt > STALE_MS);
    return `<article class="card ${stale ? 'is-stale' : ''}">
      <div class="card__head"><span class="mode ${mode}">${MODE_LABEL[mode]}</span><span class="card__name">${esc(stopName(mode, id))}</span>
        <button class="star is-on" data-fav="${mode}:${id}" aria-label="Remove from your stops">★</button></div>
      ${boardHtml(mode, id, 4)}
      <div class="card__foot">${ageText(b)}<span>${b?.data?.departures?.[0]?.source === 'schedule' ? 'timetable' : ''}</span></div>
    </article>`;
  }).join('');
}

function renderNyc() {
  $('nyc-areas').innerHTML = state.meta.nyc.map((a) => `<button class="chip ${a.id === state.area ? 'is-active' : ''}" data-area="${a.id}">${esc(a.name)}</button>`).join('');
  const b = state.boards.get(keyOf('nyc', state.area));
  const el = $('nyc-board');
  if (!b || (!b.data && !b.error)) { el.innerHTML = '<div class="loading">Loading…</div>'; return; }
  if (!b.data) { el.innerHTML = `<div class="error">Couldn't load (${esc(b.error)}).</div>`; return; }
  const rows = b.data.departures.filter((d) => !isIso(d.scheduled) || mins(d.scheduled) > -2).slice(0, 8);
  el.innerHTML = (rows.length ? rows.map((d) => rowHtml(d.mode, { ...d, from: d.from })).join('') : '<div class="empty">No NYC-bound departures found in the next hour.</div>')
    + `<div class="note">${ageText(b)}${b.data.failedSources ? ` · ${b.data.failedSources} source(s) didn't answer` : ''}</div>`;
}

function renderAll() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.mode === state.mode));
  const q = state.query.trim().toLowerCase();
  const modes = q ? ['rail', 'lightrail', 'bus', 'path', 'ferry', 'bikes', 'shuttles'] : [state.mode];
  if (state.mode === 'bikes' && !q) {
    const b = state.boards.get('bikes:all');
    $('all-hint').textContent = state.loc ? 'Nearest Citi Bike docks first.' : 'Citi Bike docks in Jersey City and Hoboken. Tap Nearby to sort by distance.';
    $('nearby-btn').classList.toggle('is-active', !!state.loc);
    $('stoplist').innerHTML = (b?.data ? bikesHtml(b.data.stations, 40) : b?.error ? `<div class="error">Couldn't load (${esc(b.error)}).</div>` : '<div class="loading">Loading…</div>')
      + `<div class="note">${ageText(b)} · star a dock from search to pin it</div>`;
    return;
  }
  let items = modes.flatMap((mode) => stopsOf(mode).map((s) => ({ mode, s })));
  if (q) items = items.filter(({ s }) => `${s.name} ${s.town} ${(s.routes || []).join(' ')} ${(s.lines || []).join(' ')}`.toLowerCase().includes(q));
  if (state.loc) items.forEach((it) => { it.km = it.s.lat != null ? distKm(state.loc, it.s) : Infinity; });
  items.sort((a, b) => (state.loc ? a.km - b.km : a.s.name.localeCompare(b.s.name)));
  $('all-hint').textContent = state.loc ? 'Sorted by distance from you.' : 'Alphabetical. Tap Nearby to sort by distance.';
  $('nearby-btn').classList.toggle('is-active', !!state.loc);
  $('stoplist').innerHTML = items.length ? items.map(({ mode, s, km }) => {
    const open = state.open === keyOf(mode, s.id);
    return `<div class="stop">
      <div class="stop__head" data-open="${mode}:${s.id}" role="button" aria-expanded="${open}">
        <span class="mode ${mode}">${MODE_LABEL[mode]}</span>
        <span class="stop__name">${esc(s.name)}<small>${esc(s.town)}${s.routes ? ` · ${s.routes.slice(0, 8).join(', ')}${s.routes.length > 8 ? '…' : ''}` : ''}</small></span>
        ${km !== undefined ? `<span class="stop__dist">${fmtDist(km)}</span>` : ''}
        <button class="star ${isFav(mode, s.id) ? 'is-on' : ''}" data-fav="${mode}:${s.id}" aria-label="Star">${isFav(mode, s.id) ? '★' : '☆'}</button>
      </div>
      ${open ? `<div class="stop__body">${boardHtml(mode, s.id, 8)}<div class="note">${ageText(state.boards.get(keyOf(mode, s.id)))}</div></div>` : ''}
    </div>`;
  }).join('') : '<div class="empty">No stops match.</div>';
}

function renderAlerts(msgs) {
  const el = $('alerts');
  el.hidden = !msgs?.length;
  el.innerHTML = (msgs || []).slice(0, 3).map((m) => `<div class="alert">${esc(m.text)}${m.published ? `<small>${fmt(m.published)}</small>` : ''}</div>`).join('');
}

/* ---------- refresh loop ---------- */
function refreshAll(force = false) {
  for (const f of state.favorites) if (f.mode !== 'bikes') load(f.mode, f.id, { force });
  if (state.mode === 'bikes' || state.favorites.some((f) => f.mode === 'bikes') || state.query) load('bikes', 'all', { force });
  load('roads', 'now', { force }); load('weather', 'now', { force });
  load('nyc', state.area, { force });
  if (state.open) { const [m, id] = state.open.split(':'); load(m, id, { force }); }
  const railFav = state.favorites.find((f) => f.mode === 'rail');
  api(`/api/rail/messages?station=${railFav ? railFav.id : 'HB'}`).then(renderAlerts).catch(() => {});
  render();
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { e.stopPropagation(); const [m, id] = fav.dataset.fav.split(':'); toggleFav(m, id); return; }
  const open = e.target.closest('[data-open]');
  if (open) { state.open = state.open === open.dataset.open ? null : open.dataset.open; render(); if (state.open) { const [m, id] = state.open.split(':'); load(m, id); } return; }
  const area = e.target.closest('[data-area]');
  if (area) { state.area = area.dataset.area; persist(); load('nyc', state.area); render(); return; }
  const tab = e.target.closest('.tab');
  if (tab) { state.mode = tab.dataset.mode; state.query = ''; $('search').value = ''; persist(); if (state.mode === 'bikes') load('bikes', 'all'); render(); }
});
$('search').addEventListener('input', (e) => { state.query = e.target.value; if (state.query) load('bikes', 'all'); renderAll(); });
$('nearby-btn').addEventListener('click', () => {
  if (state.loc) { state.loc = null; persist(); renderAll(); return; }
  if (!navigator.geolocation) { alert('Location is not available in this browser.'); return; }
  $('nearby-btn').textContent = '⌖ Locating…';
  navigator.geolocation.getCurrentPosition(
    (p) => { state.loc = { lat: p.coords.latitude, lon: p.coords.longitude }; persist(); $('nearby-btn').textContent = '⌖ Nearby'; load('bikes', 'all', { force: true }); renderAll(); },
    () => { $('nearby-btn').textContent = '⌖ Nearby'; alert('Couldn\'t get your location. Check the browser permission and try again.'); },
    { maximumAge: 60_000, timeout: 8_000 });
});

(async function init() {
  try { state.meta = await api('/api/meta'); }
  catch (err) { $('fresh').className = 'fresh is-error'; $('fresh-text').textContent = `Server unavailable: ${err.message}`; return; }
  refreshAll(true);
  setInterval(() => refreshAll(true), REFRESH_MS);
  setInterval(render, TICK_MS); // countdowns and "updated Ns ago" tick without refetching
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(true); });
})();
