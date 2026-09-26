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
