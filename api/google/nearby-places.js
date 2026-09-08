// GET /api/google/nearby-places?lat=&lon=&radiusM= — nearby Google place
// labels for Realtime scene context.
import { keylessGooglePlacesResponse, placeContextPriority, approximateDistanceM } from '../_lib/googlePlaces.js';
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
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Valid lat and lon are required', places: [] }));
    return;
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress',
          'places.location', 'places.primaryType', 'places.primaryTypeDisplayName', 'places.types',
        ].join(','),
      },
      body: JSON.stringify({
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusM } },
      }),
    });
    const data = await response.json().catch(() => ({}));
    const seenPlaces = new Set();
    const places = Array.isArray(data.places) ? data.places
      .map((place) => {
        const placeLatitude = place.location?.latitude ?? null;
        const placeLongitude = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        return {
          id: place.id || null,
          name: place.displayName?.text || null,
          address: place.shortFormattedAddress || place.formattedAddress || null,
          latitude: placeLatitude,
          longitude: placeLongitude,
          distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
          primaryType: place.primaryTypeDisplayName?.text || place.primaryType || null,
          types,
          contextPriority: placeContextPriority(types),
        };
      })
      .filter((place) => {
        const key = `${place.name}:${place.address || ''}`.toLowerCase();
        if (!place.name || seenPlaces.has(key)) return false;
        seenPlaces.add(key);
        return true;
      })
      .sort((a, b) => b.contextPriority - a.contextPriority || a.distanceM - b.distanceM)
      .map(({ contextPriority, ...place }) => place)
      .slice(0, 20) : [];

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
