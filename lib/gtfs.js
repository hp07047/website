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
