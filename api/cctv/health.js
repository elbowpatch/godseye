// GET /api/cctv/health — per-camera health/status report (best-effort,
// resets on cold start — see api/_lib/cctv.js for why).
import { listCctvHealth } from '../_lib/cctv.js';

export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ cameras: listCctvHealth() }));
}
