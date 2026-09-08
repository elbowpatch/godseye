// GET /api/tomtom/flow/{z}/{x}/{y}.pbf — TomTom traffic-flow vector tile
// proxy with a daily budget governor and KV cache (120s fresh, serve-stale
// past that and over-budget).
import * as cache from '../../../../_lib/cache.js';
import { fetchWithTimeout } from '../../../../_lib/http.js';
import { isValidTileCoord, utcDayKey, normalizeBudget, isOverBudget } from '../../../../../src/data/tomtomTiles.js';

const TILE_TTL_MS = 120_000;
const DEFAULT_DAILY_BUDGET = 40000;

function dailyBudgetLimit() {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

async function recordUpstreamFetch() {
  const dayKey = utcDayKey();
  const budgetKey = `tomtom:budget:${dayKey}`;
  const stored = (await cache.get(budgetKey)) || null;
  const budget = normalizeBudget(stored, dayKey);
  budget.count += 1;
  await cache.set(budgetKey, budget, 172800); // 2 days, comfortably past the UTC rollover
  return budget;
}

async function currentBudget() {
  const dayKey = utcDayKey();
  const stored = (await cache.get(`tomtom:budget:${dayKey}`)) || null;
  return normalizeBudget(stored, dayKey);
}

export default async function handler(req, res) {
  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const sendTile = (buf, cacheStatus) => {
    res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store', 'x-tomtom-cache': cacheStatus });
    res.end(buf);
  };

  try {
    const z = Number(req.query?.z);
    const x = Number(req.query?.x);
    const yRaw = String(req.query?.y || '');
    const yMatch = yRaw.match(/^(\d+)\.pbf$/);
    if (!yMatch) return sendJson(404, { error: 'not_found' });
    const y = Number(yMatch[1]);

    if (!isValidTileCoord(z, x, y)) return sendJson(400, { error: 'invalid_tile' });
    if (!process.env.TOMTOM_API_KEY) return sendJson(503, { error: 'no_key' });

    const tileKey = `tomtom:tile:${z}/${x}/${y}`;
    const entry = await cache.get(tileKey);
    const now = Date.now();

    if (entry && now - entry.at < TILE_TTL_MS) {
      return sendTile(Buffer.from(entry.buf, 'base64'), 'HIT');
    }

    const budget = await currentBudget();
    if (isOverBudget(budget, dailyBudgetLimit())) {
      if (entry) return sendTile(Buffer.from(entry.buf, 'base64'), 'STALE-BUDGET');
      return sendJson(429, { error: 'budget' });
    }

    try {
      const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
      await recordUpstreamFetch();
      const upstream = await fetchWithTimeout(url, {}, 15000);
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0) throw new Error('empty tile body');
      await cache.set(tileKey, { at: Date.now(), buf: buf.toString('base64') }, 3600);
      sendTile(buf, 'MISS');
    } catch (err) {
      console.warn(`[tomtom-proxy] ${z}/${x}/${y} fetch failed (${err?.message || err})`);
      if (entry) return sendTile(Buffer.from(entry.buf, 'base64'), 'STALE-ERROR');
      sendJson(502, { error: 'upstream' });
    }
  } catch (err) {
    console.warn('[tomtom-proxy] error:', err?.message || err);
    sendJson(500, { error: 'proxy' });
  }
}
