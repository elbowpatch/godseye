// GET /api/cctv/media/:id — proxy live video/image media from the camera's
// configured upstream URL.
import { getCctvSources, normalizeFeedType, isVideoFeedType, proxyMediaResponse, setCctvHealth } from '../../_lib/cctv.js';

export default async function handler(req, res) {
  try {
    const sources = await getCctvSources();
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const cameraId = decodeURIComponent(String(req.query?.id || '')).trim() || 'camera';
    const source = sourceById.get(cameraId);
    const mediaUrl = source?.url || '';
    const feedType = normalizeFeedType(source?.feedType || 'image');

    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
      setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'fallback', label: source?.provider || 'No upstream URL', message: 'No stream URL configured' });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'No media URL configured for this camera' }));
      return;
    }

    try {
      const upstreamHeaders = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
      const requestRange = req.headers?.range;
      if (requestRange) upstreamHeaders.Range = requestRange;
      const upstream = await fetch(mediaUrl, { headers: upstreamHeaders });
      const contentType = upstream.headers.get('content-type') || '';
      if (!upstream.ok) {
        setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'upstream', label: source?.provider || 'Configured source', message: `Upstream HTTP ${upstream.status}` });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: `Upstream returned ${upstream.status}` }));
        return;
      }

      if (isVideoFeedType(feedType) && !(contentType.startsWith('video/') || contentType.includes('mpegurl'))) {
        setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'upstream', label: source?.provider || 'Configured source', message: `Unexpected media type ${contentType || 'unknown'}` });
      } else {
        setCctvHealth(cameraId, {
          status: 'ok',
          sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
          label: source?.provider || 'Configured source',
          message: isVideoFeedType(feedType) ? 'Live stream connected' : 'Snapshot feed connected',
        });
      }
      await proxyMediaResponse(res, upstream, { sourceHeader: isVideoFeedType(feedType) ? 'live-media' : 'upstream-image' });
    } catch (error) {
      setCctvHealth(cameraId, { status: 'degraded', sourceKind: 'upstream', label: source?.provider || 'Configured source', message: error?.message || 'Media fetch failed' });
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Media proxy failed' }));
    }
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}
