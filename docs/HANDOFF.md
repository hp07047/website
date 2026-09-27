# Hudson County Transit — source handoff

Repo `hp07047/website`, branch `claude/nj-transit-hudson-county-mvp-f2tfpp`, commit `f656586`. Every file in the repo follows, byte for byte, one fenced block each. Recreate the tree with these paths and run `npm run dev` (Node 20+, no npm dependencies).

Files:

- `package.json`
- `.env.example`
- `.gitignore`
- `server.js`
- `lib/njt.js`
- `lib/mock.js`
- `lib/gtfs.js`
- `lib/ferry.js`
- `lib/path.js`
- `lib/bikes.js`
- `lib/passio.js`
- `lib/weather.js`
- `data/hudson.json`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
- `test/njt.test.js`
- `test/gtfs.test.js`
- `README.md`
- `docs/njt-api.md`

## `package.json`

````json
{
  "name": "hudpost-transit",
  "version": "0.1.0",
  "description": "HudPost Hudson County transit page (MVP) backed by the NJ Transit developer API",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "dev": "NJT_MOCK=1 node server.js",
    "test": "node --test"
  }
}
````

## `.env.example`

````ini
# NJ Transit developer portal credentials (https://developer.njtransit.com/registration/)
# Each API on the portal is approved separately; leave one blank to fall back to mock data for that mode.
NJT_RAIL_USERNAME=
NJT_RAIL_PASSWORD=
NJT_BUS_USERNAME=
NJT_BUS_PASSWORD=

# Base URLs (defaults shown). Use testraildata.njtransit.com while your rail request is pending.
NJT_RAIL_BASE=https://raildata.njtransit.com/api/TrainData
NJT_BUS_BASE=https://pcsdata.njtransit.com/api/BUSDV2

# Force mock data for every mode (handy for front-end work)
NJT_MOCK=0

# Seconds to cache each upstream response. NJ Transit caps most endpoints at 40,000 calls/day.
NJT_CACHE_TTL=20

PORT=3000

# NY Waterway timetable: path to a downloaded https://nywaterway.connexionz.net/rtt/public/resource/gtfs.zip
NYWW_GTFS_PATH=

# Keyless public feeds are live by default. Set any to 0 to force its mock (e.g. offline dev).
PATH_LIVE=1        # PANYNJ ridepath.json
BIKES_LIVE=1       # Citi Bike GBFS
SHUTTLES_LIVE=1    # Passio GO (needs passioSystemId in data/hudson.json)
WEATHER_LIVE=1     # api.weather.gov
````

## `.gitignore`

````text
.env
node_modules/
````

## `server.js`

````javascript
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
````

## `lib/njt.js`

````javascript
// NJ Transit developer API adapter.
//
// Two separate products from developer.njtransit.com are used, each with its own
// credentials and token endpoint:
//   Rail  – TrainData:  https://raildata.njtransit.com/api/TrainData/{getToken,getTrainSchedule,getStationMSG,...}
//   Bus   – BUSDV2:     https://pcsdata.njtransit.com/api/BUSDV2/{authenticateUser,getBusDV,getVehicleLocations}
// Every call is a POST with a multipart/form-data body. Tokens are returned as
// { "Authenticated": "True", "UserToken": "..." } and last roughly a day.
// Timestamps come back as strings like "18-Sep-2026 03:02:18 PM" and numbers as strings.

