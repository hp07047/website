# HudPost · Hudson County Transit (MVP)

A single-page live departures board for Hudson County, styled to sit next to hudpost.com/jobs, backed by the
NJ Transit developer API. Zero npm dependencies.

```
npm run dev      # mock data, no credentials needed  → http://localhost:3000
cp .env.example .env && edit   # add NJ Transit credentials
npm start        # live data
npm test
```

## Design rules

Built from what riders complain about in the official NJ Transit and NY Waterway apps:

| Complaint | What this page does |
|---|---|
| "Too many clicks" / "I miss my favorites home screen" | **Your stops**: starred stops render on load with the next four departures. No navigation. |
| "Trains say on time even if they're delayed unless you click in" | Delay, estimated time and track are on every row. Scheduled time is struck through next to the new estimate. |
| "DepartureVision took away the time for boarding trains" | Boarding rows keep their time and track. Nothing is hidden on status change. |
| "Nearby stations sorted alphabetically" | **Nearby** sorts every stop by distance with the distance shown. |
| Stale real-time data | Every card and board shows its data age. Anything over 90 s or after a failed refresh is flagged *Stale*; last-good data stays visible. |
| Timetable vs live confusion | Timetable-only rows (light rail, ferry) are labeled *Scheduled*. |
| Ferry frequency and waits | **To Manhattan** merges every NYC-bound train, bus and ferry from one area, soonest first, so the wait decision is one glance. |

## What's on the page

- **Your stops** – starred rail stations, HBLR stations, bus hubs and ferry terminals, with data age per card.
- **To Manhattan** – cross-mode board per area (Hoboken, Secaucus, JC waterfront, Journal Square, Weehawken, Union City, North Bergen, Bayonne).
- **All stops** – Rail (Hoboken, Secaucus Upper/Lower), Light Rail (all 24 HBLR stations), Bus (6 hubs), Ferry (6 NY Waterway terminals); search across all, nearby sort, tap to expand a board inline, star to pin.
- Auto-refresh every 30 s, countdowns tick every 5 s, dark mode, phone layout. No masthead or footer: it is meant to be embedded.

## Layout

```
server.js          Node http server: static files + /api/* proxy, token cache, 20 s response cache
lib/njt.js         Live NJ Transit adapter (TrainData rail API + BUSDV2 bus API), response normalization
lib/mock.js        Mock adapters with the same shapes (used when credentials are missing or NJT_MOCK=1)
lib/gtfs.js        Dependency-free GTFS static reader (zip → next departures at a stop)
lib/ferry.js       NY Waterway adapter over lib/gtfs.js (set NYWW_GTFS_PATH to a downloaded gtfs.zip)
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
| `GET /api/ferry/departures?terminal=<id>` | NY Waterway (GTFS timetable or mock) |
| `GET /api/nyc?area=<id>` | merged NYC-bound departures across modes |

## Brand

hudpost.com was not reachable from the build environment, so `public/styles.css` opens with placeholder
brand tokens (`--brand`, `--ink`, fonts). Swap them to the live site's values and the rest follows.

## Next steps

1. Paste real credentials into `.env`, confirm field casing against `docs/njt-api.md`.
2. Fill in bus `stopId`s in `data/hudson.json` from the GTFS `stops.txt`.
3. Download NY Waterway's `gtfs.zip` and NJ Transit's `rail_data.zip`; point `NYWW_GTFS_PATH` at the first and wire HBLR to the same reader.
5. PATH is not in any feed we have; add it if a source turns up.
4. Embed in WordPress: the page is plain HTML/CSS/JS, so it can be dropped into a template with the `/api` proxy hosted as a small Node service or serverless function.
