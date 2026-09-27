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
