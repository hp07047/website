// National Weather Service hourly forecast: public, no key. Two calls, both cached upstream.
const UA = { 'user-agent': 'hudpost-transit/0.1 (transit page; contact via hudpost.com)', accept: 'application/geo+json' };
export function createWeatherClient({ lat, lon }) {
  let hourlyUrl = null;
  return {
    mode: 'live',
    async now() {
      if (!hourlyUrl) {
        const p = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: UA });
        if (!p.ok) throw new Error(`nws points -> HTTP ${p.status}`);
        hourlyUrl = (await p.json()).properties.forecastHourly;
      }
      const f = await fetch(hourlyUrl, { headers: UA });
      if (!f.ok) throw new Error(`nws hourly -> HTTP ${f.status}`);
      const periods = (await f.json()).properties.periods.slice(0, 6);
      const now = periods[0];
      const rainSoon = periods.find((x) => (x.probabilityOfPrecipitation?.value || 0) >= 50);
      return {
        tempF: now.temperature, short: now.shortForecast, windMph: Number(String(now.windSpeed).match(/\d+/)?.[0] || 0), windDir: now.windDirection,
        precipPct: now.probabilityOfPrecipitation?.value || 0,
        rainAt: rainSoon ? rainSoon.startTime : null, source: 'live',
      };
    },
  };
}
