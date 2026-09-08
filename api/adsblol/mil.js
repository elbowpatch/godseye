// GET /api/adsblol/mil — adsb.lol military-flagged aircraft, 15s cache.
import * as cache from '../_lib/cache.js';
import { fetchWithTimeout } from '../_lib/http.js';

const CACHE_MS = 15000;

export default async function handler(req, res) {
  const now = Date.now();
  const cached = await cache.get('adsblol:mil');
  if (cached && now - cached.at < CACHE_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'HIT' });
    res.end(cached.body);
    return;
  }
  try {
    const upstream = await fetchWithTimeout('https://api.adsb.lol/v2/mil', {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
    }, 10000);
    const body = await upstream.text();
    if (upstream.ok) await cache.set('adsblol:mil', { body, at: now }, 60);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'MISS' });
    res.end(body);
  } catch (e) {
    console.error('[adsb.lol Proxy]', e.message);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-ADS-B-Cache': 'STALE' });
      res.end(cached.body);
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
  }
}
