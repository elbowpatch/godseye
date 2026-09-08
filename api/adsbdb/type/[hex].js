// GET /api/adsbdb/type/:hex — icao24 hex -> aircraft type/registration.
import { lookupAdsbdb } from '../../_lib/adsbdb.js';

export default async function handler(req, res) {
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const hex = String(req.query?.hex || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return send(400, { error: 'invalid hex' });
    const data = await lookupAdsbdb('aircraft', hex);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}
