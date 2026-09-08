// GET /api/cctv/frame/:id — single frame with fallback chain:
// configured upstream image -> Google Street View -> synthetic SVG.
import { getCctvSources, isVideoFeedType, normalizeFeedType, fetchCctvImageFromUpstream, streetViewFallback, buildSyntheticCctvSvg, setCctvHealth } from '../../_lib/cctv.js';

export default async function handler(req, res) {
  try {
    const sources = await getCctvSources();
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const cameraId = decodeURIComponent(String(req.query?.id || '')).trim() || 'camera';
    const source = sourceById.get(cameraId);

    const incoming = new URL(req.url, 'http://localhost');
    const label = incoming.searchParams.get('label') || source?.name || cameraId;
    const city = incoming.searchParams.get('city') || source?.city || '';
    const lat = Number(incoming.searchParams.get('lat') || source?.lat);
    const lon = Number(incoming.searchParams.get('lon') || source?.lon);
    const heading = Number(incoming.searchParams.get('heading') || source?.headingDeg);
    const fov = Number(incoming.searchParams.get('fov') || source?.fovDeg);
    const pitch = Number(incoming.searchParams.get('pitch') || source?.pitchDeg);

    // Only server-registered upstream URLs — never a client-supplied URL (no SSRF via ?upstream=).
    const upstreamCandidate = source?.snapshotUrl || (!isVideoFeedType(normalizeFeedType(source?.feedType)) ? source?.url : '');

    const upstreamImage = await fetchCctvImageFromUpstream(upstreamCandidate);
    if (upstreamImage?.ok) {
      setCctvHealth(cameraId, { status: 'ok', sourceKind: 'snapshot', label: source?.provider || 'Configured source', message: 'Upstream snapshot active' });
      res.writeHead(200, { 'Content-Type': upstreamImage.contentType, 'Cache-Control': 'no-store', 'X-CCTV-Source': 'upstream-image' });
      res.end(upstreamImage.body);
      return;
    }

    const sv = await streetViewFallback({ lat, lon, heading, fov, pitch });
    if (sv?.ok) {
      setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'streetview', label: 'Google Street View', message: 'Fallback Street View frame' });
      res.writeHead(200, { 'Content-Type': sv.contentType, 'Cache-Control': 'no-store', 'X-CCTV-Source': 'streetview' });
      res.end(sv.body);
      return;
    }

    const svg = buildSyntheticCctvSvg({ cameraId, label, city, status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED' });
    setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'synthetic', label: source?.provider || 'Synthetic fallback', message: source?.url ? 'Upstream unavailable' : 'No source configured' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-CCTV-Source': 'synthetic' });
    res.end(svg);
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}
