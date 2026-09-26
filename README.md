# HudPost · Hudson County Transit (MVP)

A single-page live departures board for Hudson County, styled to sit next to hudpost.com/jobs, backed by the
NJ Transit developer API. Zero npm dependencies.

```
npm run dev      # mock data, no credentials needed  → http://localhost:3000
cp .env.example .env && edit   # add NJ Transit credentials
npm start        # live data
npm test
```

## What's on the page

- **Rail** – DepartureVision boards for Hoboken Terminal, Secaucus Upper and Secaucus Lower, plus station banner alerts.
- **Light Rail** – all 24 Hudson-Bergen Light Rail stations (schedule-based until NJ Transit exposes a real-time HBLR feed).
- **Bus** – next departures at six county hubs (Journal Square, Hoboken Terminal, Exchange Place, Bergenline & 32nd, Bayonne, North Bergen P&R) with route chips.
- Auto-refresh every 30 s, remembers your last station, dark mode, phone layout.

## Layout

```
server.js          Node http server: static files + /api/* proxy, token cache, 20 s response cache
lib/njt.js         Live NJ Transit adapter (TrainData rail API + BUSDV2 bus API), response normalization
lib/mock.js        Mock adapters with the same shapes (used when credentials are missing or NJT_MOCK=1)
data/hudson.json   Curated Hudson County stations, HBLR stops, bus hubs and routes
public/            index.html, styles.css (brand tokens at the top), app.js
docs/njt-api.md    What the API exposes, field names, limits, open questions
```

### API routes

| Route | Notes |
|---|---|
| `GET /api/meta` | modes (live/mock), station and hub lists |
| `GET /api/rail/departures?station=HB\|SE\|TS` | normalized DepartureVision board |
| `GET /api/rail/messages?station=HB` | station banner messages |
| `GET /api/lightrail/departures?station=<slug>` | HBLR (schedule) |
| `GET /api/bus/departures?hub=<id>` or `?stop=<5-digit>` | BUSDV2 next departures |

## Brand

hudpost.com was not reachable from the build environment, so `public/styles.css` opens with placeholder
brand tokens (`--brand`, `--ink`, fonts). Swap them to the live site's values and the rest follows.

## Next steps

1. Paste real credentials into `.env`, confirm field casing against `docs/njt-api.md`.
2. Fill in bus `stopId`s in `data/hudson.json` from the GTFS `stops.txt`.
3. Load `rail_data.zip` GTFS for real HBLR timetables.
4. Embed in WordPress: the page is plain HTML/CSS/JS, so it can be dropped into a template with the `/api` proxy hosted as a small Node service or serverless function.
