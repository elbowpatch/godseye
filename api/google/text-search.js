// GET /api/google/text-search?q=&lat=&lon=&radiusM= — resolve a named
// landmark/POI to a real coordinate, biased to the current view.
import { keylessGooglePlacesResponse, approximateDistanceM } from '../_lib/googlePlaces.js';
import { googleRateLimiter, clientKey } from '../_lib/rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
    return;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const keyless = keylessGooglePlacesResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  const grl = googleRateLimiter();
  if (grl && !grl(clientKey(req))) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '5');
    res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
    return;
  }

  const requestUrl = new URL(req.url || '', 'http://localhost');
  const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000));
  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'q, lat and lon are required', places: [] }));
    return;
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.viewport', 'places.primaryType', 'places.types'].join(','),
      },
      body: JSON.stringify({
        textQuery,
        locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } },
        maxResultCount: 5,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const places = Array.isArray(data.places) ? data.places
      .map((place) => {
        const placeLatitude = place.location?.latitude ?? null;
        const placeLongitude = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        const vp = place.viewport;
        const viewport = (
          Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
          && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
        ) ? { low: { latitude: vp.low.latitude, longitude: vp.low.longitude }, high: { latitude: vp.high.latitude, longitude: vp.high.longitude } } : null;
        return {
          id: place.id || null,
          name: place.displayName?.text || null,
          address: place.formattedAddress || null,
          latitude: placeLatitude,
          longitude: placeLongitude,
          distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
          primaryType: place.primaryType || null,
          types,
          viewport,
        };
      })
      .filter((place) => place.name) : [];

    res.statusCode = response.ok ? 200 : response.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(JSON.stringify({ places, error: response.ok ? null : data.error?.message || 'Google Places request failed' }));
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error?.message || 'Google Places request failed', places: [] }));
  }
}
