// GET /api/firms — NASA FIRMS live active-fire proxy (3x VIIRS NRT sources),
// 30-min KV cache, serve-stale.
import * as cache from '../_lib/cache.js';
import { fetchWithTimeout } from '../_lib/http.js';
import { parseFirmsCsv, filterTrailing24h } from '../../src/data/firmsCsv.js';

const TTL_MS = 30 * 60_000;
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
const CACHE_KEY = 'firms:fires';

const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

async function fetchSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const res = await fetchWithTimeout(url, {}, 60_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const records = parseFirmsCsv(await res.text());
  if (records === null) throw new Error('non-CSV upstream response');
  return records;
}

async function refreshUpstream(key) {
  const now = Date.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchSource(key, source), now);
      sources.push({ source, count: records.length, ok: true });
      for (const record of records) fires.push(record);
    } catch (err) {
      console.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

function buildPayload(entry, stale) {
  const fires = filterTrailing24h(entry.fires, Date.now());
  return { fetchedAt: entry.at, stale, ttlMs: TTL_MS, sources: entry.sources, count: fires.length, fires };
}

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    const key = mapKey();
    if (!key) return sendJson(503, { error: 'no_key' });

    const entry = await cache.get(CACHE_KEY);
    if (entry && Date.now() - entry.at < TTL_MS) return sendJson(200, buildPayload(entry, false));

    try {
      const fresh = await refreshUpstream(key);
      await cache.set(CACHE_KEY, fresh, 3 * 3600); // keep well past TTL for serve-stale
      sendJson(200, buildPayload(fresh, false));
    } catch (err) {
      console.warn(`[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`);
      if (entry) sendJson(200, buildPayload(entry, true));
      else sendJson(502, { error: 'firms fetch failed and no cache available' });
    }
  } catch (err) {
    console.warn('[firms-proxy] error:', err?.message || err);
    sendJson(500, { error: 'firms proxy error' });
  }
}
