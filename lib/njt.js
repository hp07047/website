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
