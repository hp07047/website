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
