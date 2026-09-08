// Shared adsbdb.com lookup helper — callsign->route and hex->aircraft-type,
// KV-cached 24h including negative (404) results.
import * as cache from './cache.js';
import { fetchWithTimeout } from './http.js';

const TTL_S = 24 * 3600;

function parseRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr?.origin || !fr?.destination) return null;
  const airport = (a) => ({
    code: a.iata_code || a.icao_code || '',
    name: a.municipality || a.name || '',
    lat: Number.isFinite(a.latitude) ? a.latitude : null,
    lon: Number.isFinite(a.longitude) ? a.longitude : null,
  });
  return { airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
}

function parseAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a) return null;
  return {
    typeCode: a.icao_type || null,
    typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
    registration: a.registration || null,
  };
}

export async function lookupAdsbdb(kind, key) {
  const cacheKey = `adsbdb:${kind}:${key}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached.data;

  try {
    const url = kind === 'route'
      ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
      : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (res.ok) {
      const json = await res.json();
      const data = kind === 'route' ? parseRoute(json) : parseAircraft(json);
      await cache.set(cacheKey, { data }, TTL_S);
      return data;
    }
    if (res.status === 404) {
      await cache.set(cacheKey, { data: null }, TTL_S); // negative cache
      return null;
    }
    return null; // other statuses: don't cache, retry next time
  } catch {
    return null;
  }
}