const RAIL_BASE = (process.env.NJT_RAIL_BASE || 'https://raildata.njtransit.com/api/TrainData').replace(/\/$/, '');
const BUS_BASE = (process.env.NJT_BUS_BASE || 'https://pcsdata.njtransit.com/api/BUSDV2').replace(/\/$/, '');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse "18-Sep-2026 03:02:18 PM" (NJ Transit, America/New_York local) into an ISO string. */
export function parseNjtDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let hour = Number(m[4]);
  const ampm = (m[7] || '').toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  // Build in local time of the server; deploy with TZ=America/New_York.
  const d = new Date(Number(m[3]), MONTHS[m[2].slice(0, 1).toUpperCase() + m[2].slice(1).toLowerCase()], Number(m[1]), hour, Number(m[5]), Number(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

class TokenCache {
  constructor(name, fetchToken) {
    this.name = name;
    this.fetchToken = fetchToken;
    this.token = null;
    this.expires = 0;
  }
  async get(force = false) {
    if (!force && this.token && Date.now() < this.expires) return this.token;
    const token = await this.fetchToken();
    this.token = token;
    this.expires = Date.now() + 20 * 60 * 60 * 1000; // ~24h upstream; refresh after 20h
    return token;
  }
}

async function postForm(url, fields) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.append(k, String(v));
  const res = await fetch(url, { method: 'POST', body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} -> non-JSON response: ${text.slice(0, 200)}`);
  }
}

function makeAuth(name, url, username, password) {
  return new TokenCache(name, async () => {
    const data = await postForm(url, { username, password });
    if (String(data.Authenticated).toLowerCase() !== 'true' || !data.UserToken) {
      throw new Error(`${name}: authentication failed (${JSON.stringify(data).slice(0, 200)})`);
    }
    return data.UserToken;
  });
}

/** Retry once with a fresh token if the upstream rejects the cached one. */
async function withToken(cache, fn) {
  try {
    return await fn(await cache.get());
  } catch (err) {
    if (/token|authent|401|403/i.test(String(err.message))) return fn(await cache.get(true));
    throw err;
  }
}

export function createRailClient({ username, password }) {
  const auth = makeAuth('rail', `${RAIL_BASE}/getToken`, username, password);
  const call = (method, fields) => withToken(auth, (token) => postForm(`${RAIL_BASE}/${method}`, { token, username, ...fields }));

  return {
    mode: 'live',
    async stations() {
      const data = await call('getStationList', {});
      const list = Array.isArray(data) ? data : data.STATIONS || data.stations || [];
      return list.map((s) => ({ code: s.STATION_2CHAR, name: s.STATIONNAME }));
    },
    /** DepartureVision-equivalent board for one station. */
    async departures(station) {
      const data = await call('getTrainSchedule', { station });
      const items = data.ITEMS || data.items || [];
      return {
        station: data.STATION_2CHAR || station,
        stationName: data.STATIONNAME || null,
        departures: items.map(normalizeRailItem),
      };
    },
    async messages(station, line = '') {
      const data = await call('getStationMSG', { station, line });
      const list = Array.isArray(data) ? data : data.MESSAGES || data.messages || [];
      return list.map((m) => ({
        id: m.MSG_ID || null,
        type: m.MSG_TYPE || null,
        text: m.MSG_TEXT || '',
        published: parseNjtDate(m.MSG_PUBDATE),
        url: m.MSG_URL || null,
        stations: m.MSG_STATION_SCOPE || null,
        lines: m.MSG_LINE_SCOPE || null,
      }));
    },
  };
}

function normalizeRailItem(i) {
  const secLate = Number(i.SEC_LATE || 0);
  return {
    trainId: i.TRAIN_ID || null,
    line: i.LINE || null,
    lineAbbr: i.LINEABBREVIATION || null,
    destination: i.DESTINATION || null,
    scheduled: parseNjtDate(i.SCHED_DEP_DATE),
    track: i.TRACK || null,
    status: i.STATUS || null,
    delayMin: Number.isFinite(secLate) ? Math.round(secLate / 60) : 0,
    colors: { bg: i.BACKCOLOR || null, fg: i.FORECOLOR || null },
    inlineMessage: i.INLINEMSG || null,
    stops: Array.isArray(i.STOPS)
      ? i.STOPS.map((s) => ({ name: s.NAME, time: parseNjtDate(s.TIME), departed: String(s.DEPARTED).toLowerCase() === 'yes' }))
      : [],
  };
}

export function createBusClient({ username, password }) {
  const auth = makeAuth('bus', `${BUS_BASE}/authenticateUser`, username, password);
  const call = (method, fields) => withToken(auth, (token) => postForm(`${BUS_BASE}/${method}`, { token, ...fields }));

  return {
    mode: 'live',
    /** Next departures at a 5-digit stop code. direction/route are optional filters. */
    async departures(stop, { direction = '', route = '', ip = '' } = {}) {
      const data = await call('getBusDV', { stop, direction, route, ip });
      const trips = data.DVTrip || data.dvtrip || [];
      return {
        stop,
        message: data.message?.message || data.message || null,
        departures: trips.map((t) => ({
          route: t.public_route || null,
          headsign: t.header || null,
          eta: t.departuretime || null, // e.g. "5 MIN", "Approaching", "DELAY"
          scheduled: t.sched_dep_time || null, // e.g. "04:55 PM"
          lane: t.lanegate || null,
          vehicleId: t.vehicle_id || null,
          passengerLoad: t.passload || null,
          remarks: t.remarks || t.message || null,
          tripId: t.internal_trip_number || null,
        })),
      };
    },
    /** Live vehicle positions near a point (mode 'ALL' | 'BUS' | 'LIGHTRAIL' depending on portal access). */
    async vehicles({ lat, lon, radius = 2, mode = 'ALL' }) {
      const data = await call('getVehicleLocations', { lat, lon, radius, mode });
      const list = Array.isArray(data) ? data : data.VehicleLocations || [];
      return list.map((v) => ({
        id: v.VehicleID,
        route: v.VehicleRoute,
        destination: v.VehicleDestination,
        lat: Number(v.VehicleLat),
        lon: Number(v.VehicleLong),
        load: v.VehiclePassengerLoad,
        distanceMiles: Number(v.VehicleDistanceMiles),
        scheduled: v.VehicleScheduledDeparture,
      }));
    },
  };
}
````

## `lib/mock.js`

````javascript
// Deterministic-ish mock data so the page works without NJ Transit credentials.
// Shapes match what lib/njt.js returns after normalization.

import hudson from '../data/hudson.json' with { type: 'json' };

const RAIL_LINES = {
  HB: [
    ['Main/Bergen', 'MBPJ', 'Suffern'], ['Pascack Valley', 'PASC', 'Spring Valley'],
    ['Morris & Essex', 'MOBO', 'Dover'], ['Montclair-Boonton', 'MOBO', 'Montclair State U'],
    ['Main/Bergen', 'MBPJ', 'Port Jervis'], ['Morris & Essex', 'MOBO', 'Gladstone'],
  ],
  SE: [
    ['Northeast Corridor', 'NEC', 'New York Penn'], ['Northeast Corridor', 'NEC', 'Trenton'],
    ['North Jersey Coast', 'NJCL', 'Long Branch'], ['Raritan Valley', 'RARV', 'Raritan'],
    ['Morris & Essex', 'MOBO', 'New York Penn'], ['Northeast Corridor', 'NEC', 'New York Penn'],
  ],
  TS: [
    ['Main/Bergen', 'MBPJ', 'Hoboken'], ['Pascack Valley', 'PASC', 'Hoboken'],
    ['Main/Bergen', 'MBPJ', 'Suffern'], ['Port Jervis', 'MBPJ', 'Port Jervis'],
    ['Pascack Valley', 'PASC', 'Spring Valley'], ['Main/Bergen', 'MBPJ', 'Hoboken'],
  ],
};
const LINE_COLORS = { MBPJ: '#FFD006', PASC: '#8E258D', MOBO: '#00A94F', NEC: '#EF3E42', NJCL: '#00A4E4', RARV: '#FAA634' };
const STATUSES = ['ON TIME', 'ON TIME', 'ON TIME', 'BOARDING', 'ALL ABOARD', 'DELAYED', 'ON TIME'];

function seed(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}
const minute = () => Math.floor(Date.now() / 60000);

export function createMockRail() {
  return {
    mode: 'mock',
    async stations() { return hudson.rail.stations.map(({ code, name }) => ({ code, name })); },
    async departures(station) {
      const lines = RAIL_LINES[station] || RAIL_LINES.HB;
      const rnd = seed(station + minute());
      const base = Date.now();
      const departures = lines.map(([line, abbr, dest], i) => {
        const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
        const delayMin = status === 'DELAYED' ? 5 + Math.floor(rnd() * 20) : 0;
        return {
          trainId: String(1000 + Math.floor(rnd() * 8000)),
          line, lineAbbr: abbr, destination: dest,
          scheduled: new Date(base + (3 + i * 9 + Math.floor(rnd() * 5)) * 60000).toISOString(),
          track: rnd() > 0.3 ? String(1 + Math.floor(rnd() * 17)) : null,
          status, delayMin,
          colors: { bg: LINE_COLORS[abbr] || '#888', fg: abbr === 'MBPJ' ? '#000' : '#fff' },
          inlineMessage: null, stops: [],
        };
      }).sort((a, b) => a.scheduled.localeCompare(b.scheduled));
      const st = hudson.rail.stations.find((s) => s.code === station);
      return { station, stationName: st?.name || station, departures };
    },
    async messages(station) {
      const rnd = seed('msg' + station + Math.floor(minute() / 30));
      if (rnd() > 0.5) return [];
      return [{
        id: 'mock-1', type: 'banner',
        text: station === 'HB'
          ? 'Hoboken Terminal: Track 5 and 6 out of service this weekend for platform work. Expect gate changes.'
          : 'Secaucus Junction: Escalator between upper and lower levels out of service. Use elevator near Track A.',
        published: new Date(Date.now() - 45 * 60000).toISOString(), url: null, stations: station, lines: null,
      }];
    },
  };
}

const LR_DESTS = { north: ['Tonnelle Avenue', 'Hoboken Terminal'], south: ['8th Street', 'West Side Avenue', 'Bayonne Flyer – 8th St'] };

export function createMockLightRail() {
  return {
    mode: 'mock',
    async departures(stationId) {
      const rnd = seed('lr' + stationId + minute());
      const base = Date.now();
      const departures = [];
      for (let i = 0; i < 6; i++) {
        const dir = i % 2 ? 'south' : 'north';
        const dests = LR_DESTS[dir];
        departures.push({
          direction: dir === 'north' ? 'Northbound' : 'Southbound',
          destination: dests[Math.floor(rnd() * dests.length)],
          scheduled: new Date(base + (2 + i * 5 + Math.floor(rnd() * 3)) * 60000).toISOString(),
          status: rnd() > 0.85 ? 'DELAYED' : 'ON TIME',
          source: 'schedule',
        });
      }
      const st = hudson.lightRail.stations.find((s) => s.id === stationId);
      return { station: stationId, stationName: st?.name || stationId, departures: departures.sort((a, b) => a.scheduled.localeCompare(b.scheduled)) };
    },
  };
}

const ETAS = ['Approaching', '2 MIN', '4 MIN', '7 MIN', '11 MIN', '15 MIN', '19 MIN', '24 MIN', 'DELAY'];

export function createMockBus() {
  return {
    mode: 'mock',
    async departures(stopOrHubId) {
      const hub = hudson.bus.hubs.find((h) => h.id === stopOrHubId || h.stopId === stopOrHubId) || hudson.bus.hubs[0];
      const rnd = seed('bus' + hub.id + minute());
      const routes = [...hub.routes].sort(() => rnd() - 0.5).slice(0, 8);
      const now = new Date();
      const departures = routes.map((route, i) => {
        const eta = ETAS[Math.min(ETAS.length - 1, i + Math.floor(rnd() * 2))];
        const sched = new Date(now.getTime() + (i * 4 + 2) * 60000);
        return {
          route,
          headsign: (hudson.bus.routeNames[route] || 'Local').split(' – ').pop().toUpperCase(),
          eta,
          scheduled: sched.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          lane: rnd() > 0.5 ? String(1 + Math.floor(rnd() * 12)) : null,
          vehicleId: String(5000 + Math.floor(rnd() * 3000)),
          passengerLoad: ['LIGHT', 'MEDIUM', 'HEAVY'][Math.floor(rnd() * 3)],
          remarks: null, tripId: null,
        };
      });
      return { stop: hub.stopId || hub.id, hub: hub.name, message: null, departures };
    },
    async vehicles() { return []; },
  };
}

export function createMockFerry() {
  return {
    mode: 'mock',
    async departures(terminalId) {
      const t = hudson.ferry.terminals.find((x) => x.id === terminalId) || hudson.ferry.terminals[0];
      const rnd = seed('ferry' + t.id + minute());
      const base = Date.now();
      const departures = [];
      for (let i = 0; i < 6; i++) {
        const dest = t.routes[i % t.routes.length];
        const late = rnd() > 0.7 ? 3 + Math.floor(rnd() * 12) : 0;
        departures.push({
          route: dest.split(' /')[0], routeName: `${t.name.split(' /')[0]} – ${dest}`, destination: dest,
          scheduled: new Date(base + (4 + i * 12 + Math.floor(rnd() * 4)) * 60000).toISOString(),
          status: late ? `${late} MIN LATE` : 'ON TIME', delayMin: late, source: 'mock',
        });
      }
      return { terminal: t.id, terminalName: t.name, departures: departures.sort((a, b) => a.scheduled.localeCompare(b.scheduled)) };
    },
  };
}

/* ---- v3 mocks: PATH, bikes, shuttles, roads, weather ---- */
const PATH_DESTS = {
  JSQ: [['33rd Street', 'ToNY', '#FF9900'], ['World Trade Center', 'ToNY', '#D93A30'], ['Newark', 'ToNJ', '#D93A30'], ['33rd Street via Hoboken', 'ToNY', '#4D92FB']],
  GRV: [['33rd Street', 'ToNY', '#FF9900'], ['World Trade Center', 'ToNY', '#D93A30'], ['Journal Square', 'ToNJ', '#FF9900'], ['Newark', 'ToNJ', '#D93A30']],
  EXP: [['World Trade Center', 'ToNY', '#D93A30'], ['Newark', 'ToNJ', '#D93A30'], ['Hoboken', 'ToNJ', '#65C100']],
  NEW: [['33rd Street', 'ToNY', '#FF9900'], ['Journal Square', 'ToNJ', '#FF9900'], ['Hoboken', 'ToNJ', '#4D92FB']],
  HOB: [['33rd Street', 'ToNY', '#4D92FB'], ['World Trade Center', 'ToNY', '#65C100'], ['Journal Square', 'ToNJ', '#4D92FB']],
  HAR: [['World Trade Center', 'ToNY', '#D93A30'], ['Newark', 'ToNJ', '#D93A30']],
};
export function createMockPath() {
  return {
    mode: 'mock',
    async departures(station) {
      const rnd = seed('path' + station + minute());
      const departures = [];
      for (const [dest, dir, color] of PATH_DESTS[station] || PATH_DESTS.HOB) {
        for (let k = 0; k < 2; k++) {
          const secs = (2 + k * 9 + Math.floor(rnd() * 5)) * 60;
          const delayed = rnd() > 0.9;
          departures.push({ destination: dest, direction: dir === 'ToNY' ? 'To New York' : 'To New Jersey', scheduled: new Date(Date.now() + secs * 1000).toISOString(),
            etaText: delayed ? 'Delayed' : `${Math.round(secs / 60)} min`, lineColor: color, status: delayed ? 'DELAYED' : 'ON TIME', delayMin: 0, source: 'mock' });
        }
      }
      return { station, departures: departures.sort((a, b) => a.scheduled.localeCompare(b.scheduled)) };
    },
  };
}
export function createMockBikes() {
  return {
    mode: 'mock',
    async stations() {
      const rnd = seed('bikes' + Math.floor(minute() / 2));
      return hudson.bikes.mockStations.map((s) => {
        const bikes = Math.floor(rnd() * s.capacity * 0.8), ebikes = Math.min(bikes, Math.floor(rnd() * 6));
        return { ...s, bikes, ebikes, docks: Math.max(0, s.capacity - bikes - Math.floor(rnd() * 3)), renting: true, returning: rnd() > 0.05, updated: new Date(Date.now() - Math.floor(rnd() * 120) * 1000).toISOString() };
      });
    },
  };
}
export function createMockPassio() {
  return {
    mode: 'mock',
    async status(system) {
      const rnd = seed('shuttle' + system.id + minute());
      const hour = new Date().getHours(), weekday = new Date().getDay() % 6 !== 0;
      const running = weekday && hour >= 7 && hour < 20;
      const routes = system.routes.filter((r) => !/Senior/.test(r));
      const vehicles = running ? routes.map((r, i) => ({ id: String(100 + i), route: r, lat: system.lat + (rnd() - 0.5) * 0.02, lon: system.lon + (rnd() - 0.5) * 0.02, lastStop: ['Hoboken Terminal', 'Washington & 4th', '14th St Ferry', 'Harmon Cove', 'Secaucus Junction'][Math.floor(rnd() * 5)], updated: new Date(Date.now() - Math.floor(rnd() * 90) * 1000).toISOString() })) : [];
      return { system: system.id, name: system.name, live: false, vehicles, routes };
    },
  };
}
const ROAD_STATES = ['Normal', 'Normal', 'Normal', 'Heavy', 'Delays', 'Normal', 'Incident'];
export function createMockRoads() {
  return {
    mode: 'mock',
    async status() {
      const rnd = seed('roads' + Math.floor(minute() / 5));
      return hudson.roads.crossings.map((c) => {
        const state = ROAD_STATES[Math.floor(rnd() * ROAD_STATES.length)];
        const inbound = state === 'Normal' ? 5 + Math.floor(rnd() * 10) : 15 + Math.floor(rnd() * 35);
        return { ...c, state, inboundMin: /Tunnel|Bridge/.test(c.name) ? inbound : null, note: state === 'Incident' ? 'Disabled vehicle, one lane blocked' : state === 'Delays' ? 'Volume delays at the toll plaza' : null, updated: new Date().toISOString(), source: 'mock' };
      });
    },
  };
}
export function createMockWeather() {
  return {
    mode: 'mock',
    async now() {
      const rnd = seed('wx' + Math.floor(minute() / 30));
      const rain = rnd() > 0.6;
      return { tempF: 58 + Math.floor(rnd() * 20), short: rain ? 'Rain likely' : 'Partly cloudy', windMph: 6 + Math.floor(rnd() * 18), windDir: 'NW', precipPct: rain ? 70 : 10, rainAt: rain ? new Date(Date.now() + 2 * 3600 * 1000).toISOString() : null, source: 'mock' };
    },
  };
}
````

## `lib/gtfs.js`

````javascript
// Minimal GTFS static reader with no dependencies: reads a local .zip (stored or deflated entries),
// parses stops/routes/trips/stop_times/calendar(_dates), and answers "next departures at stop X".
// Used for NY Waterway today and for NJ Transit's HBLR rail_data.zip once credentials are live.

import fs from 'node:fs';
import zlib from 'node:zlib';

function readZip(buf) {
  const files = new Map();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  while (count-- > 0) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    files.set(name.replace(/^.*\//, ''), method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  const keys = head.map((k) => k.replace(/^﻿/, '').trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const toSec = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function loadGtfs(zipPath) {
  const files = readZip(fs.readFileSync(zipPath));
  const table = (n) => (files.has(n) ? parseCsv(files.get(n).toString('utf8')) : []);
  const stops = new Map(table('stops.txt').map((s) => [s.stop_id, s]));
  const routes = new Map(table('routes.txt').map((r) => [r.route_id, r]));
  const trips = new Map(table('trips.txt').map((t) => [t.trip_id, t]));
  const calendar = new Map(table('calendar.txt').map((c) => [c.service_id, c]));
  const calDates = new Map();
  for (const cd of table('calendar_dates.txt')) {
    if (!calDates.has(cd.service_id)) calDates.set(cd.service_id, new Map());
    calDates.get(cd.service_id).set(cd.date, cd.exception_type);
  }
  const byStop = new Map();
  for (const st of table('stop_times.txt')) {
    if (!byStop.has(st.stop_id)) byStop.set(st.stop_id, []);
    byStop.get(st.stop_id).push({ trip: st.trip_id, dep: toSec(st.departure_time || st.arrival_time), seq: Number(st.stop_sequence), pickup: st.pickup_type });
  }
  for (const list of byStop.values()) list.sort((a, b) => a.dep - b.dep);

  function serviceRuns(serviceId, date) {
    const ex = calDates.get(serviceId)?.get(ymd(date));
    if (ex === '2') return false;
    if (ex === '1') return true;
    const c = calendar.get(serviceId);
    if (!c) return false;
    const d = ymd(date);
    return d >= c.start_date && d <= c.end_date && c[DOW[date.getDay()]] === '1';
  }

  return {
    stops, routes,
    findStops: (re) => [...stops.values()].filter((s) => re.test(s.stop_name)),
    /** Next departures at a stop over the coming `horizonMin` minutes (handles trips after midnight). */
    departures(stopId, now = new Date(), horizonMin = 120) {
      const out = [];
      for (const dayOffset of [-1, 0]) {
        const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + dayOffset);
        const nowSec = (now - day) / 1000;
        for (const st of byStop.get(stopId) || []) {
          if (st.pickup === '1') continue;
          const diff = st.dep - nowSec;
          if (diff < -60 || diff > horizonMin * 60) continue;
          const trip = trips.get(st.trip); if (!trip || !serviceRuns(trip.service_id, day)) continue;
          const route = routes.get(trip.route_id) || {};
          out.push({
            tripId: st.trip, route: route.route_short_name || route.route_long_name || trip.route_id,
            routeName: route.route_long_name || '', destination: trip.trip_headsign || route.route_long_name || '',
            direction: trip.direction_id, scheduled: new Date(day.getTime() + st.dep * 1000).toISOString(),
            status: 'SCHEDULED', source: 'schedule',
          });
        }
      }
      return out.sort((a, b) => a.scheduled.localeCompare(b.scheduled));
    },
  };
}
````

## `lib/ferry.js`

````javascript
// NY Waterway adapter. Reads a downloaded GTFS zip (NYWW_GTFS_PATH) and matches each Hudson County
// terminal to a GTFS stop by gtfsStopId, falling back to a name match.
import { loadGtfs } from './gtfs.js';
import hudson from '../data/hudson.json' with { type: 'json' };

export function createFerryClient({ gtfsPath }) {
  const gtfs = loadGtfs(gtfsPath);
  const resolve = (terminal) => {
    if (terminal.gtfsStopId && gtfs.stops.has(terminal.gtfsStopId)) return terminal.gtfsStopId;
    const key = terminal.name.split(/[\/(]/)[0].trim().replace(/ Street$/, '');
    return gtfs.findStops(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))[0]?.stop_id || null;
  };
  return {
    mode: 'schedule',
    async departures(terminalId) {
      const t = hudson.ferry.terminals.find((x) => x.id === terminalId);
      if (!t) throw new Error('unknown terminal');
      const stopId = resolve(t);
      if (!stopId) return { terminal: terminalId, terminalName: t.name, departures: [], message: 'terminal not found in GTFS feed' };
      return { terminal: terminalId, terminalName: t.name, gtfsStopId: stopId, departures: gtfs.departures(stopId).slice(0, 12) };
    },
  };
}
````

## `lib/path.js`

````javascript
// PATH real-time arrivals from the Port Authority's RidePATH feed (public, no key, ~15 s refresh).
// Shape (reverse-engineered by the community): { results: [ { consideredStation: "HOB",
//   destinations: [ { label: "ToNY"|"ToNJ", messages: [ { target, secondsToArrival, arrivalTimeMessage,
//   lineColor, headSign, lastUpdated } ] } ] } ] }
const FEED = process.env.PATH_FEED_URL || 'https://www.panynj.gov/bin/portauthority/ridepath.json';

export function createPathClient() {
  return {
    mode: 'live',
    async departures(station) {
      const res = await fetch(FEED, { headers: { 'user-agent': 'hudpost-transit/0.1' } });
      if (!res.ok) throw new Error(`ridepath.json -> HTTP ${res.status}`);
      const json = await res.json();
      const st = (json.results || []).find((r) => r.consideredStation === station);
      if (!st) return { station, departures: [], message: 'station not in feed' };
      const departures = [];
      for (const dest of st.destinations || []) {
        for (const m of dest.messages || []) {
          const secs = Number(m.secondsToArrival);
          const est = Number.isFinite(secs) ? new Date(Date.now() + secs * 1000).toISOString() : null;
          departures.push({
            destination: m.headSign || m.target || dest.label, direction: dest.label === 'ToNY' ? 'To New York' : 'To New Jersey',
            scheduled: est, etaText: m.arrivalTimeMessage || null, lineColor: (m.lineColor || '').split(',')[0] || null,
            status: /delay/i.test(m.arrivalTimeMessage || '') ? 'DELAYED' : 'ON TIME', delayMin: 0, source: 'live',
            lastUpdated: m.lastUpdated || null,
          });
        }
      }
      departures.sort((a, b) => String(a.scheduled || '9').localeCompare(String(b.scheduled || '9')));
      return { station, departures };
    },
  };
}
````

## `lib/bikes.js`

````javascript
// Citi Bike (Jersey City + Hoboken) via GBFS. Public, no key. station_information changes rarely
// (cache long); station_status is the live part.
import hudson from '../data/hudson.json' with { type: 'json' };

const ROOT = process.env.GBFS_URL || 'https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json';
const inBox = (s, b) => s.lat >= b.minLat && s.lat <= b.maxLat && s.lon >= b.minLon && s.lon <= b.maxLon;

export function createBikesClient() {
  let feeds = null, info = null, infoAt = 0;
  async function getJson(url) { const r = await fetch(url, { headers: { 'user-agent': 'hudpost-transit/0.1' } }); if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json(); }
  async function discover() {
    if (feeds) return feeds;
    const root = await getJson(ROOT);
    const lang = root.data.en || Object.values(root.data)[0];
    feeds = Object.fromEntries(lang.feeds.map((f) => [f.name, f.url]));
    return feeds;
  }
  async function stationInfo() {
    if (info && Date.now() - infoAt < 6 * 3600 * 1000) return info;
    const f = await discover();
    const j = await getJson(f.station_information);
    info = new Map(j.data.stations.filter((s) => inBox(s, hudson.bikes.bbox)).map((s) => [s.station_id, { id: s.station_id, name: s.name, lat: s.lat, lon: s.lon, capacity: s.capacity }]));
    infoAt = Date.now();
    return info;
  }
  return {
    mode: 'live',
    async stations() {
      const [inf, f] = [await stationInfo(), await discover()];
      const st = await getJson(f.station_status);
      const out = [];
      for (const s of st.data.stations) {
        const i = inf.get(s.station_id); if (!i) continue;
        const types = Object.fromEntries((s.vehicle_types_available || []).map((v) => [v.vehicle_type_id, v.count]));
        const ebikes = s.num_ebikes_available ?? Object.entries(types).filter(([k]) => /ebike|electric|2/i.test(k)).reduce((a, [, c]) => a + c, 0);
        out.push({ ...i, bikes: s.num_bikes_available, ebikes, docks: s.num_docks_available, renting: s.is_renting !== 0 && s.is_renting !== false, returning: s.is_returning !== 0 && s.is_returning !== false, updated: s.last_reported ? new Date(s.last_reported * 1000).toISOString() : null });
      }
      return out;
    },
  };
}
````

## `lib/passio.js`

````javascript
// Passio GO (Hoboken Hop, Secaucus XChange). Unofficial JSON API used by the operators' own web maps.
// Endpoints (per athuler/PassioGo): POST https://passiogo.com/mapGetData.php?getRoutes=1|getStops=2|getBuses=1
// with form body json={"s0":"<systemId>","sA":1}. The systemId is visible in each operator's passiogo page.
const BASE = 'https://passiogo.com/mapGetData.php';

async function call(query, systemId) {
  const body = new URLSearchParams({ json: JSON.stringify({ s0: String(systemId), sA: 1 }) });
  const r = await fetch(`${BASE}?${query}`, { method: 'POST', body, headers: { 'user-agent': 'hudpost-transit/0.1' } });
  if (!r.ok) throw new Error(`passio ${query} -> HTTP ${r.status}`);
  return r.json();
}

export function createPassioClient() {
  return {
    mode: 'live',
    /** Live vehicles for one system: how many shuttles are out per route and where they last were. */
    async status(system) {
      if (!system.passioSystemId) throw new Error(`${system.name}: passioSystemId not configured`);
      const [routes, buses] = await Promise.all([call('getRoutes=1', system.passioSystemId), call('getBuses=1', system.passioSystemId)]);
      const routeName = new Map((Array.isArray(routes) ? routes : Object.values(routes)).map((r) => [String(r.myid || r.id), r.name || r.nameOrig]));
      const list = Object.values(buses.buses || {}).flat();
      const vehicles = list.map((b) => ({ id: b.busId || b.bus, route: routeName.get(String(b.routeId)) || b.route || 'Route', lat: Number(b.latitude), lon: Number(b.longitude), lastStop: b.stopName || null, updated: b.created || null }));
      return { system: system.id, name: system.name, live: true, vehicles, routes: [...routeName.values()] };
    },
  };
}
````

## `lib/weather.js`

````javascript
// National Weather Service hourly forecast: public, no key. Two calls, both cached upstream.
const UA = { 'user-agent': 'hudpost-transit/0.1 (transit page; contact via hudpost.com)', accept: 'application/geo+json' };
export function createWeatherClient({ lat, lon }) {
  let hourlyUrl = null;
  return {
    mode: 'live',
    async now() {
      if (!hourlyUrl) {
        const p = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: UA });
        if (!p.ok) throw new Error(`nws points -> HTTP ${p.status}`);
        hourlyUrl = (await p.json()).properties.forecastHourly;
      }
      const f = await fetch(hourlyUrl, { headers: UA });
      if (!f.ok) throw new Error(`nws hourly -> HTTP ${f.status}`);
      const periods = (await f.json()).properties.periods.slice(0, 6);
      const now = periods[0];
      const rainSoon = periods.find((x) => (x.probabilityOfPrecipitation?.value || 0) >= 50);
      return {
        tempF: now.temperature, short: now.shortForecast, windMph: Number(String(now.windSpeed).match(/\d+/)?.[0] || 0), windDir: now.windDirection,
        precipPct: now.probabilityOfPrecipitation?.value || 0,
        rainAt: rainSoon ? rainSoon.startTime : null, source: 'live',
      };
    },
  };
}
````

## `data/hudson.json`

````json
{
  "county": "Hudson",
  "rail": {
    "note": "NJ Transit commuter rail stations physically in Hudson County. Codes are NJ Transit STATION_2CHAR values used by the TrainData API.",
    "stations": [
      {
        "code": "HB",
        "name": "Hoboken Terminal",
        "town": "Hoboken",
        "lines": [
          "Main/Bergen",
          "Pascack Valley",
          "Morris & Essex",
          "Montclair-Boonton",
          "Raritan Valley (select)"
        ],
        "lat": 40.7349,
        "lon": -74.0275
      },
      {
        "code": "SE",
        "name": "Secaucus Junction (Upper Level)",
        "town": "Secaucus",
        "lines": [
          "Northeast Corridor",
          "North Jersey Coast",
          "Raritan Valley",
          "Morris & Essex",
          "Montclair-Boonton"
        ],
        "lat": 40.7613,
        "lon": -74.0758
      },
      {
        "code": "TS",
        "name": "Secaucus Junction (Lower Level)",
        "town": "Secaucus",
        "lines": [
          "Main/Bergen",
          "Pascack Valley",
          "Port Jervis",
          "Meadowlands"
        ],
        "lat": 40.7613,
        "lon": -74.0758
      }
    ]
  },
  "lightRail": {
    "note": "Hudson-Bergen Light Rail (HBLR). Every HBLR station is in Hudson County. IDs are our own slugs; map to GTFS stop_id once the static feed is loaded.",
    "branches": [
      "Bayonne Flyer",
      "8th Street – Hoboken",
      "West Side – Tonnelle",
      "Hoboken – Tonnelle"
    ],
    "stations": [
      {
        "id": "8th-street",
        "name": "8th Street",
        "town": "Bayonne",
        "lat": 40.66,
        "lon": -74.1041
      },
      {
        "id": "22nd-street",
        "name": "22nd Street",
        "town": "Bayonne",
        "lat": 40.6716,
        "lon": -74.0968
      },
      {
        "id": "34th-street",
        "name": "34th Street",
        "town": "Bayonne",
        "lat": 40.6815,
        "lon": -74.09
      },
      {
        "id": "45th-street",
        "name": "45th Street",
        "town": "Bayonne",
        "lat": 40.6899,
        "lon": -74.0865
      },
      {
        "id": "danforth-avenue",
        "name": "Danforth Avenue",
        "town": "Jersey City",
        "lat": 40.6977,
        "lon": -74.0868
      },
      {
        "id": "richard-street",
        "name": "Richard Street",
        "town": "Jersey City",
        "lat": 40.7051,
        "lon": -74.0838
      },
      {
        "id": "liberty-state-park",
        "name": "Liberty State Park",
        "town": "Jersey City",
        "lat": 40.7096,
        "lon": -74.0603
      },
      {
        "id": "jersey-avenue",
        "name": "Jersey Avenue",
        "town": "Jersey City",
        "lat": 40.717,
        "lon": -74.049
      },
      {
        "id": "marin-boulevard",
        "name": "Marin Boulevard",
        "town": "Jersey City",
        "lat": 40.718,
        "lon": -74.0416
      },
      {
        "id": "essex-street",
        "name": "Essex Street",
        "town": "Jersey City",
        "lat": 40.7162,
        "lon": -74.036
      },
      {
        "id": "exchange-place",
        "name": "Exchange Place",
        "town": "Jersey City",
        "lat": 40.7165,
        "lon": -74.0328
      },
      {
        "id": "harborside",
        "name": "Harborside",
        "town": "Jersey City",
        "lat": 40.7185,
        "lon": -74.033
      },
      {
        "id": "harsimus-cove",
        "name": "Harsimus Cove",
        "town": "Jersey City",
        "lat": 40.7215,
        "lon": -74.0341
      },
      {
        "id": "newport",
        "name": "Newport",
        "town": "Jersey City",
        "lat": 40.7268,
        "lon": -74.0338
      },
      {
        "id": "west-side-avenue",
        "name": "West Side Avenue",
        "town": "Jersey City",
        "lat": 40.7136,
        "lon": -74.0868
      },
      {
        "id": "mlk-drive",
        "name": "Martin Luther King Drive",
        "town": "Jersey City",
        "lat": 40.71,
        "lon": -74.079
      },
      {
        "id": "garfield-avenue",
        "name": "Garfield Avenue",
        "town": "Jersey City",
        "lat": 40.708,
        "lon": -74.07
      },
      {
        "id": "hoboken-terminal",
        "name": "Hoboken Terminal",
        "town": "Hoboken",
        "lat": 40.7352,
        "lon": -74.029
      },
      {
        "id": "2nd-street",
        "name": "2nd Street",
        "town": "Hoboken",
        "lat": 40.7377,
        "lon": -74.033
      },
      {
        "id": "9th-street-congress",
        "name": "9th Street – Congress Street",
        "town": "Hoboken",
        "lat": 40.7446,
        "lon": -74.0357
      },
      {
        "id": "lincoln-harbor",
        "name": "Lincoln Harbor",
        "town": "Weehawken",
        "lat": 40.758,
        "lon": -74.027
      },
      {
        "id": "port-imperial",
        "name": "Port Imperial",
        "town": "Weehawken",
        "lat": 40.7705,
        "lon": -74.013
      },
      {
        "id": "bergenline-avenue",
        "name": "Bergenline Avenue",
        "town": "Union City",
        "lat": 40.7745,
        "lon": -74.0195
      },
      {
        "id": "tonnelle-avenue",
        "name": "Tonnelle Avenue",
        "town": "North Bergen",
        "lat": 40.7815,
        "lon": -74.029
      }
    ]
  },
  "bus": {
    "note": "Major Hudson County bus hubs. stopId is the NJ Transit 5-digit stop code the BUSDV2 getBusDV endpoint expects. null means it still has to be confirmed against the GTFS stops.txt (stop_code column) once credentials are live.",
    "hubs": [
      {
        "id": "journal-square",
        "name": "Journal Square Transportation Center",
        "town": "Jersey City",
        "stopId": null,
        "routes": [
          "1",
          "2",
          "6",
          "10",
          "80",
          "82",
          "83",
          "84",
          "85",
          "86",
          "87",
          "88",
          "119",
          "123",
          "125"
        ],
        "lat": 40.7332,
        "lon": -74.0629
      },
      {
        "id": "hoboken-terminal",
        "name": "Hoboken Terminal",
        "town": "Hoboken",
        "stopId": null,
        "routes": [
          "22",
          "23",
          "63",
          "64",
          "68",
          "85",
          "87",
          "89",
          "126"
        ],
        "lat": 40.735,
        "lon": -74.028
      },
      {
        "id": "exchange-place",
        "name": "Exchange Place",
        "town": "Jersey City",
        "stopId": null,
        "routes": [
          "80",
          "81",
          "119"
        ],
        "lat": 40.7165,
        "lon": -74.0335
      },
      {
        "id": "bergenline-32nd",
        "name": "Bergenline Ave & 32nd St",
        "town": "Union City",
        "stopId": null,
        "routes": [
          "22",
          "84",
          "86",
          "88",
          "89",
          "154",
          "156",
          "159",
          "165",
          "166",
          "168",
          "181"
        ],
        "lat": 40.7717,
        "lon": -74.0275
      },
      {
        "id": "bayonne-32nd",
        "name": "Broadway & 32nd St",
        "town": "Bayonne",
        "stopId": null,
        "routes": [
          "10",
          "81",
          "119",
          "120"
        ],
        "lat": 40.679,
        "lon": -74.108
      },
      {
        "id": "north-bergen-park-ride",
        "name": "North Bergen Park & Ride",
        "town": "North Bergen",
        "stopId": null,
        "routes": [
          "120",
          "121",
          "127",
          "128",
          "154",
          "165",
          "166",
          "168",
          "320"
        ],
        "lat": 40.796,
        "lon": -74.042
      }
    ],
    "routeNames": {
      "1": "Newark – Jersey City",
      "2": "Journal Square – Secaucus",
      "6": "Journal Square – Hoboken",
      "10": "Bayonne – Journal Square",
      "22": "Hoboken – North Bergen",
      "23": "Hoboken – Newark",
      "63": "Hoboken – Journal Square",
      "64": "Hoboken – Weehawken",
      "68": "Hoboken – Journal Square",
      "80": "Exchange Place – Journal Square",
      "81": "Bayonne – Exchange Place",
      "82": "Journal Square – Hoboken",
      "83": "Journal Square – Hoboken",
      "84": "Journal Square – Bergenline",
      "85": "Journal Square – Hoboken",
      "86": "Union City – Journal Square",
      "87": "Hoboken – Journal Square",
      "88": "Journal Square – Union City",
      "89": "Hoboken – Union City",
      "119": "Bayonne – New York",
      "120": "Bayonne – New York",
      "121": "North Bergen – New York",
      "123": "Jersey City – New York",
      "125": "Jersey City – New York",
      "126": "Hoboken – New York",
      "127": "North Bergen – New York",
      "128": "North Bergen – New York",
      "154": "Fort Lee – New York",
      "156": "Fort Lee – New York",
      "159": "Fort Lee – New York",
      "165": "Westwood – New York",
      "166": "Englewood – New York",
      "168": "Paramus – New York",
      "181": "Guttenberg – New York",
      "320": "Meadowlands – New York"
    }
  },
  "notes": "All coordinates are approximate (station centroids) and only used to sort 'nearby'. Refine from GTFS stops.txt.",
  "ferry": {
    "note": "NY Waterway terminals in Hudson County. Not an NJ Transit product: timetables come from NY Waterway's public GTFS (nywaterway.connexionz.net/rtt/public/resource/gtfs.zip); GTFS-RT exists as protobuf. gtfsStopId is filled in once the feed is loaded.",
    "terminals": [
      {
        "id": "hoboken-njt",
        "name": "Hoboken / NJ Transit Terminal",
        "town": "Hoboken",
        "lat": 40.7358,
        "lon": -74.0263,
        "gtfsStopId": null,
        "routes": [
          "Brookfield Place",
          "Midtown / W 39th St"
        ]
      },
      {
        "id": "hoboken-14th",
        "name": "Hoboken 14th Street",
        "town": "Hoboken",
        "lat": 40.753,
        "lon": -74.025,
        "gtfsStopId": null,
        "routes": [
          "Midtown / W 39th St",
          "Brookfield Place",
          "Pier 11 / Wall St"
        ]
      },
      {
        "id": "port-imperial",
        "name": "Port Imperial / Weehawken",
        "town": "Weehawken",
        "lat": 40.771,
        "lon": -74.011,
        "gtfsStopId": null,
        "routes": [
          "Midtown / W 39th St",
          "Brookfield Place",
          "Pier 11 / Wall St"
        ]
      },
      {
        "id": "lincoln-harbor",
        "name": "Lincoln Harbor",
        "town": "Weehawken",
        "lat": 40.76,
        "lon": -74.025,
        "gtfsStopId": null,
        "routes": [
          "Midtown / W 39th St"
        ]
      },
      {
        "id": "paulus-hook",
        "name": "Paulus Hook",
        "town": "Jersey City",
        "lat": 40.7135,
        "lon": -74.0325,
        "gtfsStopId": null,
        "routes": [
          "Brookfield Place",
          "Pier 11 / Wall St",
          "Midtown / W 39th St"
        ]
      },
      {
        "id": "liberty-harbor",
        "name": "Liberty Harbor / Marin Blvd",
        "town": "Jersey City",
        "lat": 40.7118,
        "lon": -74.0386,
        "gtfsStopId": null,
        "routes": [
          "Pier 11 / Wall St",
          "Brookfield Place (via Paulus Hook)"
        ]
      },
      {
        "id": "port-liberte",
        "name": "Port Liberté",
        "town": "Jersey City",
        "lat": 40.687,
        "lon": -74.049,
        "gtfsStopId": null,
        "routes": [
          "Pier 11 / Wall St"
        ]
      }
    ]
  },
  "nyc": {
    "note": "'To Manhattan' view: for each Hudson County area, the boards that carry NYC-bound service across NJ Transit rail, PATH, bus and ferry.",
    "areas": [
      {
        "id": "hoboken",
        "name": "Hoboken",
        "rail": [],
        "bus": [
          "hoboken-terminal"
        ],
        "ferry": [
          "hoboken-njt",
          "hoboken-14th"
        ],
        "path": [
          "HOB"
        ]
      },
      {
        "id": "secaucus",
        "name": "Secaucus",
        "rail": [
          "SE"
        ],
        "bus": [],
        "ferry": [],
        "path": []
      },
      {
        "id": "jc-waterfront",
        "name": "Jersey City waterfront",
        "rail": [],
        "bus": [],
        "ferry": [
          "paulus-hook"
        ],
        "path": [
          "EXP",
          "NEW",
          "GRV"
        ]
      },
      {
        "id": "journal-square",
        "name": "Journal Square",
        "rail": [],
        "bus": [
          "journal-square"
        ],
        "ferry": [],
        "path": [
          "JSQ"
        ]
      },
      {
        "id": "weehawken",
        "name": "Weehawken",
        "rail": [],
        "bus": [],
        "ferry": [
          "port-imperial",
          "lincoln-harbor"
        ],
        "path": []
      },
      {
        "id": "union-city",
        "name": "Union City / Bergenline",
        "rail": [],
        "bus": [
          "bergenline-32nd"
        ],
        "ferry": [],
        "path": []
      },
      {
        "id": "north-bergen",
        "name": "North Bergen",
        "rail": [],
        "bus": [
          "north-bergen-park-ride"
        ],
        "ferry": [],
        "path": []
      },
      {
        "id": "bayonne",
        "name": "Bayonne",
        "rail": [],
        "bus": [
          "bayonne-32nd"
        ],
        "ferry": [
          "port-liberte"
        ],
        "path": []
      },
      {
        "id": "harrison",
        "name": "Harrison",
        "rail": [],
        "bus": [],
        "ferry": [],
        "path": [
          "HAR"
        ]
      }
    ]
  },
  "path": {
    "note": "PATH (Port Authority) stations in Hudson County. Codes are the RidePATH feed's consideredStation values. Real-time source: https://www.panynj.gov/bin/portauthority/ridepath.json (public, no key, refreshes ~15 s).",
    "stations": [
      {
        "id": "JSQ",
        "name": "Journal Square",
        "town": "Jersey City",
        "lat": 40.7325,
        "lon": -74.063,
        "lines": [
          "JSQ–33 St",
          "NWK–WTC",
          "JSQ–33 via HOB (nights/weekends)"
        ]
      },
      {
        "id": "GRV",
        "name": "Grove Street",
        "town": "Jersey City",
        "lat": 40.7196,
        "lon": -74.0434,
        "lines": [
          "JSQ–33 St",
          "NWK–WTC"
        ]
      },
      {
        "id": "EXP",
        "name": "Exchange Place",
        "town": "Jersey City",
        "lat": 40.7163,
        "lon": -74.0329,
        "lines": [
          "NWK–WTC",
          "HOB–WTC"
        ]
      },
      {
        "id": "NEW",
        "name": "Newport",
        "town": "Jersey City",
        "lat": 40.7268,
        "lon": -74.0338,
        "lines": [
          "JSQ–33 St",
          "HOB–33 St"
        ]
      },
      {
        "id": "HOB",
        "name": "Hoboken",
        "town": "Hoboken",
        "lat": 40.7355,
        "lon": -74.0279,
        "lines": [
          "HOB–33 St",
          "HOB–WTC"
        ]
      },
      {
        "id": "HAR",
        "name": "Harrison",
        "town": "Harrison",
        "lat": 40.7386,
        "lon": -74.1555,
        "lines": [
          "NWK–WTC"
        ]
      }
    ]
  },
  "bikes": {
    "note": "Citi Bike covers Jersey City and Hoboken. Feed: GBFS at https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json (station_information + station_status, public, no key). We keep stations inside the Hudson County bounding box.",
    "bbox": {
      "minLat": 40.64,
      "maxLat": 40.81,
      "minLon": -74.17,
      "maxLon": -74.0
    },
    "mockStations": [
      {
        "id": "JC001",
        "name": "Grove St PATH",
        "lat": 40.7196,
        "lon": -74.0434,
        "capacity": 38
      },
      {
        "id": "JC002",
        "name": "Newport PATH",
        "lat": 40.7273,
        "lon": -74.0338,
        "capacity": 30
      },
      {
        "id": "JC003",
        "name": "Exchange Place",
        "lat": 40.7163,
        "lon": -74.0329,
        "capacity": 27
      },
      {
        "id": "HB001",
        "name": "Hoboken Terminal – River St & Hudson Pl",
        "lat": 40.7359,
        "lon": -74.0303,
        "capacity": 40
      },
      {
        "id": "HB002",
        "name": "14 St Ferry – 14 St & Shipyard Ln",
        "lat": 40.753,
        "lon": -74.0248,
        "capacity": 25
      },
      {
        "id": "JC004",
        "name": "Journal Square",
        "lat": 40.7333,
        "lon": -74.0627,
        "capacity": 35
      },
      {
        "id": "JC005",
        "name": "Hamilton Park",
        "lat": 40.7273,
        "lon": -74.0443,
        "capacity": 24
      },
      {
        "id": "JC006",
        "name": "Liberty Light Rail",
        "lat": 40.7113,
        "lon": -74.0556,
        "capacity": 19
      },
      {
        "id": "JC007",
        "name": "Marin Light Rail",
        "lat": 40.7145,
        "lon": -74.0428,
        "capacity": 31
      },
      {
        "id": "HB003",
        "name": "Church Sq Park – 5 St & Park Ave",
        "lat": 40.7423,
        "lon": -74.0326,
        "capacity": 21
      }
    ]
  },
  "shuttles": {
    "note": "Free municipal shuttles. Both run on Passio GO, which has an unofficial public JSON API (passiogo.com/mapGetData.php); systemId must be read from hoboken.passiogo.com / uc.passiogo.com and filled in. Hours are from the operators' pages and should be re-verified each season.",
    "systems": [
      {
        "id": "hop",
        "name": "The Hop (Hoboken)",
        "town": "Hoboken",
        "lat": 40.7355,
        "lon": -74.0279,
        "passioSystemId": null,
        "passioHost": "hoboken.passiogo.com",
        "fare": "Free",
        "hours": "Three routes weekdays 7:30 am – 7:30 pm; departures from Hoboken Terminal at :00 and :30",
        "routes": [
          "Hop 1",
          "Hop 2",
          "Hop 3",
          "Senior Shuttle (Mon–Fri 8 am – 4 pm)"
        ],
        "tips": "Flag it down at any intersection. Construction near Hoboken Terminal is detouring routes in 2026.",
        "url": "https://www.hobokennj.gov/resources/the-hop"
      },
      {
        "id": "secaucus-xchange",
        "name": "XChange Shuttle (Secaucus Junction)",
        "town": "Secaucus",
        "lat": 40.7613,
        "lon": -74.0758,
        "passioSystemId": null,
        "passioHost": "uc.passiogo.com",
        "fare": "Free",
        "hours": "Peak hours, weekdays",
        "routes": [
          "Secaucus Junction ↔ XChange / Harmon Cove"
        ],
        "tips": "Meets NJ Transit trains at the Junction.",
        "url": "https://uc.passiogo.com/"
      }
    ]
  },
  "roads": {
    "note": "Hudson River crossings and the county's chokepoints. Live status needs a 511NJ developer account (511nj.org) or the Port Authority's crossing feeds; until then this is mock. Order = most-asked first.",
    "crossings": [
      {
        "id": "holland",
        "name": "Holland Tunnel",
        "from": "Jersey City",
        "to": "Canal St, Manhattan",
        "operator": "PANYNJ"
      },
      {
        "id": "lincoln",
        "name": "Lincoln Tunnel",
        "from": "Weehawken",
        "to": "W 39th St, Manhattan",
        "operator": "PANYNJ"
      },
      {
        "id": "pulaski",
        "name": "Pulaski Skyway (US 1/9)",
        "from": "Jersey City",
        "to": "Newark",
        "operator": "NJDOT"
      },
      {
        "id": "tpk-ext",
        "name": "NJ Turnpike Hudson County Extension (I-78)",
        "from": "Bayonne / Jersey City",
        "to": "Newark Bay Bridge",
        "operator": "NJTA"
      },
      {
        "id": "bayonne-bridge",
        "name": "Bayonne Bridge",
        "from": "Bayonne",
        "to": "Staten Island",
        "operator": "PANYNJ"
      },
      {
        "id": "rt-139",
        "name": "Route 139 / 14th St Viaduct",
        "from": "Jersey City",
        "to": "Holland Tunnel approach",
        "operator": "NJDOT"
      }
    ]
  },
  "other": {
    "note": "Services readers ask about that have no machine-readable feed we can reach. Static, linked, and labeled 'no live data'.",
    "services": [
      {
        "name": "Via Jersey City",
        "kind": "On-demand shared rides",
        "area": "Jersey City",
        "cost": "$2 per ride; free to/from Port Liberté ferry",
        "hours": "Book in the Via Jersey City app or 201-514-6637",
        "status": "City proposed cutting the service in May 2026 — confirm it is still running",
        "url": "https://city.ridewithvia.com/jersey-city"
      },
      {
        "name": "Liberty Landing Ferry",
        "kind": "Ferry",
        "area": "Liberty Landing Marina & Warren St, Jersey City → Brookfield Place",
        "cost": "Paid; seasonal, about a dozen trips a day",
        "hours": "See operator",
        "status": "",
        "url": "https://www.libertylandingferry.com/"
      },
      {
        "name": "EZ Ride Harmon Meadow Shuttle (273)",
        "kind": "Free employer shuttle",
        "area": "Secaucus Junction ↔ Harmon Meadow / Osprey Cove",
        "cost": "Free",
        "hours": "Weekdays 7–10 am and 4–8 pm",
        "status": "",
        "url": "https://ezride.org/route/seacaucus-junction/"
      },
      {
        "name": "Secaucus Community Shuttle",
        "kind": "Town shuttle",
        "area": "Secaucus neighborhoods ↔ Secaucus Junction",
        "cost": "Free",
        "hours": "Weekday peak hours",
        "status": "",
        "url": "https://www.secaucusnj.net/transportation/bus.htm"
      },
      {
        "name": "Bergenline & Boulevard East jitneys",
        "kind": "Private minibuses",
        "area": "Union City, West New York, North Bergen ↔ Port Authority / Journal Square",
        "cost": "Cash, a few dollars",
        "hours": "Frequent, no schedule",
        "status": "No tracking; flag one down",
        "url": ""
      },
      {
        "name": "Hoboken Senior Shuttle",
        "kind": "Free shuttle for seniors",
        "area": "Hoboken",
        "cost": "Free",
        "hours": "Mon–Fri 8 am – 4 pm; Saturday shopping run 11 am – 4 pm",
        "status": "",
        "url": "https://www.hobokennj.gov/resources/senior-shuttle"
      },
      {
        "name": "NJ Transit Access Link",
        "kind": "ADA paratransit",
        "area": "Countywide, reservation only",
        "cost": "Comparable bus fare",
        "hours": "Book 1–7 days ahead",
        "status": "",
        "url": "https://www.njtransit.com/accessibility/access-link-ada-paratransit"
      },
      {
        "name": "Cape Liberty Cruise Port shuttles",
        "kind": "Private shuttles",
        "area": "Bayonne cruise terminal ↔ NYC airports / Manhattan",
        "cost": "Paid",
        "hours": "Sailing days",
        "status": "",
        "url": ""
      }
    ]
  },
  "weather": {
    "note": "National Weather Service, public, no key: https://api.weather.gov/points/{lat},{lon} → forecastHourly. Used for a one-line bike/ferry conditions hint.",
    "lat": 40.744,
    "lon": -74.0324
  }
}
````

## `public/index.html`

````html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hudson County Transit</title>
  <meta name="description" content="Next departures for every NJ Transit rail, light rail, bus and NY Waterway ferry stop in Hudson County, with delays and tracks shown up front.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="topbar">
    <div class="wrap topbar__row">
      <div class="topbar__title">Hudson County Transit</div>
      <div class="wx" id="wx" title="National Weather Service, Hoboken"></div>
      <div class="fresh" id="fresh" role="status"><span class="dot" aria-hidden="true"></span><span id="fresh-text">Connecting…</span></div>
      <button class="btn" id="nearby-btn" type="button" title="Sort stops by distance from you">⌖ Nearby</button>
    </div>
    <div class="wrap">
      <input class="search" id="search" type="search" placeholder="Search a stop, station, route or town…" autocomplete="off" aria-label="Search stops">
    </div>
  </div>

  <main class="wrap">
    <div id="alerts" class="alerts" hidden></div>
    <div class="roads" id="roads" aria-label="Road crossings"></div>

    <section class="sec" id="sec-fav" aria-labelledby="h-fav">
      <div class="sec__head"><h2 id="h-fav">Your stops</h2><span class="hint">Starred stops load here first, no clicks.</span></div>
      <div class="cards" id="fav-cards"></div>
    </section>

    <section class="sec" id="sec-nyc" aria-labelledby="h-nyc">
      <div class="sec__head"><h2 id="h-nyc">To Manhattan</h2><span class="hint">Every NYC-bound train, bus and ferry from one area, soonest first.</span></div>
      <div class="chips" id="nyc-areas" role="group" aria-label="Area"></div>
      <div class="board" id="nyc-board" aria-live="polite"></div>
    </section>

    <section class="sec" id="sec-all" aria-labelledby="h-all">
      <div class="sec__head"><h2 id="h-all">All stops</h2><span class="hint" id="all-hint">Alphabetical. Tap Nearby to sort by distance.</span></div>
      <div class="tabs" role="tablist">
        <button class="tab is-active" role="tab" data-mode="rail">Rail</button>
        <button class="tab" role="tab" data-mode="lightrail">Light Rail</button>
        <button class="tab" role="tab" data-mode="bus">Bus</button>
        <button class="tab" role="tab" data-mode="path">PATH</button>
        <button class="tab" role="tab" data-mode="ferry">Ferry</button>
        <button class="tab" role="tab" data-mode="bikes">Citi Bike</button>
        <button class="tab" role="tab" data-mode="shuttles">Shuttles</button>
      </div>
      <div class="stoplist" id="stoplist"></div>
    </section>

    <section class="sec" id="sec-other" aria-labelledby="h-other">
      <div class="sec__head"><h2 id="h-other">Also in the county</h2><span class="hint">Services with no live feed. Hours and fares as published by the operator.</span></div>
      <div class="other" id="other"></div>
    </section>

    <p class="fine">Times come from NJ TRANSIT and NY Waterway feeds and can change. Rows marked <em>scheduled</em> are timetable only, not live. PATH times come from the Port Authority's RidePATH feed, Citi Bike counts from its public GBFS feed, road status from 511NJ when connected.</p>
  </main>

  <script src="/app.js" type="module"></script>
</body>
</html>
````

## `public/styles.css`

````css
/* Palette rule: grey scale for everything, --brand only when something needs attention
   (late, cancelled, stale, incident, alert) or is selected. Official NJ Transit / PATH line
   colors appear only as a 6px dot so riders can match station signage. No other hues.
   --brand is a placeholder until hudpost.com's real value is supplied. */
:root {
  --brand: #c8102e; --ink: #111214; --ink-2: #4a4d55; --ink-3: #8a8e98;
  --paper: #ffffff; --paper-2: #f5f5f3; --line: #e4e4e0;
  --bad: var(--brand);
  --sans: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --ink: #f2f2f0; --ink-2: #b9bcc4; --ink-3: #7e838e; --paper: #121316; --paper-2: #1b1c21; --line: #2a2c33; }
}
:root[data-theme="dark"] { --ink: #f2f2f0; --ink-2: #b9bcc4; --ink-3: #7e838e; --paper: #121316; --paper-2: #1b1c21; --line: #2a2c33; }

* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.45; font-size: 15px; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 16px; }
h2 { font-size: 20px; font-weight: 800; margin: 0; letter-spacing: -0.01em; }
button { font: inherit; }

/* Top bar */
.topbar { position: sticky; top: 0; z-index: 10; background: var(--paper); border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.topbar__row { display: flex; align-items: center; gap: 10px; height: 50px; }
.topbar__title { font-weight: 800; letter-spacing: -0.01em; flex: 1; white-space: nowrap; }
.fresh { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--ink-2); white-space: nowrap; }
.fresh .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); }
.fresh.is-live .dot { background: var(--ink); }
.fresh.is-mock .dot { background: transparent; border: 2px solid var(--ink-3); }
.fresh.is-stale .dot, .fresh.is-error .dot { background: var(--bad); }
.btn { appearance: none; border: 1px solid var(--line); background: var(--paper); color: var(--ink); border-radius: 999px; padding: 6px 12px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.btn.is-active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.search { width: 100%; font: inherit; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-2); color: var(--ink); }
.search:focus { outline: 2px solid var(--ink); outline-offset: 0; }

/* Sections */
.sec { margin-top: 26px; }
.sec__head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.hint { font-size: 13px; color: var(--ink-3); }
.alerts { margin-top: 14px; display: grid; gap: 8px; }
.alert { border-left: 4px solid var(--brand); background: color-mix(in srgb, var(--brand) 7%, var(--paper)); padding: 8px 12px; border-radius: 0 8px 8px 0; font-size: 13px; }
.alert small { color: var(--ink-3); margin-left: 6px; }
.fine { color: var(--ink-3); font-size: 12px; margin: 32px 0 40px; }

/* Cards (favorites) */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); overflow: hidden; display: flex; flex-direction: column; }
.card.is-stale { opacity: .75; }
.card__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.card__name { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card__foot { padding: 6px 12px; font-size: 11px; color: var(--ink-3); border-top: 1px dashed var(--line); background: var(--paper-2); display: flex; justify-content: space-between; gap: 8px; }
.card__foot .stale { color: var(--bad); font-weight: 700; }
.empty-fav { grid-column: 1 / -1; border: 1px dashed var(--line); border-radius: var(--radius); padding: 18px; color: var(--ink-2); font-size: 14px; }
.empty-fav .chips { margin-top: 10px; }

/* Mode pill & star */
.mode { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line); padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
.star { appearance: none; border: 0; background: none; cursor: pointer; font-size: 20px; line-height: 1; color: var(--ink-3); padding: 2px 4px; }
.star.is-on { color: var(--ink); }

/* Departure rows */
.board { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--paper); }
.row { display: grid; grid-template-columns: 74px 1fr auto; gap: 10px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--line); }
.card .row:first-child, .board .row:first-child { border-top: 0; }
.row__eta { font-variant-numeric: tabular-nums; font-weight: 800; font-size: 20px; line-height: 1; }
.row__eta small { display: block; font-size: 11px; font-weight: 500; color: var(--ink-3); margin-top: 3px; }
.row__eta small s { color: var(--ink-3); }
.row__eta small b { color: var(--bad); font-weight: 700; }
.row__main { min-width: 0; }
.row__dest { font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.row__sub { color: var(--ink-2); font-size: 12px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line { font-size: 11px; font-weight: 700; color: var(--ink-2); letter-spacing: .04em; display: inline-flex; align-items: center; gap: 4px; }
.line .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; border: 1px solid rgba(0,0,0,.15); }
.route { display: inline-grid; place-items: center; min-width: 40px; height: 26px; padding: 0 7px; border-radius: 6px; background: var(--ink); color: var(--paper); font-weight: 800; font-size: 13px; }
.row__right { text-align: right; display: grid; gap: 2px; }
.badge { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; }
.badge.ok { color: var(--ink-2); } .badge.warn { color: var(--ink); } .badge.bad { color: var(--bad); } .badge.sched { color: var(--ink-3); font-weight: 600; }
.track { font-size: 12px; color: var(--ink-2); font-weight: 600; }
.track.tba { color: var(--ink-3); font-weight: 400; }
.empty, .loading, .error { padding: 22px 12px; text-align: center; color: var(--ink-3); font-size: 14px; }
.error { color: var(--bad); }
.note { font-size: 12px; color: var(--ink-3); padding: 8px 12px; border-top: 1px dashed var(--line); background: var(--paper-2); }

/* Chips / tabs */
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.chip { appearance: none; font-size: 13px; font-weight: 600; border: 1px solid var(--line); background: var(--paper); color: var(--ink-2); border-radius: 999px; padding: 5px 11px; cursor: pointer; }
.chip.is-active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 10px; overflow-x: auto; }
.tab { appearance: none; background: none; border: 0; border-bottom: 3px solid transparent; margin-bottom: -1px; padding: 8px 12px; font-weight: 600; color: var(--ink-2); cursor: pointer; white-space: nowrap; }
.tab.is-active { color: var(--ink); border-color: var(--brand); }

/* All stops list (accordion) */
.stoplist { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.stop { border-top: 1px solid var(--line); }
.stop:first-child { border-top: 0; }
.stop__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
.stop__head:hover { background: var(--paper-2); }
.stop__name { flex: 1; font-weight: 600; min-width: 0; }
.stop__name small { display: block; font-weight: 400; color: var(--ink-3); font-size: 12px; }
.stop__dist { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.stop__body { border-top: 1px dashed var(--line); background: var(--paper-2); }
.stop__body .row { background: var(--paper); }

@media (max-width: 560px) {
  .row { grid-template-columns: 66px 1fr auto; padding: 8px 10px; }
  .row__eta { font-size: 18px; }
  .topbar__title { font-size: 14px; }
}

/* Weather hint */
.wx { font-size: 12px; font-weight: 600; color: var(--ink-2); white-space: nowrap; }
.wx b { color: var(--ink); font-weight: 800; }
.wx:empty { display: none; }

/* Road crossings strip */
.roads { display: flex; gap: 8px; overflow-x: auto; margin-top: 14px; padding-bottom: 4px; scrollbar-width: thin; }
.roads:empty { display: none; }
.road { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; min-width: 150px; font-size: 12px; background: var(--paper); }
.road__name { font-weight: 700; font-size: 13px; }
.road__state { font-weight: 800; text-transform: uppercase; letter-spacing: .03em; font-size: 11px; }
.road__state.ok { color: var(--ink-3); } .road__state.warn { color: var(--ink); } .road__state.bad { color: var(--bad); }
.road__note { color: var(--ink-3); }

/* Bikes */
.bike { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--line); }
.bike:first-child { border-top: 0; }
.bike__name { font-weight: 600; }
.bike__sub { font-size: 12px; color: var(--ink-3); }
.bike__nums { display: flex; gap: 10px; font-variant-numeric: tabular-nums; text-align: center; }
.bike__nums div { min-width: 44px; }
.bike__nums b { display: block; font-size: 18px; line-height: 1; }
.bike__nums small { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-3); }
.bike__nums .low b { color: var(--bad); }
.bike__bar { grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.bike__bar i { display: block; height: 100%; background: var(--ink-2); }

/* Shuttles */
.shuttle { padding: 10px 12px; border-top: 1px solid var(--line); font-size: 13px; }
.shuttle:first-child { border-top: 0; }
.shuttle b { display: block; font-size: 14px; }
.shuttle .veh { display: inline-block; margin: 4px 6px 0 0; padding: 3px 8px; border-radius: 999px; background: var(--paper-2); border: 1px solid var(--line); font-size: 12px; }
.shuttle .veh.on { border-color: var(--ink); color: var(--ink); font-weight: 700; }

/* Other services */
.other { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.svc { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
.svc b { display: block; font-size: 14px; }
.svc .kind { color: var(--ink-3); font-size: 12px; }
.svc .warn { color: var(--bad); font-weight: 600; }
.svc a { color: var(--ink); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
````

## `public/app.js`

````javascript
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
  const dot = (c) => (c ? `<i class="dot" style="background:${esc(c)}"></i>` : '');
  let tag = mode === 'rail' && d.lineAbbr ? `<span class="line">${dot(d.colors?.bg)}${esc(d.lineAbbr)}</span>` : '';
  if (mode === 'path') tag = `<span class="line">${dot(d.lineColor)}PATH</span>`;
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
````

## `test/njt.test.js`

````javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNjtDate } from '../lib/njt.js';
import { createMockRail, createMockBus, createMockLightRail } from '../lib/mock.js';

test('parses NJ Transit timestamp format', () => {
  const iso = parseNjtDate('18-Sep-2026 03:02:18 PM');
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 8); assert.equal(d.getDate(), 18);
  assert.equal(d.getHours(), 15); assert.equal(d.getMinutes(), 2);
  assert.equal(new Date(parseNjtDate('01-Jan-2026 12:15:00 AM')).getHours(), 0);
  assert.equal(parseNjtDate(''), null);
});

test('mock adapters return normalized shapes', async () => {
  const r = await createMockRail().departures('HB');
  assert.equal(r.station, 'HB'); assert.ok(r.departures.length > 0);
  for (const k of ['trainId', 'line', 'destination', 'scheduled', 'status', 'delayMin']) assert.ok(k in r.departures[0], k);
  const b = await createMockBus().departures('journal-square');
  assert.ok(b.departures.every((d) => d.route && d.headsign && d.eta));
  const l = await createMockLightRail().departures('newport');
  assert.equal(l.stationName, 'Newport');
});
````

## `test/gtfs.test.js`

````javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseCsv, loadGtfs } from '../lib/gtfs.js';

// Build a tiny deflated zip in memory so the reader is tested end to end.
function makeZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(centrals.length / 2, 8); eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('parseCsv handles quotes and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n1,2\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'he said "hi"' }, { a: '1', b: '2' }]);
});

test('loadGtfs returns upcoming departures for a stop', () => {
  const now = new Date(); const in20 = new Date(now.getTime() + 20 * 60000);
  // GTFS times are seconds since the service day's midnight and may exceed 24:00.
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const hms = (d) => { const s = Math.floor((d - midnight) / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:00`; };
  const dow = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const cal = dow.map((d) => (d === dow[now.getDay()] ? '1' : '0')).join(',');
  const zip = makeZip({
    'stops.txt': 'stop_id,stop_name\nS1,Hoboken 14th Street\nS2,Midtown\n',
    'routes.txt': 'route_id,route_short_name,route_long_name\nR1,MID,Hoboken 14th – Midtown\n',
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nR1,WK,T1,Midtown / W 39th,0\n',
    'calendar.txt': `service_id,${dow.join(',')},start_date,end_date\nWK,${cal},20200101,20991231\n`,
    'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,${hms(in20)},${hms(in20)},S1,1\nT1,${hms(in20)},${hms(in20)},S2,2\n`,
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-')), 'g.zip');
  fs.writeFileSync(file, zip);
  const g = loadGtfs(file);
  const deps = g.departures('S1', now);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].destination, 'Midtown / W 39th');
  assert.equal(g.findStops(/14th/)[0].stop_id, 'S1');
});
````

