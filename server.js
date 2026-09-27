// HudPost transit MVP server: static files + a thin JSON API that proxies NJ Transit.
// Zero dependencies (Node 20+). Run `npm run dev` for mock data, `npm start` with a .env for live data.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hudson from './data/hudson.json' with { type: 'json' };
import { createRailClient, createBusClient } from './lib/njt.js';
import { createMockRail, createMockBus, createMockLightRail, createMockFerry } from './lib/mock.js';
import { createFerryClient } from './lib/ferry.js';
import { createPathClient } from './lib/path.js';
import { createBikesClient } from './lib/bikes.js';
import { createPassioClient } from './lib/passio.js';
import { createWeatherClient } from './lib/weather.js';
import { createMockPath, createMockBikes, createMockPassio, createMockRoads, createMockWeather } from './lib/mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const TTL_MS = Number(process.env.NJT_CACHE_TTL || 20) * 1000;
const FORCE_MOCK = /^(1|true|yes)$/i.test(process.env.NJT_MOCK || '');

const rail = !FORCE_MOCK && process.env.NJT_RAIL_USERNAME && process.env.NJT_RAIL_PASSWORD
  ? createRailClient({ username: process.env.NJT_RAIL_USERNAME, password: process.env.NJT_RAIL_PASSWORD })
  : createMockRail();
const bus = !FORCE_MOCK && process.env.NJT_BUS_USERNAME && process.env.NJT_BUS_PASSWORD
  ? createBusClient({ username: process.env.NJT_BUS_USERNAME, password: process.env.NJT_BUS_PASSWORD })
  : createMockBus();
// No public real-time light rail endpoint is documented in any client library we could find;
// until one is confirmed on the portal, light rail is schedule/mock only.
const lightRail = createMockLightRail();
// NY Waterway: schedule from a downloaded GTFS zip when NYWW_GTFS_PATH points at one.
let ferry;
try {
  ferry = !FORCE_MOCK && process.env.NYWW_GTFS_PATH ? createFerryClient({ gtfsPath: process.env.NYWW_GTFS_PATH }) : createMockFerry();
} catch (err) {
  console.error(`[ferry] could not load GTFS (${err.message}); using mock`);
  ferry = createMockFerry();
}

