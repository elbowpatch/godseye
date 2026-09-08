// POST /api/radio/click/:id — best-effort click registration on Radio Browser.
import * as cache from '../../_lib/cache.js';
import { fireRadioClick, RADIO_UUID_RE } from '../../_lib/radio.js';

const CATALOG_KEY = 'radio:catalog';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const id = String(req.query?.id || '').toLowerCase();
  if (!RADIO_UUID_RE.test(id)) {
    sendJson(res, 404, { error: 'Unknown radio station' });
    return;
  }
  const catalog = await cache.get(CATALOG_KEY);
  const known = catalog?.stationIds?.includes(id);
  if (!known) {
    sendJson(res, 404, { error: 'Unknown radio station' });
    return;
  }
  // Awaited (not fire-and-forget like the original): once a serverless
  // function's response ends, Vercel may freeze/recycle it, so a detached
  // promise here is not guaranteed to run to completion.
  await fireRadioClick(id).catch(() => {});
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}
