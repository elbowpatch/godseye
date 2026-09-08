// GET /api/opensky — OpenSky Network states/all proxy.
//
// Ported from vite.config.js's openSkyProxy(). Same behavior: multi-mode
// auth (oauth/basic/auto/anon), adaptive-TTL response caching, 429 cooldown
// governor, serve-stale on failure, and a bounded adsb.lol regional fallback
// when the OpenSky snapshot itself is stale or unavailable.
//
// State (token, cache, cooldown, adaptive TTL) that used to live in
// module-scope variables now lives in the shared KV/memory cache (see
// api/_lib/cache.js) so it's consistent across serverless invocations.
import * as cache from './_lib/cache.js';
import { fetchWithTimeout } from './_lib/http.js';
import { getOpenSkyToken } from './_lib/openskyToken.js';

export const config = { maxDuration: 15 };

const OPENSKY_CACHE_MS = 9000;
const OPENSKY_SOURCE_STALE_MS = 5 * 60_000; // 5 min
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
const OPENSKY_AUTH_MODE_SET = new Set(['basic', 'oauth', 'auto', 'anon']);
const ADSBLOL_POINT_RADIUS_NM = 250;
const ADSBLOL_POINT_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

function normalizeOpenSkyAuthMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return OPENSKY_AUTH_MODE_DEFAULT;
  if (OPENSKY_AUTH_MODE_SET.has(raw)) return raw;
  return OPENSKY_AUTH_MODE_DEFAULT;
}

function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}

function buildOpenSkyHeaders(res, { cacheStatus, requestedMode, usedMode, reason, staleSeconds, retryAfterSeconds }) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-OpenSky-Cache', cacheStatus);
  res.setHeader('X-OpenSky-Auth', usedMode);
  res.setHeader('X-OpenSky-Auth-Mode-Requested', requestedMode);
  res.setHeader('X-OpenSky-Auth-Mode-Used', usedMode);
  res.setHeader('X-OpenSky-Auth-Reason', reason);
  if (Number.isFinite(staleSeconds)) res.setHeader('X-OpenSky-Stale-Seconds', String(Math.round(staleSeconds)));
  if (Number.isFinite(retryAfterSeconds)) res.setHeader('X-OpenSky-Retry-After-Seconds', String(Math.round(retryAfterSeconds)));
}

