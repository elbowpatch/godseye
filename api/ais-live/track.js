// GET /api/ais-live/track?mmsi= — proxies to the AIS relay's track endpoint.
// See api/ais-live.js for why this can't be a self-contained Vercel function.
import { fetchWithTimeout } from '../_lib/http.js';

export default async function handler(req, res) {
  const relay = process.env.AIS_RELAY_URL;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const incoming = new URL(req.url, 'http://localhost');
  const mmsi = String(incoming.searchParams.get('mmsi') || '').trim();

  if (!/^\d{5,10}$/.test(mmsi)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'mmsi query param required', samples: [] }));
    return;
  }
  if (!relay) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: 'AIS_RELAY_URL is not set', samples: [] }));
    return;
  }
  try {
    const upstream = await fetchWithTimeout(`${relay.replace(/\/$/, '')}/ais-live/track?mmsi=${encodeURIComponent(mmsi)}`, {}, 8000);
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: error?.message || 'AIS relay unreachable', samples: [] }));
  }
}
