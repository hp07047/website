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
