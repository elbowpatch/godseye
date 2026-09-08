// GET /api/launches — Launch Library 2 recent/upcoming launches, 15min KV cache.
import * as cache from './_lib/cache.js';
import { fetchWithTimeout } from './_lib/http.js';
import { readResponseTextCapped } from './_lib/overpass.js';

const TTL_S = 15 * 60;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const CACHE_KEY = 'launches:recent';

function launchLibraryRequestHeaders() {
  const token = String(process.env.LL2_API_TOKEN || '').trim();
  return { Accept: 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) };
}

function send(res, status, body, cacheState) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
    'X-GEV-Cache': cacheState,
  });
  res.end(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
    return;
  }
  const cached = await cache.get(CACHE_KEY);
  const now = Date.now();
  if (cached && now - cached.at < TTL_S * 1000) {
    send(res, 200, cached.body, 'HIT');
    return;
  }
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');
    const upstream = await fetchWithTimeout(url, { headers: launchLibraryRequestHeaders() }, 20000);
    const body = await readResponseTextCapped(upstream, MAX_RESPONSE_BYTES);
    if (!upstream.ok) {
      const err = new Error(`upstream HTTP ${upstream.status}`);
      err.upstreamStatus = upstream.status;
      err.upstreamBody = body;
      throw err;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results)) throw new Error('malformed upstream response');
    await cache.set(CACHE_KEY, { at: Date.now(), body }, 24 * 3600);
    send(res, 200, body, 'MISS');
  } catch (error) {
    if (cached) {
      console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
      send(res, 200, cached.body, 'STALE-ERROR');
      return;
    }
    send(
      res,
      Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
      error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
      'NONE',
    );
  }
}
