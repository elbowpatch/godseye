// GET /api/celestrak/:group — CelesTrak TLE proxy, 6h KV cache, serve-stale.
import * as cache from '../_lib/cache.js';
import { fetchWithTimeout } from '../_lib/http.js';

const TLE_TTL_S = 6 * 3600;

export default async function handler(req, res) {
  const group = String(req.query?.group || '').trim();
  if (!/^[a-z0-9-]+$/i.test(group)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid group');
    return;
  }
  const key = `celestrak:${group}`;
  const send = (status, body, cacheStatus) => {
    res.writeHead(status, { 'Content-Type': 'text/plain', 'x-tle-cache': cacheStatus });
    res.end(body);
  };
  try {
    const entry = await cache.get(key);
    const now = Date.now();
    if (entry && now - entry.at < TLE_TTL_S * 1000) {
      send(200, entry.body, 'HIT');
      return;
    }
    try {
      const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
      url.searchParams.set('GROUP', group);
      url.searchParams.set('FORMAT', 'tle');
      const upstream = await fetchWithTimeout(url.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
      }, 20000);
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const body = await upstream.text();
      if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
      const fresh = { at: Date.now(), body };
      await cache.set(key, fresh, 30 * 24 * 3600); // keep long past TTL for serve-stale
      send(200, body, 'MISS');
    } catch (err) {
      console.warn(`[celestrak-proxy] ${group} refresh failed (${err?.message || err})`);
      if (entry) send(200, entry.body, 'STALE-ERROR');
      else send(502, 'celestrak fetch failed and no cache available', 'NONE');
    }
  } catch (err) {
    send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
  }
}
