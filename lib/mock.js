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
