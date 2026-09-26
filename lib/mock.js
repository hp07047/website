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
