// GET /api/adsbdb/route/:callsign — callsign -> airline + origin/destination.
import { lookupAdsbdb } from '../../_lib/adsbdb.js';

export default async function handler(req, res) {
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const cs = String(req.query?.callsign || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) return send(400, { error: 'invalid callsign' });
    const data = await lookupAdsbdb('route', cs);
    return send(200, data ? { found: true, ...data } : { found: false });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}
