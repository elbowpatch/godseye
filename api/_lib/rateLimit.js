// Opt-in per-IP + global rate limiters for the paid-endpoint proxies
// (OpenAI, Google Places). Best-effort only — state lives in module memory,
// so it resets whenever a serverless instance cold-starts and does not
// coordinate across concurrent instances the way the single dev-server
// process did. Set the relevant GEV_RATELIMIT_*_PER_MIN env var to enable.
import { makeRateLimiter } from './overpass.js';

function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null;
  return makeRateLimiter({ windowMs: 60_000, max: Math.floor(max), globalMax: Math.floor(max) * 20 });
}

let _openAiRateLimiter;
let _googleRateLimiter;

export function openAiRateLimiter() {
  if (_openAiRateLimiter === undefined) _openAiRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_OPENAI_PER_MIN);
  return _openAiRateLimiter;
}

export function googleRateLimiter() {
  if (_googleRateLimiter === undefined) _googleRateLimiter = makeOptInRateLimiter(process.env.GEV_RATELIMIT_GOOGLE_PER_MIN);
  return _googleRateLimiter;
}

export function clientKey(req) {
  return String(req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'anon');
}

export function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter) return true;
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}
