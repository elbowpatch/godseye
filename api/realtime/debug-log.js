// POST /api/realtime/debug-log — best-effort voice-session debug log.
//
// The original wrote to a local .gev-logs/*.jsonl file, which doesn't
// persist on Vercel's ephemeral filesystem. This just echoes to the
// function's console log (visible in `vercel logs` / the dashboard) instead
// of failing — it's a debug aid, not a feature the client depends on.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    console.log('[realtime-debug-log]', JSON.stringify({ loggedAt: new Date().toISOString(), ...record }));
    res.statusCode = 204;
    res.end();
  } catch (error) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Failed to write Realtime debug log' }));
  }
}
