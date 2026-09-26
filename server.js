// HudPost transit MVP server: static files + a thin JSON API that proxies NJ Transit.
// Zero dependencies (Node 20+). Run `npm run dev` for mock data, `npm start` with a .env for live data.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hudson from './data/hudson.json' with { type: 'json' };
import { createRailClient, createBusClient } from './lib/njt.js';
import { createMockRail, createMockBus, createMockLightRail } from './lib/mock.js';

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
    modes: { rail: rail.mode, bus: bus.mode, lightRail: lightRail.mode },
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
  console.log(`HudPost transit MVP on http://localhost:${PORT}  (rail=${rail.mode}, bus=${bus.mode}, lightRail=${lightRail.mode})`);
});

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
