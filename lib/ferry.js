// NY Waterway adapter. Reads a downloaded GTFS zip (NYWW_GTFS_PATH) and matches each Hudson County
// terminal to a GTFS stop by gtfsStopId, falling back to a name match.
import { loadGtfs } from './gtfs.js';
import hudson from '../data/hudson.json' with { type: 'json' };

export function createFerryClient({ gtfsPath }) {
  const gtfs = loadGtfs(gtfsPath);
  const resolve = (terminal) => {
    if (terminal.gtfsStopId && gtfs.stops.has(terminal.gtfsStopId)) return terminal.gtfsStopId;
    const key = terminal.name.split(/[\/(]/)[0].trim().replace(/ Street$/, '');
    return gtfs.findStops(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))[0]?.stop_id || null;
  };
  return {
    mode: 'schedule',
    async departures(terminalId) {
      const t = hudson.ferry.terminals.find((x) => x.id === terminalId);
      if (!t) throw new Error('unknown terminal');
      const stopId = resolve(t);
      if (!stopId) return { terminal: terminalId, terminalName: t.name, departures: [], message: 'terminal not found in GTFS feed' };
      return { terminal: terminalId, terminalName: t.name, gtfsStopId: stopId, departures: gtfs.departures(stopId).slice(0, 12) };
    },
  };
}