## `README.md`

````markdown
# HudPost · Hudson County Transit (MVP)

A single-page live departures board for Hudson County, styled to sit next to hudpost.com/jobs, backed by the
NJ Transit developer API. Zero npm dependencies.

```
npm run dev      # mock data, no credentials needed  → http://localhost:3000
cp .env.example .env && edit   # add NJ Transit credentials
npm start        # live data
npm test
```

## Design rules

Built from what riders complain about in the official NJ Transit and NY Waterway apps:

| Complaint | What this page does |
|---|---|
| "Too many clicks" / "I miss my favorites home screen" | **Your stops**: starred stops render on load with the next four departures. No navigation. |
| "Trains say on time even if they're delayed unless you click in" | Delay, estimated time and track are on every row. Scheduled time is struck through next to the new estimate. |
| "DepartureVision took away the time for boarding trains" | Boarding rows keep their time and track. Nothing is hidden on status change. |
| "Nearby stations sorted alphabetically" | **Nearby** sorts every stop by distance with the distance shown. |
| Stale real-time data | Every card and board shows its data age. Anything over 90 s or after a failed refresh is flagged *Stale*; last-good data stays visible. |
| Timetable vs live confusion | Timetable-only rows (light rail, ferry) are labeled *Scheduled*. |
| Ferry frequency and waits | **To Manhattan** merges every NYC-bound train, bus and ferry from one area, soonest first, so the wait decision is one glance. |