function openSkySourceEpochMs(body) {
  try {
    const seconds = Number(JSON.parse(body)?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return Number.isFinite(sourceEpochMs) && now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS;
}


function requiredFiniteQueryNumber(searchParams, key) {
  const raw = searchParams.get(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function adsbLolFallbackAnchor(req) {
  const incoming = new URL(req.url, 'http://localhost');
  const latitude = requiredFiniteQueryNumber(incoming.searchParams, 'lat');
  const longitude = requiredFiniteQueryNumber(incoming.searchParams, 'lon');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function normalizeAdsbLolPointResponse(payload) {
  const acList = Array.isArray(payload?.ac) ? payload.ac : [];
  const states = acList
    .filter((a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon))
    .map((a) => [
      a.hex || null, a.flight ? String(a.flight).trim() : null, null, null, null,
      a.lon, a.lat, Number.isFinite(a.alt_baro) ? a.alt_baro * 0.3048 : null,
      false, Number.isFinite(a.gs) ? a.gs * 0.514444 : null,
      Number.isFinite(a.track) ? a.track : null, Number.isFinite(a.baro_rate) ? a.baro_rate * 0.00508 : null,
      null, Number.isFinite(a.alt_geom) ? a.alt_geom * 0.3048 : null, a.squawk || null, false, 0,
    ]);
  return { time: Math.floor(Date.now() / 1000), states };
}

async function fetchAdsbLolPointFallback(req) {
  const anchor = adsbLolFallbackAnchor(req);
  if (!anchor) return null;
  const roundedLat = Math.round(anchor.latitude * 4) / 4;
  const roundedLon = Math.round(anchor.longitude * 4) / 4;
  const cacheKey = `adsblol:point:${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const cached = await cache.get(cacheKey);
  if (cached) return { ...cached, cacheStatus: 'HIT' };
  try {
    const upstream = await fetchWithTimeout(
      `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0' } },
      10000,
    );
    if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
    const text = await upstream.text();
    if (text.length > ADSBLOL_POINT_MAX_RESPONSE_BYTES) throw new Error('response too large');
    const normalized = normalizeAdsbLolPointResponse(JSON.parse(text));
    const record = { body: JSON.stringify(normalized), count: normalized.states.length };
    await cache.set(cacheKey, record, 15);
    return { ...record, cacheStatus: 'MISS' };
  } catch (error) {
    console.warn('[adsb.lol Flights Fallback]', error?.message || error);
    return null;
  }
}

async function serveAdsbLolPointFallback(req, res, requestedMode, reason) {
  const fallback = await fetchAdsbLolPointFallback(req);
  if (!fallback) return false;
  buildOpenSkyHeaders(res, { cacheStatus: fallback.cacheStatus, requestedMode, usedMode: 'adsblol-regional', reason });
  res.setHeader('X-Flight-Source', 'adsb.lol');
  res.setHeader('X-Flight-Coverage', `${ADSBLOL_POINT_RADIUS_NM}nm regional fallback`);
  res.setHeader('X-Flight-Count', String(fallback.count));
  res.statusCode = 200;
  res.end(fallback.body);
  return true;
}

export default async function handler(req, res) {
  const requestedMode = normalizeOpenSkyAuthMode(process.env.OPENSKY_AUTH_MODE);
  const now = Date.now();
  const state = (await cache.get('opensky:state')) || {};
  const inCooldown = now < (state.cooldownUntil || 0);
  const ttlMs = state.ttlMs || OPENSKY_CACHE_MS;

  try {
    if (state.body && (now - state.time < ttlMs || inCooldown)) {
      if (openSkySourceIsStale(state.sourceEpochMs, now)
        && (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_snapshot_stale_regional_fallback'))) {
        return;
      }
      const meta = state.meta || { requestedMode, usedMode: 'unknown', reason: 'cached' };
      const isStale = now - state.time >= ttlMs;
      buildOpenSkyHeaders(res, {
        cacheStatus: isStale ? 'STALE' : 'HIT',
        requestedMode: meta.requestedMode || requestedMode,
        usedMode: meta.usedMode || 'unknown',
        reason: isStale ? 'rate_limited_serving_stale' : (meta.reason || 'cached'),
        staleSeconds: isStale ? (now - state.time) / 1000 : undefined,
        retryAfterSeconds: inCooldown ? (state.cooldownUntil - now) / 1000 : undefined,
      });
      res.statusCode = state.status || 200;
      res.end(state.body);
      return;
    }

    if (inCooldown) {
      if (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_cooldown_regional_fallback')) return;
      buildOpenSkyHeaders(res, { cacheStatus: 'COOLDOWN', requestedMode, usedMode: 'none', reason: 'rate_limited', retryAfterSeconds: (state.cooldownUntil - now) / 1000 });
      res.statusCode = 429;
      res.end(JSON.stringify({ error: 'OpenSky rate limited; proxy cooling down.' }));
      return;
    }

    const basicUser = process.env.OPENSKY_USERNAME || '';
    const basicPass = process.env.OPENSKY_PASSWORD || '';
    const hasBasicCreds = Boolean(basicUser && basicPass);
    const headers = { Accept: 'application/json' };
    let usedMode = 'anon';
    let reason = 'forced_anonymous';

    if (requestedMode === 'basic') {
      if (hasBasicCreds) {
        headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
        usedMode = 'basic'; reason = 'basic_credentials';
      } else { reason = 'missing_basic_creds'; }
    } else if (requestedMode === 'oauth') {
      const token = await getOpenSkyToken();
      if (token) { headers.Authorization = `Bearer ${token}`; usedMode = 'oauth'; reason = 'oauth_token'; }
      else { reason = 'oauth_invalid_or_missing'; }
    } else if (requestedMode === 'auto') {
      const token = await getOpenSkyToken();
      if (token) { headers.Authorization = `Bearer ${token}`; usedMode = 'oauth'; reason = 'oauth_token'; }
      else if (hasBasicCreds) { headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`; usedMode = 'basic'; reason = 'oauth_unavailable_fallback_basic'; }
      else { reason = 'missing_oauth_and_basic_creds'; }
    }

    let upstream = await fetchWithTimeout('https://opensky-network.org/api/states/all?extended=1', { headers }, 15000);
    if ((upstream.status === 401 || upstream.status === 403) && requestedMode === 'auto' && usedMode === 'oauth' && hasBasicCreds) {
      upstream = await fetchWithTimeout('https://opensky-network.org/api/states/all?extended=1', {
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}` },
      }, 15000);
      usedMode = 'basic'; reason = 'oauth_rejected_fallback_basic';
    }

    let body = await upstream.text();
    const sourceEpochMs = upstream.ok ? openSkySourceEpochMs(body) : null;
    if (upstream.ok && openSkySourceIsStale(sourceEpochMs, now)
      && (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_snapshot_stale_regional_fallback'))) {
      await cache.set('opensky:state', { ...state, body, status: upstream.status, time: now, sourceEpochMs, meta: { requestedMode, usedMode, reason } }, 600);
      return;
    }

    if (upstream.status === 429) {
      reason = 'rate_limited';
      const retryAfterSec = Number(upstream.headers.get('x-rate-limit-retry-after-seconds'));
      const cooldownMs = Math.min(Math.max(Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 120_000, 30_000), 30 * 60_000);
      await cache.set('opensky:state', { ...state, cooldownUntil: now + cooldownMs }, Math.ceil(cooldownMs / 1000) + 60);
      if (state.body && state.status === 200) {
        buildOpenSkyHeaders(res, { cacheStatus: 'STALE', requestedMode, usedMode, reason: 'rate_limited_serving_stale', staleSeconds: (now - state.time) / 1000, retryAfterSeconds: cooldownMs / 1000 });
        res.statusCode = 200;
        res.end(state.body);
        return;
      }
    }

    if (!upstream.ok && !state.body) {
      if (await serveAdsbLolPointFallback(req, res, requestedMode, `opensky_http_${upstream.status}_regional_fallback`)) return;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      if (requestedMode === 'basic' && !hasBasicCreds) { body = JSON.stringify({ error: 'OpenSky auth missing. Basic mode requires OPENSKY_USERNAME and OPENSKY_PASSWORD.' }); reason = 'missing_basic_creds'; }
      else if (requestedMode === 'oauth' && usedMode !== 'oauth') { body = JSON.stringify({ error: 'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.' }); reason = 'oauth_invalid_or_missing'; }
      else if (usedMode === 'basic') { body = JSON.stringify({ error: 'OpenSky auth invalid. Username/password were rejected.' }); reason = 'basic_invalid_credentials'; }
      else if (usedMode === 'oauth') { body = JSON.stringify({ error: 'OpenSky auth invalid. OAuth client credentials were rejected.' }); reason = 'oauth_invalid_credentials'; }
      else if (requestedMode === 'auto' && !hasBasicCreds) { body = JSON.stringify({ error: 'OpenSky auth missing. Provide basic credentials or valid OAuth client credentials.' }); reason = 'missing_oauth_and_basic_creds'; }
      else { body = JSON.stringify({ error: 'OpenSky auth required.' }); reason = 'auth_required'; }
    }

    if (upstream.ok && reason === 'forced_anonymous') reason = 'anonymous_ok';
    else if (upstream.ok && usedMode === 'basic' && reason === 'basic_credentials') reason = 'basic_ok';
    else if (upstream.ok && usedMode === 'oauth' && reason === 'oauth_token') reason = 'oauth_ok';

    let nextState = state;
    if (upstream.ok) {
      const remaining = Number(upstream.headers.get('x-rate-limit-remaining'));
      const ttl = openskyAdaptiveTtlMs(remaining);
      nextState = { body, status: upstream.status, time: now, sourceEpochMs, meta: { requestedMode, usedMode, reason }, ttlMs: ttl, cooldownUntil: 0 };
      await cache.set('opensky:state', nextState, 600);
    }

    buildOpenSkyHeaders(res, { cacheStatus: 'MISS', requestedMode, usedMode, reason });
    res.statusCode = upstream.status;
    res.end(body);
  } catch (e) {
    console.error('[OpenSky Proxy]', e?.message || e);
    if (state.body) {
      const meta = state.meta || { requestedMode, usedMode: 'unknown', reason: 'cached_stale' };
      buildOpenSkyHeaders(res, { cacheStatus: 'STALE', requestedMode: meta.requestedMode || requestedMode, usedMode: meta.usedMode || 'unknown', reason: meta.reason || 'cached_stale' });
      res.statusCode = state.status || 200;
      res.end(state.body);
      return;
    }
    if (await serveAdsbLolPointFallback(req, res, requestedMode, 'opensky_proxy_error_regional_fallback')) return;
    buildOpenSkyHeaders(res, { cacheStatus: 'MISS', requestedMode, usedMode: 'error', reason: 'proxy_error' });
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'OpenSky proxy error' }));
  }
}
