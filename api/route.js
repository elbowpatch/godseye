// GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
// Real OSM routing via the public FOSSGIS OSRM servers.
import * as cache from './_lib/cache.js';
import { fetchWithTimeout } from './_lib/http.js';
import { readResponseTextCapped, makeRateLimiter } from './_lib/overpass.js';

const ROUTE_CACHE_TTL_S = 600;
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ROUTE_MAX_LEG_KM = 600;
const ROUTE_MAX_TOTAL_KM = 2500;

const rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 200 });

function clientKey(req) {
  return String(req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'anon');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req, res) {
  const fail = (msg) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: msg }));
  };
  try {
    if (!rateLimiter(clientKey(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
    const profile = (raw === 'car' || raw === 'driving') ? 'car'
      : (raw === 'bike' || raw === 'cycling' || raw === 'bicycle') ? 'bike'
        : (raw === 'foot' || raw === 'walking' || raw === 'walk') ? 'foot'
          : null;
    if (!profile) return fail('invalid profile');
    const osrmProfile = profile === 'car' ? 'driving' : profile;
    const pairs = (url.searchParams.get('coords') || '').split(';').map((s) => s.trim()).filter(Boolean);
    if (pairs.length < 2 || pairs.length > 12) return fail('need 2-12 coordinates');
    const clean = [];
    const pts = [];
    for (const pr of pairs) {
      const parts = pr.split(',');
      if (parts.length !== 2) return fail('invalid coordinate');
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail('invalid coordinate');
      clean.push(`${lon},${lat}`);
      pts.push([lon, lat]);
    }
    let totalKm = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const legKm = haversineKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
      if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
      totalKm += legKm;
    }
    if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');

    const coords = clean.join(';');
    const cacheKey = `route:${profile}:${coords}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    const upstream = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    let osrm;
    try {
      const upstreamRes = await fetchWithTimeout(upstream, { headers: { 'User-Agent': 'gods-eye-view/vercel' } }, 12000);
      if (!upstreamRes.ok) return fail('no route found');
      const ctype = upstreamRes.headers.get('content-type') || '';
      if (!ctype.includes('json')) return fail('no route found');
      const text = await readResponseTextCapped(upstreamRes, ROUTE_MAX_RESPONSE_BYTES);
      osrm = JSON.parse(text);
    } catch {
      return fail('no route found');
    }
    const route = osrm?.routes?.[0];
    if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return fail('no route found');
    const payload = {
      ok: true,
      profile,
      distanceM: Math.round(route.distance),
      durationS: Math.round(route.duration),
      geometry: route.geometry.coordinates,
    };
    await cache.set(cacheKey, payload, ROUTE_CACHE_TTL_S);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (e) {
    console.error('[Route Proxy]', e?.message || e);
    fail('route proxy error');
  }
}
