// GET /api/opensky-track?icao24=<hex6> — OpenSky tracks/all backfill.
import * as cache from './_lib/cache.js';
import { fetchWithTimeout } from './_lib/http.js';
import { getOpenSkyToken } from './_lib/openskyToken.js';

const TRACK_CACHE_MS = 60000;
const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url, 'http://localhost');
    const icao24 = String(incoming.searchParams.get('icao24') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }));
      return;
    }
    const key = `osky:track:${icao24}`;
    const cached = await cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    const token = await getOpenSkyToken();
    const upstream = await fetchWithTimeout(
      `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      12000,
    );
    const text = await upstream.text();
    let body;
    if (text.length > RESPONSE_CAP_BYTES) body = JSON.stringify({ error: 'Upstream track response too large' });
    else if (!upstream.ok) body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    else body = text;
    await cache.set(key, { at: Date.now(), status: upstream.status, body }, 120);
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'OpenSky track fetch failed' }));
  }
}