## What's on the page

- **Your stops** – starred rail stations, HBLR stations, bus hubs and ferry terminals, with data age per card.
- **To Manhattan** – cross-mode board per area (Hoboken, Secaucus, JC waterfront, Journal Square, Weehawken, Union City, North Bergen, Bayonne).
- **Road crossings strip** – Holland, Lincoln, Pulaski Skyway, Turnpike Extension, Bayonne Bridge, Route 139 (demo until 511NJ is connected).
- **Weather hint** in the top bar from the National Weather Service: temperature, rain timing, high wind, for the bike-or-ferry call.
- **All stops** – Rail (Hoboken, Secaucus Upper/Lower), Light Rail (24 HBLR stations), Bus (6 hubs), PATH (6 stations), Ferry (7 NY Waterway terminals), Citi Bike (every Jersey City and Hoboken dock with bikes, e-bikes and open docks), Shuttles (Hoboken Hop, Secaucus XChange with live vehicle counts via Passio GO). Search across all modes, nearby sort, tap to expand, star to pin.
- **Also in the county** – Via Jersey City, Liberty Landing Ferry, EZ Ride 273, Secaucus Community Shuttle, Bergenline jitneys, Senior Shuttle, Access Link, cruise shuttles. Static cards with hours, fares and links, labeled as having no live data.
- Auto-refresh every 30 s, countdowns tick every 5 s, dark mode, phone layout. No masthead or footer: it is meant to be embedded.

