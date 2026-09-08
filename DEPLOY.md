# Deploying to Vercel

This is a port of the original Vite-dev-server-based backend (see the
project's `vite.config.js`) to Vercel serverless functions under `api/`.
Read [`PORT_NOTES.md`](./PORT_NOTES.md) first if you want to know exactly
what changed and why — this file is just the "how to actually deploy it"
steps.

## 1. Prerequisites

- A Vercel account and the project pushed to a Git repo Vercel can import
  (or use the Vercel CLI locally: `npm i -g vercel`)
- Node 20+ locally for testing (the repo's `engines` field pins a newer
  version for local dev; Vercel's Node runtime version is set separately in
  Project Settings → General, independent of `package.json`'s `engines`)

## 2. Add Vercel KV (recommended, not required)

Several endpoints (OpenSky, Overpass, CelesTrak, TomTom, FIRMS, terrain
heights, adsbdb, radio, CCTV sources) cache upstream responses. Without KV
they still work — the cache just falls back to per-instance memory, which is
wiped on every cold start and not shared across concurrent instances, so
you'll see more cache misses and heavier upstream API usage.

In the Vercel dashboard: **Storage → Create Database → KV** (Upstash Redis),
then connect it to this project. This automatically injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN` — no code changes needed, `api/_lib/cache.js`
detects and uses them.

## 3. Set environment variables

In **Project Settings → Environment Variables**. All of these are optional —
each feature they gate degrades gracefully (returns "not configured" /
empty data) rather than breaking the app when unset.

### Build-time (must be set before `vite build` runs — Vercel injects all
project env vars into the build step by default, so just setting them in the
dashboard is enough)

| Var | Used for |
|---|---|
| `CESIUM_ION_TOKEN` | Cesium ion photorealistic 3D tiles — get one free at https://ion.cesium.com |

### Runtime (read by `api/*.js` functions)

| Var | Feature | Notes |
|---|---|---|
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Flights (OpenSky OAuth) | recommended — anonymous OpenSky access is heavily rate-limited |
| `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` | Flights (OpenSky basic auth, legacy) | alternative to OAuth |
| `OPENSKY_AUTH_MODE` | `oauth` (default) / `basic` / `auto` / `anon` | |
| `AISSTREAM_API_KEY` | AIS vessels | **also requires deploying the separate AIS relay — see §5** |
| `AIS_RELAY_URL` | AIS vessels | URL of the relay from §5, e.g. `https://ais-relay.fly.dev` |
| `GOOGLE_MAPS_API_KEY` | Nearby-place labels, Street View CCTV fallback | needs Places API (New) + Street View Static API enabled |
| `OPENAI_API_KEY` | Voice control + HUD 5-word summaries | |
| `OPENAI_REALTIME_MODEL` / `OPENAI_REALTIME_MODEL_MINI` / `OPENAI_REALTIME_VOICE` / `OPENAI_REALTIME_REASONING_EFFORT` / `OPENAI_REALTIME_CONTEXT_TOKENS` / `OPENAI_REALTIME_CONTEXT_RETENTION` / `OPENAI_HUD_SUMMARY_MODEL` | Voice tuning | all optional, sane defaults |
| `FIRMS_MAP_KEY` | Active-fire layer | free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| `TOMTOM_API_KEY` | Traffic flow tiles | |
| `TOMTOM_DAILY_TILE_BUDGET` | Traffic flow tiles | default 40000/day |
| `LL2_API_TOKEN` | Launches | optional, raises Launch Library 2 rate limit |
| `CCTV_SOURCES_JSON` | CCTV cameras | inline JSON array — see `config/cctv_sources.shinjuku.json` for the shape. On Vercel, prefer this over `CCTV_SOURCES_FILE` (see §6). |
| `CCTV_SOURCES_FILE` | CCTV cameras | path relative to repo root; defaults to `config/cctv_sources.austin.json` (ships empty) |
| `CCTV_PREFER_AUSTIN` (default `1`) / `CCTV_FORCE_AUSTIN` | CCTV cameras | `1` = auto-populate from Austin/Caltrans/TfL open data when no file/env sources are configured |
| `CCTV_TFL_ENABLED` (default `1`), `TFL_APP_KEY` | CCTV cameras | TfL JamCam open data; app key raises rate limits but isn't required |
| `CCTV_AUSTIN_MAX_SOURCES` / `CCTV_CALTRANS_DISTRICTS` / `CCTV_CALTRANS_MAX_SOURCES` / `CCTV_TFL_MAX_SOURCES` / `CCTV_MAX_SOURCES` | CCTV cameras | tuning caps |
| `GEV_RATELIMIT_OPENAI_PER_MIN` / `GEV_RATELIMIT_GOOGLE_PER_MIN` | Abuse protection | unset = no rate limit; best-effort/per-instance only on Vercel, see `PORT_NOTES.md` |

## 4. Deploy

```bash
npm i -g vercel   # if you don't have it
vercel link       # or import the repo in the dashboard instead
vercel env pull   # optional, to test locally against your real env vars
vercel --prod
```

Or just import the Git repo in the Vercel dashboard — it auto-detects the
Vite framework preset from `vercel.json`.

## 5. AIS live vessels — deploy the relay (optional feature)

AISStream requires one persistent WebSocket connection per API key, which a
Vercel serverless function cannot hold open. `/relay/` in this repo is a
small standalone Node service that does. See `relay/README.md` for
Fly.io/Railway/VPS deploy instructions. Once it's running, set
`AIS_RELAY_URL` on the Vercel project to point at it.

Skip this if you don't need live AIS vessels — the layer just shows "not
configured" instead of erroring.

## 6. CCTV camera sources on Vercel

The CCTV endpoints (`api/cctv/*`) read `config/cctv_sources.*.json` via
`fs.readFileSync` at runtime if you point `CCTV_SOURCES_FILE` at a repo file.
Vercel's build-time file tracer can miss dynamically-read files, so:

- `vercel.json` explicitly bundles `config/**` for `api/cctv/**/*.js`
  functions via `includeFiles`, so the shipped default file works.
- If you add your **own** camera source file, either keep it under
  `config/` (already covered by `includeFiles`), or — more reliably — paste
  its contents into the `CCTV_SOURCES_JSON` env var instead of using
  `CCTV_SOURCES_FILE`.

## 7. What's simplified vs. the original dev-server proxy

See `PORT_NOTES.md` for the full list. Short version: per-IP rate limiters
and CCTV health tracking are best-effort (process-memory only, reset on cold
start); `/api/setup/*` (the local "POWER UP" key-setup panel) was already
dev-server-only in the original app and isn't ported — configure keys via
the Vercel dashboard's Environment Variables instead. Everything else is a
functionally faithful port.
