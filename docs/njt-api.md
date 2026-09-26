# What the NJ Transit developer API gives us

Findings from the public client libraries that wrap `developer.njtransit.com` (the portal itself and
njtransit.com were not reachable from the build environment, so verify field names against the portal's
own docs once you're logged in). Sources: bamnet/njtapi, jtarrio/raildata, errornil/njtransit v2,
carlosmartinezt/njtransit, ASwitchCase/NATK, joshbrewster42/tidbyt-nj-transit.

## Products on the portal

| Product | Base URL | Auth | What it gives Hudson County |
|---|---|---|---|
| **Rail (TrainData)** | `https://raildata.njtransit.com/api/TrainData/` (test: `testraildata.njtransit.com`) | `POST getToken` with `username`,`password` → `UserToken` | Real-time DepartureVision boards for **Hoboken (HB)**, **Secaucus Upper (SE)** and **Secaucus Lower (TS)**, station banner messages, live train GPS |
| **Bus (BUSDV2)** | `https://pcsdata.njtransit.com/api/BUSDV2/` | `POST authenticateUser` → `UserToken` (~24h) | Real-time next-departure boards per **stop code** (Journal Square, Hoboken Terminal, Exchange Place, Bergenline…), live vehicle positions near a lat/lon |
| **GTFS static** | zip download (rail, bus, light rail `rail_data.zip`) | portal login | Stop IDs, HBLR timetables, route shapes. Limited to ~10 downloads/day |
| **GTFS-RT** | protobuf feeds: trip updates, vehicle positions, alerts | separate token per feed | Service alerts, bus/rail vehicle positions |

Every data call is an HTTP `POST` with a `multipart/form-data` body carrying `token` (rail calls also send
`username`). Responses are JSON with **strings for every value** and timestamps like
`18-Sep-2026 03:02:18 PM` (America/New_York). Published limit: **40,000 calls/day** per data endpoint;
`getStationSchedule` is 5/day and `isValidToken` 10/day, so never call those per page view.

## Rail endpoints (TrainData)

| Endpoint | Params | Returns |
|---|---|---|
| `getStationList` | – | `[{STATION_2CHAR, STATIONNAME, STATION_14CHAR}]` |
| `getTrainSchedule` | `station` | `{STATION_2CHAR, STATIONNAME, ITEMS:[…]}` – full DepartureVision board |
| `getTrainSchedule19Rec` | `station`, `line?` | same, capped at 19 rows |
| `getTrainStopList` | `train` | stops + capacity per car for one train |
| `getVehicleData` | – | every active train: `TrainId, Line, Direction, NextStop, Location, Delay` |
| `getStationMSG` | `station`, `line?` | banner messages: `MSG_ID, MSG_TYPE, MSG_TEXT, MSG_PUBDATE, MSG_URL, MSG_STATION_SCOPE, MSG_LINE_SCOPE` |
| `getStationSchedule` | `station` | full-day timetable (5 calls/day) |

`ITEMS[]` fields: `TRAIN_ID, LINE, LINEABBREVIATION, DESTINATION, SCHED_DEP_DATE, TRACK, STATUS, SEC_LATE,
LAST_MODIFIED, BACKCOLOR, FORECOLOR, SHADOWCOLOR, GPSLATITUDE, GPSLONGITUDE, GPSTIME, STATION_POSITION,
INLINEMSG, CONNECTING_TRAIN_ID, CAPACITY[], STOPS[{NAME, TIME, DEPARTED, STOP_STATUS, STOP_LINES}]`.

## Bus endpoints (BUSDV2)

| Endpoint | Params | Returns |
|---|---|---|
| `authenticateUser` | `username`, `password` | `{Authenticated:"True", UserToken}` |
| `getBusDV` | `token`, `stop` (5-digit stop code), `direction?`, `route?`, `ip?` | `{message, DVTrip:[…]}` |
| `getVehicleLocations` | `token`, `lat`, `lon`, `radius` (mi), `mode` (`ALL`…) | `[{VehicleID, VehicleRoute, VehicleDestination, VehicleLat, VehicleLong, VehiclePassengerLoad, VehicleDistanceMiles, VehicleScheduledDeparture, VehicleInternalTripNumber}]` |

`DVTrip[]` fields: `public_route, header, lanegate, departuretime ("5 MIN", "Approaching", "DELAY"),
sched_dep_time ("04:55 PM"), remarks, internal_trip_number, timing_point_id, message, fullscreen,
passload, vehicle_id`.

## Light rail

No client library exposes a real-time HBLR endpoint. njtransit.com's own DepartureVision page for
"Hoboken Light Rail" proves the data exists, and `getVehicleLocations` has a `mode` parameter that may
accept `LIGHTRAIL`, but neither is documented publicly. For the MVP light rail is **schedule-only**
(mock today; wire to GTFS `rail_data.zip` `route_type=0` next).

## What's still unknown / to verify with real credentials

1. Bus **stop codes** for each Hudson County hub (from GTFS `stops.txt` → `stop_code`). `data/hudson.json` has `stopId: null` placeholders.
2. Whether the rail portal account is approved for production (`raildata`) or only test (`testraildata`).
3. Whether `getVehicleLocations` returns light rail vehicles with `mode=LIGHTRAIL`.
4. Exact casing of a few wrapper fields (`ITEMS`, `DVTrip`); `lib/njt.js` accepts both cases where seen.
