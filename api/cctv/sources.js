// GET /api/cctv/sources — list all registered CCTV camera sources.
import { getCctvSources, normalizeFeedType } from '../_lib/cctv.js';

export default async function handler(req, res) {
  try {
    const sources = await getCctvSources();
    const body = {
      sources: sources.map((source) => ({
        id: source.id, name: source.name, city: source.city, cityId: source.cityId,
        provider: source.provider, lat: source.lat, lon: source.lon, headingDeg: source.headingDeg,
        headingConfidence: source.headingConfidence || '', pitchDeg: source.pitchDeg, fovDeg: source.fovDeg,
        rangeM: source.rangeM, mountHeightM: source.mountHeightM, groundElevationM: source.groundElevationM,
        feedType: normalizeFeedType(source.feedType), sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
        poseSource: source.poseSource, license: source.license,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}
