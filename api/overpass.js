// POST /api/overpass — Overpass QL proxy with validation, multi-mirror
// fallback, and KV-backed response caching (24h fresh / serve-stale beyond).
//
// Ported from vite.config.js's overpassProxy(). The original kept a memory
// Map + a 7-30 day on-disk cache per query; here both collapse into one KV
// entry per query (see api/_lib/cache.js). The per-instance rate limiter is
// a best-effort backstop only — it does not coordinate across serverless
// instances the way the single dev-server process did.
import { createHash } from 'node:crypto';
import * as cache from './_lib/cache.js';
import { readRawBody } from './_lib/http.js';
import {
  sanitizeOverpassBody,
  fetchOverpassPayload,
  makeRateLimiter,
} from './_lib/overpass.js';

export const config = { maxDuration: 30 };

const OVERPASS_CACHE_TTL_S = 7 * 86400; // 7 days; boundary queries get 30 below
const OVERPASS_BOUNDARY_TTL_S = 30 * 86400;
const OVERPASS_MAX_BODY_BYTES = 24 * 1024;
const OVERPASS_MAX_CONCURRENT = 6;

const rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });
let concurrent = 0;

function clientKey(req) {
  return String(req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'anon');
}

function cacheKeyFor(safeBody) {
  const normalized = safeBody.replace(/\s+/g, ' ').trim();
  return `overpass:${createHash('sha1').update(normalized).digest('hex')}`;
}

function sendPayload(res, payload, cacheStatus) {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': 'public, max-age=15',
    'X-Overpass-Cache': cacheStatus,
    'X-Overpass-Upstream': payload.endpoint || 'unknown',
  });
  res.end(payload.body || '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  let key = null;
  try {
    const raw = await readRawBody(req, OVERPASS_MAX_BODY_BYTES);
    if (!raw) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Overpass query body' }));
      return;
    }

    const sanitized = sanitizeOverpassBody(raw);
    if (!sanitized.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: sanitized.error }));
      return;
    }

    key = cacheKeyFor(sanitized.body);
    const cached = await cache.get(key);
    if (cached) {
      const isBoundary = /is_in\s*\(|\bpivot\b/i.test(sanitized.body);
      const ttlS = isBoundary ? OVERPASS_BOUNDARY_TTL_S : OVERPASS_CACHE_TTL_S;
      const isStale = Date.now() - cached.cachedAt > ttlS * 1000;
      if (!isStale) {
        sendPayload(res, cached, 'HIT');
        return;
      }
      // fresh TTL elapsed but entry retained — fall through to try a refresh,
      // and use this as the serve-stale fallback if upstream fails.
    }

    if (!rateLimiter(clientKey(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
    if (concurrent >= OVERPASS_MAX_CONCURRENT) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(JSON.stringify({ error: 'Overpass proxy busy — try again shortly' }));
      return;
    }

    concurrent += 1;
    let payload;
    try {
      payload = await fetchOverpassPayload(sanitized.body);
    } finally {
      concurrent -= 1;
    }

    if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
      const isBoundary = /is_in\s*\(|\bpivot\b/i.test(sanitized.body);
      await cache.set(key, { ...payload, cachedAt: Date.now() }, isBoundary ? OVERPASS_BOUNDARY_TTL_S : OVERPASS_CACHE_TTL_S);
      sendPayload(res, payload, 'MISS');
      return;
    }

    // Degraded upstream — last-good beats empty.
    if (cached) {
      sendPayload(res, cached, 'STALE');
      return;
    }
    sendPayload(res, payload, 'MISS');
  } catch (e) {
    const stale = key ? await cache.get(key) : null;
    if (stale) {
      sendPayload(res, stale, 'STALE');
      return;
    }
    console.error('[Overpass Proxy]', e?.message || e);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Overpass proxy error' }));
  }
}
