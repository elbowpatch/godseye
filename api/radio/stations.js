// GET /api/radio/stations — Radio Browser directory, 45min KV cache,
// serve-stale up to 7 days on refresh failure.
import * as cache from '../_lib/cache.js';
import { buildRadioCatalog } from '../_lib/radio.js';

const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_KEY = 'radio:catalog';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  try {
    const cached = await cache.get(CATALOG_KEY);
    const now = Date.now();
    let catalog;
    let stale = false;

    if (cached && now - cached.cachedAt < RADIO_DIRECTORY_CACHE_MS) {
      catalog = cached;
    } else {
      try {
        catalog = await buildRadioCatalog();
        if (catalog.degraded && cached) throw Object.assign(new Error('degraded refresh'), { radioDegradedReason: catalog.degradedReason });
        if (catalog.degraded && !catalog.stations.length) throw Object.assign(new Error('no usable stations'), { radioDegradedReason: catalog.degradedReason });
        await cache.set(CATALOG_KEY, catalog, Math.floor(RADIO_DIRECTORY_STALE_MS / 1000));
      } catch (error) {
        if (cached && now - cached.cachedAt <= RADIO_DIRECTORY_STALE_MS) {
          catalog = { ...cached, degraded: true, degradedReason: error?.radioDegradedReason || 'refresh-failed' };
          stale = true;
        } else {
          throw error;
        }
      }
    }

    sendJson(res, 200, {
      stations: catalog.stations,
      updatedAt: catalog.updatedAt,
      stale,
      degraded: Boolean(catalog.degraded),
      degradedReason: catalog.degradedReason || null,
      coverage: catalog.coverage || null,
      acceptedGeneration: 1,
      catalogInstance: 'vercel',
    });
  } catch (error) {
    sendJson(res, 503, {
      error: 'Radio directory is temporarily unavailable',
      degraded: Boolean(error?.radioCatalogDegraded),
      degradedReason: error?.radioDegradedReason || null,
    });
  }
}
