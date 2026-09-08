// GET /api/firms/status — key presence, cache freshness, and MAP_KEY quota.
import * as cache from '../_lib/cache.js';
import { fetchWithTimeout } from '../_lib/http.js';

const TTL_MS = 30 * 60_000;
const STATUS_TTL_MS = 5 * 60_000;
const CACHE_KEY = 'firms:fires';
const STATUS_CACHE_KEY = 'firms:mapkey-status';

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const key = String(process.env.FIRMS_MAP_KEY || '').trim();
  if (!key) return sendJson(200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: TTL_MS, transactions: null });

  const entry = await cache.get(CACHE_KEY);

  let transactions = null;
  const statusCached = await cache.get(STATUS_CACHE_KEY);
  if (statusCached && Date.now() - statusCached.at < STATUS_TTL_MS) {
    transactions = statusCached.transactions;
  } else {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
      const res2 = await fetchWithTimeout(url, {}, 10_000);
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      const body = await res2.json();
      const used = Number(body?.current_transactions);
      const limit = Number(body?.transaction_limit);
      transactions = Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
    } catch (err) {
      console.warn('[firms-proxy] mapkey status failed:', err?.message || err);
      transactions = null;
    }
    await cache.set(STATUS_CACHE_KEY, { at: Date.now(), transactions }, 600);
  }

  sendJson(200, {
    hasKey: true,
    lastFetch: entry ? entry.at : null,
    count: entry ? entry.fires.length : null,
    stale: entry ? Date.now() - entry.at >= TTL_MS : false,
    ttlMs: TTL_MS,
    transactions,
  });
}
