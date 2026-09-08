// GET /api/gbfs/<encoded-upstream-URL> — GBFS bike-share proxy with host
// allowlisting, path restriction, HTTPS enforcement, and a size cap.
import { fetchWithTimeout } from '../_lib/http.js';

const GBFS_PROXY_TIMEOUT_MS = 12000;
const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024;

const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
]);

function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

function gbfsCacheControl(pathname) {
  if (/\/station_information\.json$/i.test(String(pathname || ''))) return 'public, max-age=300';
  return 'no-store';
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const encodedTarget = String(req.query?.target || '');
    if (!encodedTarget) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
      return;
    }

    let decodedTarget = '';
    try { decodedTarget = decodeURIComponent(encodedTarget); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
      return;
    }

    let upstreamUrl = null;
    try { upstreamUrl = new URL(decodedTarget); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
      return;
    }

    if (upstreamUrl.protocol !== 'https:') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Only https GBFS targets are allowed' }));
      return;
    }
    if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
      return;
    }
    if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Only station_information/station_status endpoints are allowed' }));
      return;
    }

    let upstream;
    try {
      upstream = await fetchWithTimeout(upstreamUrl.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-view-gbfs-proxy/1.0' },
      }, GBFS_PROXY_TIMEOUT_MS);
    } catch (error) {
      if (error?.name === 'AbortError') {
        res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
        return;
      }
      throw error;
    }

    const contentLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > GBFS_MAX_BODY_BYTES) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const body = await upstream.text();
    if (Buffer.byteLength(body, 'utf8') > GBFS_MAX_BODY_BYTES) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'GBFS upstream response too large' }));
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
      'X-GBFS-Upstream': upstreamUrl.hostname,
      'X-GBFS-Cache': 'MISS',
    });
    res.end(body);
  } catch (error) {
    console.error('[GBFS Proxy]', error?.message || String(error));
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'GBFS proxy error' }));
  }
}