## Layout

```
server.js          Node http server: static files + /api/* proxy, token cache, 20 s response cache
lib/njt.js         Live NJ Transit adapter (TrainData rail API + BUSDV2 bus API), response normalization
lib/mock.js        Mock adapters with the same shapes (used when credentials are missing or NJT_MOCK=1)
lib/gtfs.js        Dependency-free GTFS static reader (zip → next departures at a stop)
lib/ferry.js       NY Waterway adapter over lib/gtfs.js (set NYWW_GTFS_PATH to a downloaded gtfs.zip)
lib/path.js        PATH real-time arrivals (PANYNJ RidePATH JSON, keyless)
lib/bikes.js       Citi Bike GBFS (keyless), Hudson County stations only
lib/passio.js      Passio GO shuttle tracking (Hop, XChange) — needs systemIds
lib/weather.js     National Weather Service hourly forecast (keyless)
data/hudson.json   Curated Hudson County stations, HBLR stops, bus hubs and routes
public/            index.html, styles.css (brand tokens at the top), app.js
docs/njt-api.md    What the API exposes, field names, limits, open questions
```

### API routes

| Route | Notes |
|---|---|
| `GET /api/meta` | modes (live/mock), station and hub lists |
| `GET /api/rail/departures?station=HB\|SE\|TS` | normalized DepartureVision board |
| `GET /api/rail/messages?station=HB` | station banner messages |
| `GET /api/lightrail/departures?station=<slug>` | HBLR (schedule) |
| `GET /api/bus/departures?hub=<id>` or `?stop=<5-digit>` | BUSDV2 next departures |
| `GET /api/ferry/departures?terminal=<id>` | NY Waterway (GTFS timetable or mock) |
| `GET /api/nyc?area=<id>` | merged NYC-bound departures across NJ Transit, PATH, bus, ferry |
| `GET /api/path/departures?station=HOB` | PATH arrivals |
| `GET /api/bikes?lat&lon&limit` | Citi Bike docks, nearest first |
| `GET /api/shuttles?system=hop` | live shuttle count per route |
| `GET /api/roads` · `GET /api/weather` | crossings strip, conditions hint |

