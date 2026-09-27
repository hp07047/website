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
