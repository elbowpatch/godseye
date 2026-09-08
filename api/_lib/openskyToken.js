// Shared OpenSky OAuth2 client-credentials token fetch — used by both
// /api/opensky (states/all) and /api/opensky-track (tracks/all).
import * as cache from './cache.js';
import { fetchWithTimeout } from './http.js';

export async function getOpenSkyToken() {
  const tokenState = (await cache.get('opensky:token')) || null;
  const now = Date.now();
  if (tokenState?.token && now < tokenState.expiresAt - 60000) return tokenState.token;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetchWithTimeout(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
      },
      10000,
    );
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const accessToken = data?.access_token;
    const expiresIn = Number(data?.expires_in);
    if (!res.ok || !accessToken) {
      console.warn('[OpenSky] OAuth client_credentials failed:', data?.error_description || data?.error || `HTTP ${res.status}`);
      return null;
    }
    const expiresAt = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
    await cache.set('opensky:token', { token: accessToken, expiresAt }, Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)));
    return accessToken;
  } catch (err) {
    console.warn('[OpenSky] OAuth token request failed:', err?.message || String(err));
    return null;
  }
}

