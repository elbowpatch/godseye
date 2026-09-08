# Port notes: Vite dev-server proxy → Vercel serverless functions

The original app's entire backend lived in `vite.config.js` as ~30
`configureServer` middleware handlers, which only run under `vite dev` /
`vite preview` — a plain `vite build` ships none of them. This port
reimplements each one as a file under `api/`, one function per route, mostly
reusing the same pure logic modules the original already had under `src/`
(`src/data/tomtomTiles.js`, `terrainHeightsProxy.js`, `firmsCsv.js`,
`radioCountry.js`, `directionText.js`, `src/voice/voiceCost.js`,
`src/hudSummaryResponse.js`, `src/data/aisStreamAdapter.js` /
`aisWatchdog.js` — none of these have any imports of their own, so they were
safe to import as-is).

## Endpoints ported 1:1 (same behavior, different runtime)

`/api/opensky`, `/api/opensky-track`, `/api/adsblol/mil`,
`/api/adsblol/trace`, `/api/celestrak/:group`, `/api/launches`,
`/api/tomtom/status`, `/api/tomtom/flow/:z/:x/:y.pbf`, `/api/firms`,
`/api/firms/status`, `/api/terrain/heights`, `/api/adsbdb/route/:callsign`,
`/api/adsbdb/type/:hex`, `/api/overpass`, `/api/route`,
`/api/openai/hud-summary`, `/api/realtime/token`, `/api/google/nearby-places`,
`/api/google/text-search`, `/api/gbfs/:target`, `/api/cctv/sources`,
`/api/cctv/stream/:id`, `/api/cctv/media/:id`, `/api/cctv/frame/:id`.

## What changed, and why

### Caching: in-memory Map + on-disk cache → KV (or memory fallback)

The original kept response caches in module-scope `Map`s and, for a few
endpoints, a `.gev-cache/*.json` on-disk cache — both assume a single
long-lived process with a persistent filesystem. Vercel functions are
stateless between invocations and the filesystem is ephemeral, so
`api/_lib/cache.js` replaces both with a KV-backed cache (Vercel KV /
Upstash Redis) that falls back to memory-only if KV isn't configured. Same
TTLs, same serve-stale-on-failure behavior; the durability guarantee across
instances is weaker without KV.

### Rate limiters: best-effort, not coordinated

`api/overpass.js`, `api/route.js`, and `api/_lib/rateLimit.js` (used by
OpenAI/Google endpoints) keep the same fixed-window limiter algorithm as the
original, but its state lives in module memory. On Vercel that means it
resets on cold start and does not coordinate across concurrent warm
instances — it's a soft backstop, not a hard guarantee, unlike the single
dev-server process the original ran as. If you need a hard global rate
limit, put Vercel KV's atomic increment behind these instead.

### CCTV health tracking: same weakening as rate limiters

`api/_lib/cctv.js`'s `setCctvHealth`/`listCctvHealth` are process-memory
only for the same reason. It's diagnostic-only data (`/api/cctv/health`),
not something the camera layer depends on to function.

### AIS live vessels: moved to a separate always-on relay

AISStream allows exactly one WebSocket connection per API key and expects it
held open indefinitely — fundamentally incompatible with a stateless,
short-lived serverless function. `api/ais-live.js` and
`api/ais-live/track.js` now proxy to an external relay
(`AIS_RELAY_URL`); `relay/server.mjs` in this repo is that relay, meant to
run on Fly.io/Railway/a VPS. See `relay/README.md`. Without a relay
configured, the endpoint returns `503` with an empty vessel list instead of
erroring.

### `/api/setup/*` — not ported (was already dev-only)

The original explicitly disabled this Vite plugin outside `vite dev`
(`apply: command === 'serve' && !isPreview`) — it's a local-only panel that
writes API keys into a `.env` file on disk, which has no meaningful
equivalent in a serverless/env-var-based deployment. The client
(`src/keySetup.js`) already handles a missing `/api/setup/status` (404)
by hiding the panel, so nothing else needed to change. Configure keys via
Vercel's Environment Variables dashboard instead.

### Radio proxy: DNS-pinning dropped, allowlist kept

The original DNS-pins every outbound Radio Browser request (resolves the
mirror hostname once, connects to that literal IP) as defense-in-depth
against DNS rebinding on a long-lived process. `api/_lib/radio.js` uses
plain `fetch()` to the same small, regex-validated allowlist of
`*.api.radio-browser.info` origins instead — reasonable for a short-lived
function making a handful of requests to a fixed, trusted host pattern. The
origin/path allowlist itself (`radioProxyDestination` equivalent) is fully
preserved.

### Debug logging: file → console

`api/realtime/debug-log.js` used to append to a local
`.gev-logs/*.jsonl` file. Vercel's filesystem is ephemeral, so this now logs
to `console.log` (visible in `vercel logs` / the dashboard) instead. It's a
debug aid the client doesn't depend on.

### Everything else

Validation logic, security guards (Overpass query sanitization/abuse
prevention, GBFS host/path allowlisting, CCTV upstream restrictions —
frames only ever fetch a server-registered camera URL, never a
client-supplied one), OpenSky's multi-mode auth + cooldown + adaptive-TTL
logic, and the full OpenAI Realtime voice tool schema were ported verbatim.
