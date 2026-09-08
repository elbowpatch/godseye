# AIS Relay

A small always-on Node service that holds the one persistent WebSocket
AISStream allows per API key, and exposes the accumulated vessel state over
plain HTTP. This exists because Vercel serverless functions are stateless and
short-lived and cannot hold that connection themselves — see the comment at
the top of `server.mjs` for the full explanation.

## Deploy it (pick one — anywhere that runs a persistent Node process works)

### Fly.io
```
fly launch --no-deploy   # creates fly.toml in this directory
fly secrets set AISSTREAM_API_KEY=xxx RELAY_TOKEN=$(openssl rand -hex 24)
fly deploy
```

### Railway
```
railway init
railway variables set AISSTREAM_API_KEY=xxx RELAY_TOKEN=$(openssl rand -hex 24)
railway up
```

### Any VPS
```
npm install
AISSTREAM_API_KEY=xxx RELAY_TOKEN=$(openssl rand -hex 24) node server.mjs
# or: pm2 start server.mjs --name ais-relay
```

## Wire it up to the Vercel deployment

In the Vercel project's Environment Variables, set:

```
AIS_RELAY_URL=https://your-relay.example.com
```

(Optional but recommended if the relay is reachable from the public
internet) — also set `RELAY_TOKEN` on the relay and add the matching header
support to `api/ais-live.js`/`api/ais-live/track.js` if you want it enforced
end-to-end; as shipped those two Vercel functions call the relay without an
Authorization header, matching an open relay. If you set `RELAY_TOKEN`, add
`headers: { Authorization: 'Bearer ' + process.env.RELAY_TOKEN }` to the
`fetchWithTimeout` calls in those two files.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `AISSTREAM_API_KEY` | yes | from https://aisstream.io |
| `AISSTREAM_BOUNDING_BOXES` | no | JSON, e.g. `[[[24,-10],[60,40]]]` (default: whole planet) |
| `AISSTREAM_MESSAGE_TYPES` | no | CSV or JSON array (default: position + static data reports) |
| `AISSTREAM_SILENCE_TIMEOUT_MS` | no | `0` disables the silence watchdog |
| `PORT` | no | default `8080` |
| `RELAY_TOKEN` | no but recommended | requires `Authorization: Bearer <token>` on requests |

## Without this relay

`/api/ais-live` on Vercel will respond `503` with `{ rows: [], status:
"unconfigured" }` — the client's AIS vessel layer degrades gracefully
instead of erroring.
