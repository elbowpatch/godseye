// GET /api/ais-live — AIS vessel snapshot.
//
// IMPORTANT — architecture note:
// The original dev-server proxy keeps ONE persistent WebSocket open to
// AISStream (wss://stream.aisstream.io) for the life of the process and
// accumulates vessel state in memory. Vercel serverless functions are
// stateless and short-lived — they cannot hold a WebSocket open between
// invocations, so that design cannot run as a Vercel function.
//
// This endpoint instead proxies to an external always-on relay service
// (see /relay/server.mjs in this repo for a ready-to-deploy example you
// can run on Fly.io / Railway / a small VPS) that does the AISStream
// connection and exposes the same JSON shape over plain HTTP. Point
// AIS_RELAY_URL at it, e.g. AIS_RELAY_URL=https://your-relay.example.com
//
// Without AIS_RELAY_URL set, this returns a 503 with rows: [] so the
// client's AIS layer degrades gracefully instead of throwing.
import { fetchWithTimeout } from './_lib/http.js';

export default async function handler(req, res) {
  const relay = process.env.AIS_RELAY_URL;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!relay) {
    res.statusCode = 503;
    res.end(JSON.stringify({
      rows: [],
      source: 'AISStream',
      status: 'unconfigured',
      error: 'AIS_RELAY_URL is not set. AIS live vessels require a separate always-on relay — see relay/README.md.',
      refreshing: false,
    }));
    return;
  }

  try {
    const incoming = new URL(req.url, 'http://localhost');
    const upstream = await fetchWithTimeout(`${relay.replace(/\/$/, '')}/ais-live${incoming.search}`, {}, 8000);
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: error?.message || 'AIS relay unreachable', rows: [] }));
  }
}
