// GET /api/cctv/stream/:id — stream info (feedType, URLs) for a camera.
import { getCctvSources, buildStreamPayload } from '../../_lib/cctv.js';

export default async function handler(req, res) {
  try {
    const sources = await getCctvSources();
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const cameraId = decodeURIComponent(String(req.query?.id || '')).trim() || 'camera';
    const payload = buildStreamPayload(sourceById.get(cameraId), cameraId);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CCTV proxy error' }));
  }
}
