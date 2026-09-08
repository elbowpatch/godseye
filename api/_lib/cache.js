// Shared cache helper for Vercel serverless functions.
//
// Two tiers:
//  1. In-memory Map — free, but only survives while a given function
//     instance stays warm (no guarantee between invocations/regions).
//  2. Vercel KV (Upstash Redis) — durable, shared across all instances.
//     Enabled automatically when KV_REST_API_URL / KV_REST_API_TOKEN are
//     present (i.e. you've added the Vercel KV integration to the project).
//     Falls back to memory-only silently if not configured, so the app
//     still works without KV — just with weaker cross-instance caching.
//
// Usage:
//   const cache = require('./cache');
//   const hit = await cache.get('opensky:states');
//   await cache.set('opensky:states', data, 15); // ttlSeconds

const mem = new Map(); // key -> { value, expiresAt }

let kv = null;
let kvTried = false;

async function getKv() {
  if (kvTried) return kv;
  kvTried = true;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return null;
  }
  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv;
  } catch {
    kv = null;
  }
  return kv;
}

function memGet(key) {
  const hit = mem.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return hit.value;
}

function memSet(key, value, ttlSeconds) {
  mem.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
  });
}

async function get(key) {
  const local = memGet(key);
  if (local !== undefined) return local;
  const client = await getKv();
  if (!client) return undefined;
  try {
    const value = await client.get(key);
    if (value !== null && value !== undefined) {
      memSet(key, value, 10); // short local mirror to cut KV round trips
      return value;
    }
  } catch {
    /* KV unavailable — behave as a cache miss */
  }
  return undefined;
}

async function set(key, value, ttlSeconds) {
  memSet(key, value, ttlSeconds);
  const client = await getKv();
  if (!client) return;
  try {
    if (ttlSeconds) {
      await client.set(key, value, { ex: ttlSeconds });
    } else {
      await client.set(key, value);
    }
  } catch {
    /* best effort — memory cache still holds it for this instance */
  }
}

export { get, set };