// Keyless public feeds: on by default, off with NJT_MOCK=1 or the per-feed flag.
const off = (name) => FORCE_MOCK || /^(0|false|off)$/i.test(process.env[name] || '');
const pathClient = off('PATH_LIVE') ? createMockPath() : createPathClient();
const bikes = off('BIKES_LIVE') ? createMockBikes() : createBikesClient();
const passio = off('SHUTTLES_LIVE') ? createMockPassio() : createPassioClient();
const weather = off('WEATHER_LIVE') ? createMockWeather() : createWeatherClient(hudson.weather);
const roads = createMockRoads(); // 511NJ needs a developer key; see docs/njt-api.md

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const routes = {
  '/api/meta': async () => ({
    county: hudson.county,
    modes: { rail: rail.mode, bus: bus.mode, lightRail: lightRail.mode, ferry: ferry.mode, path: pathClient.mode, bikes: bikes.mode, shuttles: passio.mode, roads: roads.mode, weather: weather.mode },
    path: hudson.path.stations,
    shuttles: hudson.shuttles.systems.map(({ passioSystemId, passioHost, ...rest }) => rest),
    roads: hudson.roads.crossings,
    other: hudson.other.services,
    notes: hudson.notes,
    ferry: hudson.ferry.terminals,
    nyc: hudson.nyc.areas,
    cacheSeconds: TTL_MS / 1000,
    rail: hudson.rail.stations,
    lightRail: hudson.lightRail.stations,
    bus: { hubs: hudson.bus.hubs, routeNames: hudson.bus.routeNames },
  }),
  '/api/rail/departures': async (q) => {
    const station = (q.get('station') || 'HB').toUpperCase();
    if (!hudson.rail.stations.some((s) => s.code === station)) throw httpError(400, 'unknown Hudson County station');
    return cached(`rail:${station}`, () => rail.departures(station));
  },
  '/api/rail/messages': async (q) => {
    const station = (q.get('station') || 'HB').toUpperCase();
    return cached(`railmsg:${station}`, () => rail.messages(station));
  },
  '/api/lightrail/departures': async (q) => {
    const station = q.get('station') || 'hoboken-terminal';
    if (!hudson.lightRail.stations.some((s) => s.id === station)) throw httpError(400, 'unknown HBLR station');
    return cached(`lr:${station}`, () => lightRail.departures(station));
  },
  '/api/path/departures': async (q) => {
    const station = (q.get('station') || 'HOB').toUpperCase();
    if (!hudson.path.stations.some((s) => s.id === station)) throw httpError(400, 'unknown PATH station');
    return cached(`path:${station}`, () => pathClient.departures(station));
  },
  // Nearest Citi Bike stations (all Hudson County stations when no lat/lon is given).
  '/api/bikes': async (q) => {
    const all = await cached('bikes', () => bikes.stations());
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    const list = all.map((s) => ({ ...s, km: Number.isFinite(lat) && Number.isFinite(lon) ? haversine(lat, lon, s.lat, s.lon) : null }));
    list.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || a.name.localeCompare(b.name));
    return { stations: list.slice(0, Number(q.get('limit') || 12)), total: all.length };
  },
  '/api/shuttles': async (q) => {
    const sys = hudson.shuttles.systems.find((x) => x.id === q.get('system'));
    if (!sys) throw httpError(400, 'unknown shuttle system');
    return cached(`shuttle:${sys.id}`, async () => {
      try { return await passio.status(sys); }
      catch (err) { return { system: sys.id, name: sys.name, live: false, vehicles: [], routes: sys.routes, error: err.message }; }
    });
  },
  '/api/roads': async () => cached('roads', () => roads.status()),
  '/api/weather': async () => cached('weather', () => weather.now()),
  '/api/ferry/departures': async (q) => {
    const terminal = q.get('terminal') || 'hoboken-njt';
    if (!hudson.ferry.terminals.some((t) => t.id === terminal)) throw httpError(400, 'unknown ferry terminal');
    return cached(`ferry:${terminal}`, () => ferry.departures(terminal));
  },
  // Cross-mode "To Manhattan" board for one area: every NYC-bound departure, soonest first.
  '/api/nyc': async (q) => {
    const area = hudson.nyc.areas.find((a) => a.id === q.get('area'));
    if (!area) throw httpError(400, 'unknown area');
    return cached(`nyc:${area.id}`, async () => {
      const jobs = [];
      for (const code of area.rail) jobs.push(rail.departures(code).then((d) => d.departures
        .filter((x) => /NEW YORK|NY PENN/i.test(x.destination || '')).map((x) => ({ ...x, mode: 'rail', from: d.stationName, fromId: code, eta: null }))));
      for (const id of area.bus) {
        const hub = hudson.bus.hubs.find((h) => h.id === id);
        if (bus.mode === 'live' && !hub.stopId) continue;
        jobs.push(bus.departures(hub.stopId || hub.id).then((d) => d.departures
          .filter((x) => /NEW YORK|PORT AUTH|MIDTOWN|NYC/i.test(`${x.headsign} ${hudson.bus.routeNames[x.route] || ''}`))
          .map((x) => ({ ...x, mode: 'bus', from: hub.name, fromId: id, destination: x.headsign, scheduled: busSchedToIso(x.scheduled) }))));
      }
      for (const id of area.path || []) jobs.push(pathClient.departures(id).then((d) => d.departures
        .filter((x) => /New York|33rd|World Trade/i.test(`${x.direction} ${x.destination}`)).map((x) => ({ ...x, mode: 'path', from: `${hudson.path.stations.find((s) => s.id === id)?.name} PATH`, fromId: id }))));
      for (const id of area.ferry) jobs.push(ferry.departures(id).then((d) => d.departures.map((x) => ({ ...x, mode: 'ferry', from: d.terminalName, fromId: id }))));
      const settled = await Promise.allSettled(jobs);
      const rows = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const failed = settled.filter((r) => r.status === 'rejected').length;
      rows.sort((a, b) => String(a.scheduled || '9').localeCompare(String(b.scheduled || '9')));
      return { area: area.id, areaName: area.name, failedSources: failed, departures: rows.slice(0, 20) };
    });
  },
  '/api/bus/departures': async (q) => {
    const hubId = q.get('hub');
    const hub = hudson.bus.hubs.find((h) => h.id === hubId);
    const stop = q.get('stop') || hub?.stopId;
    if (!hub && !stop) throw httpError(400, 'pass hub=<id> or stop=<5-digit code>');
    if (bus.mode === 'live' && !stop) throw httpError(422, `stop code for ${hub.name} not configured yet`);
    return cached(`bus:${stop || hub.id}`, () => bus.departures(stop || hub.id, { route: q.get('route') || '' }));
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (routes[url.pathname]) {
    try {
      const data = await routes[url.pathname](url.searchParams);
      send(res, 200, JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), ...wrap(data) }), MIME['.json']);
    } catch (err) {
      const status = err.status || 502;
      console.error(`[api] ${url.pathname} -> ${status}: ${err.message}`);
      send(res, status, JSON.stringify({ ok: false, error: err.message }), MIME['.json']);
    }
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Hudson County transit on http://localhost:${PORT}`, { rail: rail.mode, bus: bus.mode, lightRail: lightRail.mode, ferry: ferry.mode, path: pathClient.mode, bikes: bikes.mode, shuttles: passio.mode, weather: weather.mode });
});

/** BUSDV2 gives "04:55 PM" with no date; anchor it to today (or tomorrow if it already passed by >6h). */
function busSchedToIso(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (m[3].toUpperCase() === 'PM') h += 12;
  const d = new Date(); d.setHours(h, Number(m[2]), 0, 0);
  if (d.getTime() < Date.now() - 6 * 3600 * 1000) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
function wrap(data) { return Array.isArray(data) ? { data } : { data }; }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function serveStatic(pathname, res) {
  const root = path.join(__dirname, 'public');
  let file = path.normalize(path.join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root)) return send(res, 403, 'forbidden', 'text/plain');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
