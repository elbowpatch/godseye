// GET /api/terrain/heights?points=lon,lat;lon,lat;... — batched terrain
// height lookups against the Re:Earth terrain service, KV-cached 30 days
// (terrain doesn't move). Ported to use api/_lib/cache.js instead of the
// original disk cache; resolveTerrainHeightRequest's cache interface is
// synchronous (Map-like), so this handler hydrates a plain Map from KV for
// just the keys in the request, then persists any new/changed entries back.
import * as cache from '../_lib/cache.js';
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
} from '../../src/data/terrainHeightsProxy.js';

const TTL_MS = 30 * 24 * 3600_000;
const MAX_POINTS = 2000;

function kvKey(pointKey) {
  return `terrain:${pointKey}`;
}

export default async function handler(req, res) {
  const send = (status, bodyObj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bodyObj));
  };
  try {
    const parsedUrl = new URL(req.url, 'http://internal');
    const rawPoints = parsedUrl.searchParams.get('points');
    const points = parseTerrainPoints(rawPoints);
    if (!points) {
      send(400, { error: 'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers' });
      return;
    }
    if (points.length > MAX_POINTS) {
      send(500, { error: `too many points (${points.length}); max ${MAX_POINTS} per request` });
      return;
    }

    // Hydrate a plain Map from KV for exactly the keys this request touches.
    const uniqueKeys = [...new Set(points.map(terrainPointKey))];
    const localCache = new Map();
    await Promise.all(uniqueKeys.map(async (key) => {
      const entry = await cache.get(kvKey(key));
      if (entry) localCache.set(key, entry);
    }));

    const outcome = await resolveTerrainHeightRequest({
      points,
      cache: localCache,
      fetchMissing: (missingPoints) => fetchTerrainChunkWithRetry(missingPoints),
      ttlMs: TTL_MS,
    });

    if (outcome.cacheChanged) {
      // Persist only the keys that changed (i.e. every key we now hold).
      await Promise.all(uniqueKeys.map(async (key) => {
        const entry = localCache.get(key);
        if (entry) await cache.set(kvKey(key), entry, Math.floor(TTL_MS / 1000));
      }));
    }
    if (outcome.upstreamError) {
      console.warn(`[terrain-heights-proxy] refresh incomplete (${outcome.upstreamError?.message || outcome.upstreamError}) — serving stale points when available`);
    }
    send(outcome.status, outcome.body);
  } catch (err) {
    send(500, { error: `terrain heights proxy error: ${err?.message || err}` });
  }
}