## Brand and color

hudpost.com was not reachable from the build environment, so `public/styles.css` opens with placeholder
brand tokens (`--brand`, `--ink`, fonts). Swap them to the live site's values and the rest follows.

Color rule, after reader feedback that too many colors were confusing: **grey scale for everything,
`--brand` only when something needs attention** (late, cancelled, stale, incident, alert) **or is
selected**. Modes are outlined text pills, not colored blocks. Official NJ Transit and PATH line colors
survive only as a 7px dot beside the line name so riders can match station signage.

## Next steps

1. Paste real credentials into `.env`, confirm field casing against `docs/njt-api.md`.
2. Fill in bus `stopId`s in `data/hudson.json` from the GTFS `stops.txt`.
3. Download NY Waterway's `gtfs.zip` and NJ Transit's `rail_data.zip`; point `NYWW_GTFS_PATH` at the first and wire HBLR to the same reader.
5. Read the Passio GO systemIds off hoboken.passiogo.com and uc.passiogo.com into `data/hudson.json`.
6. Register for 511NJ and replace the roads mock.
4. Embed in WordPress: the page is plain HTML/CSS/JS, so it can be dropped into a template with the `/api` proxy hosted as a small Node service or serverless function.
````

## `docs/njt-api.md`

````markdown
# What the NJ Transit developer API gives us

