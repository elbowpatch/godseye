// GET /api/tomtom/status — reports whether a TomTom key is configured and
// today's tile-fetch budget usage.
import * as cache from '../_lib/cache.js';
import { utcDayKey, normalizeBudget } from '../../src/data/tomtomTiles.js';

const DEFAULT_DAILY_BUDGET = 40000;

function dailyBudgetLimit() {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

export default async function handler(req, res) {
  const hasKey = Boolean(process.env.TOMTOM_API_KEY);
  const dayKey = utcDayKey();
  const stored = (await cache.get(`tomtom:budget:${dayKey}`)) || null;
  const budget = normalizeBudget(stored, dayKey);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ hasKey, dailyCount: budget.count, budget: dailyBudgetLimit(), date: budget.date }));
}
