// GET /api/adsblol/trace?hex=<icao24> — adsb.lol tar1090 track history (ODbL).
import * as cache from '../_lib/cache.js';
import { fetchWithTimeout } from '../_lib/http.js';

const TRACK_CACHE_MS = 60000;
const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;

export default async function handler(req, res) {
  try {
    const incoming = new URL(req.url, 'http://localhost');
    const hex = String(incoming.searchParams.get('hex') || '').trim().toLowerCase();
    if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'hex must be a 6-7 char hex string' }));
      return;
    }
    const key = `lol:trace:${hex}`;
    const cached = await cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    const upstream = await fetchWithTimeout(`https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`, {}, 12000);
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
    res.end(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
  }
}