Findings from the public client libraries that wrap `developer.njtransit.com` (the portal itself and
njtransit.com were not reachable from the build environment, so verify field names against the portal's
own docs once you're logged in). Sources: bamnet/njtapi, jtarrio/raildata, errornil/njtransit v2,
carlosmartinezt/njtransit, ASwitchCase/NATK, joshbrewster42/tidbyt-nj-transit.

## Products on the portal

| Product | Base URL | Auth | What it gives Hudson County |
|---|---|---|---|
| **Rail (TrainData)** | `https://raildata.njtransit.com/api/TrainData/` (test: `testraildata.njtransit.com`) | `POST getToken` with `username`,`password` → `UserToken` | Real-time DepartureVision boards for **Hoboken (HB)**, **Secaucus Upper (SE)** and **Secaucus Lower (TS)**, station banner messages, live train GPS |
| **Bus (BUSDV2)** | `https://pcsdata.njtransit.com/api/BUSDV2/` | `POST authenticateUser` → `UserToken` (~24h) | Real-time next-departure boards per **stop code** (Journal Square, Hoboken Terminal, Exchange Place, Bergenline…), live vehicle positions near a lat/lon |
| **GTFS static** | zip download (rail, bus, light rail `rail_data.zip`) | portal login | Stop IDs, HBLR timetables, route shapes. Limited to ~10 downloads/day |
| **GTFS-RT** | protobuf feeds: trip updates, vehicle positions, alerts | separate token per feed | Service alerts, bus/rail vehicle positions |

Every data call is an HTTP `POST` with a `multipart/form-data` body carrying `token` (rail calls also send
`username`). Responses are JSON with **strings for every value** and timestamps like
`18-Sep-2026 03:02:18 PM` (America/New_York). Published limit: **40,000 calls/day** per data endpoint;
`getStationSchedule` is 5/day and `isValidToken` 10/day, so never call those per page view.

## Rail endpoints (TrainData)

| Endpoint | Params | Returns |
|---|---|---|
| `getStationList` | – | `[{STATION_2CHAR, STATIONNAME, STATION_14CHAR}]` |
| `getTrainSchedule` | `station` | `{STATION_2CHAR, STATIONNAME, ITEMS:[…]}` – full DepartureVision board |
| `getTrainSchedule19Rec` | `station`, `line?` | same, capped at 19 rows |
| `getTrainStopList` | `train` | stops + capacity per car for one train |
| `getVehicleData` | – | every active train: `TrainId, Line, Direction, NextStop, Location, Delay` |
| `getStationMSG` | `station`, `line?` | banner messages: `MSG_ID, MSG_TYPE, MSG_TEXT, MSG_PUBDATE, MSG_URL, MSG_STATION_SCOPE, MSG_LINE_SCOPE` |
| `getStationSchedule` | `station` | full-day timetable (5 calls/day) |

`ITEMS[]` fields: `TRAIN_ID, LINE, LINEABBREVIATION, DESTINATION, SCHED_DEP_DATE, TRACK, STATUS, SEC_LATE,
LAST_MODIFIED, BACKCOLOR, FORECOLOR, SHADOWCOLOR, GPSLATITUDE, GPSLONGITUDE, GPSTIME, STATION_POSITION,
INLINEMSG, CONNECTING_TRAIN_ID, CAPACITY[], STOPS[{NAME, TIME, DEPARTED, STOP_STATUS, STOP_LINES}]`.

## Bus endpoints (BUSDV2)

| Endpoint | Params | Returns |
|---|---|---|
| `authenticateUser` | `username`, `password` | `{Authenticated:"True", UserToken}` |
| `getBusDV` | `token`, `stop` (5-digit stop code), `direction?`, `route?`, `ip?` | `{message, DVTrip:[…]}` |
| `getVehicleLocations` | `token`, `lat`, `lon`, `radius` (mi), `mode` (`ALL`…) | `[{VehicleID, VehicleRoute, VehicleDestination, VehicleLat, VehicleLong, VehiclePassengerLoad, VehicleDistanceMiles, VehicleScheduledDeparture, VehicleInternalTripNumber}]` |

`DVTrip[]` fields: `public_route, header, lanegate, departuretime ("5 MIN", "Approaching", "DELAY"),
sched_dep_time ("04:55 PM"), remarks, internal_trip_number, timing_point_id, message, fullscreen,
passload, vehicle_id`.

## Light rail

No client library exposes a real-time HBLR endpoint. njtransit.com's own DepartureVision page for
"Hoboken Light Rail" proves the data exists, and `getVehicleLocations` has a `mode` parameter that may
accept `LIGHTRAIL`, but neither is documented publicly. For the MVP light rail is **schedule-only**
(mock today; wire to GTFS `rail_data.zip` `route_type=0` next).

## What's still unknown / to verify with real credentials

1. Bus **stop codes** for each Hudson County hub (from GTFS `stops.txt` → `stop_code`). `data/hudson.json` has `stopId: null` placeholders.
2. Whether the rail portal account is approved for production (`raildata`) or only test (`testraildata`).
3. Whether `getVehicleLocations` returns light rail vehicles with `mode=LIGHTRAIL`.
4. Exact casing of a few wrapper fields (`ITEMS`, `DVTrip`); `lib/njt.js` accepts both cases where seen.

# Other feeds we use or want

| Mode | Source | Key? | Status in this repo |
|---|---|---|---|
| **PATH** (JSQ, GRV, EXP, NEW, HOB, HAR) | Port Authority RidePATH JSON `https://www.panynj.gov/bin/portauthority/ridepath.json` (~15 s refresh) | No | `lib/path.js` live adapter, on by default; mock fallback |
| **Citi Bike** (Jersey City + Hoboken) | GBFS `https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json` → `station_information`, `station_status` | No | `lib/bikes.js` live adapter, filtered to the Hudson County bounding box |
| **Hoboken Hop, Secaucus XChange shuttle** | Passio GO unofficial JSON (`passiogo.com/mapGetData.php`, see athuler/PassioGo). Also GTFS per system. | No, but needs each system's `systemId` from hoboken.passiogo.com / uc.passiogo.com | `lib/passio.js` adapter; `passioSystemId` still null in `data/hudson.json` → mock |
| **NY Waterway** (7 terminals) | GTFS static zip; GTFS-RT protobuf | No | `lib/ferry.js` over `lib/gtfs.js` when `NYWW_GTFS_PATH` is set |
| **Roads** (Holland, Lincoln, Pulaski, Turnpike Ext, Bayonne Bridge, Rt 139) | 511NJ developer API (register at 511nj.org); PANYNJ crossing feeds | Yes | Mock only; strip is labeled demo |
| **Weather** | NWS `https://api.weather.gov/points/{lat},{lon}` → `forecastHourly` | No (User-Agent required) | `lib/weather.js` live adapter |
| **NJ Transit GTFS-RT alerts** | protobuf feed from the developer portal | Yes | Not wired; rail banner messages used instead |
| **Via Jersey City** | No public API | – | Static card; city proposed cutting it (May 2026) |
| **Liberty Landing Ferry, EZ Ride 273, Secaucus Community Shuttle, jitneys, Senior Shuttle, Access Link, cruise shuttles** | Operator web pages only | – | Static cards under "Also in the county" |

## Considered and left out

- **NYC Ferry, Seastreak, Newark Light Rail, Amtrak** – no Hudson County stops.
- **Scooters** – Hoboken's Lime pilot ended; no current county program.
- **Parking availability at Secaucus / Journal Square** – no feed.
- **Port Authority Bus Terminal gate assignments** – not published as data.
````
