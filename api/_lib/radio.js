// Shared Radio Browser (radio-browser.info) helpers.
//
// SIMPLIFICATION NOTE: the original dev-server proxy DNS-pins every outbound
// request (resolves the mirror hostname once, then connects to that pinned
// IP directly) as defense-in-depth against DNS-rebinding attacks on a
// long-lived Node process. That's overkill for a short-lived serverless
// function making a handful of fetches to a small, regex-validated allowlist
// of *.api.radio-browser.info hosts, so this port uses plain fetch() to
// those same allowlisted origins instead. The origin/path allowlisting
// itself (radioProxyDestination) is preserved.
import { readResponseTextCapped } from './overpass.js';
import { normalizeRadioCountryInput } from '../../src/data/radioCountry.js';

export const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

export const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADIO_FETCH_TIMEOUT_MS = 12_000;
const RADIO_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RADIO_USER_AGENT = 'GodsEyeView/1.0 (Radio Browser directory client, Vercel)';

function cleanRadioText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return null;
    if (
      hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || isNonGlobalIpv4(hostname) || hostname.includes(':')
    ) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function normalizeRadioBrowserStation(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id) || Number(raw?.lastcheckok) !== 1 || Number(raw?.hls) === 1
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lon) || lon < -180 || lon > 180
    || !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec)
    || !streamUrl
  ) return null;

  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '').split(',')
    .map((tag) => cleanRadioText(tag, 80).toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).filter((tag, index, all) => all.indexOf(tag) === index).slice(0, 24);
  const languages = String(raw?.language ?? '').split(',').map((l) => cleanRadioText(l, 40)).filter(Boolean).slice(0, 8);
  const rawCountryCode = cleanRadioText(raw?.countrycode, 2).toUpperCase();
  const normalizedCode = normalizeRadioCountryInput(rawCountryCode);
  const normalizedCountry = normalizedCode.valid && !normalizedCode.empty ? normalizedCode : normalizeRadioCountryInput(cleanRadioText(raw?.country, 80));
  const bitrate = Number(raw?.bitrate);
  return {
    id, name, lat, lon, streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage),
    tags, languages,
    state: cleanRadioText(raw?.state, 80),
    country: normalizedCountry.valid && !normalizedCountry.empty ? normalizedCountry.name : cleanRadioText(raw?.country, 80),
    countryCode: normalizedCountry.valid ? normalizedCountry.code : '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  };
}

export function publicRadioStation(station) {
  const { clickCount, ...rest } = station;
  return rest;
}

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

function radioProxyDestination(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const origin = radioMirrorOrigin(url.hostname);
  if (!origin || url.origin !== origin || url.username || url.password || url.port || url.hash) return null;
  const discovery = url.hostname.toLowerCase() === 'all.api.radio-browser.info' && url.pathname === '/json/servers' && !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

async function fetchJson(url, maxBytes = RADIO_RESPONSE_MAX_BYTES) {
  const destination = radioProxyDestination(url);
  if (!destination) throw new Error('Radio Browser destination is not permitted');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RADIO_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(destination.href, {
      headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) throw new Error('Radio Browser redirects are refused');
    if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`);
    const text = await readResponseTextCapped(response, maxBytes);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function mirrors() {
  try {
    const rows = await fetchJson('https://all.api.radio-browser.info/json/servers', 256 * 1024);
    const discovered = [...new Set((Array.isArray(rows) ? rows : []).map((row) => radioMirrorOrigin(row?.name)).filter(Boolean))];
    if (discovered.length) return [...discovered, ...RADIO_FALLBACK_MIRRORS.filter((o) => !discovered.includes(o))];
  } catch { /* fall through to static mirrors */ }
  return [...RADIO_FALLBACK_MIRRORS];
}

async function fetchPath(pathname) {
  let lastError = null;
  for (const origin of await mirrors()) {
    try { return await fetchJson(`${origin}${pathname}`); } catch (error) { lastError = error; }
  }
  throw lastError || new Error('No Radio Browser mirror is available');
}

async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const RADIO_DIRECTORY_LIMIT = 750;
const RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES = 5;
const RADIO_CATALOG_HEALTHY_MIN_STATIONS = Math.ceil(RADIO_DIRECTORY_LIMIT / 2);

export async function buildRadioCatalog() {
  const queries = [null, 'news', 'talk', 'weather', 'emergency', 'scanner', 'aviation', 'marine', 'traffic'];
  const outcomes = await mapRadioConcurrent(queries, 3, async (tag, index) => {
    const params = new URLSearchParams({
      has_geo_info: 'true', is_https: 'true', hidebroken: 'true',
      order: 'clickcount', reverse: 'true', limit: index === 0 ? '1800' : '220',
    });
    if (tag) params.set('tag', tag);
    try {
      const rows = await fetchPath(`/json/stations/search?${params}`);
      if (!Array.isArray(rows)) throw new Error('Radio Browser catalog payload was not an array');
      if (!rows.every((row) => (
        row && typeof row === 'object' && !Array.isArray(row)
        && typeof row.stationuuid === 'string' && typeof row.name === 'string'
        && (typeof row.url_resolved === 'string' || typeof row.url === 'string')
      ))) throw new Error('Radio Browser catalog contained a malformed station row');
      const stations = rows.map(normalizeRadioBrowserStation).filter(Boolean);
      const requestedTag = cleanRadioText(tag, 80).toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      const requestedTagCovered = !requestedTag || stations.some((s) => s.tags.some((t) => t === requestedTag || t.includes(requestedTag)));
      return { succeeded: stations.length > 0 && requestedTagCovered, stations };
    } catch {
      return { succeeded: false, stations: [] };
    }
  });
  const resultSets = outcomes.map((outcome) => outcome.stations);
  const selected = [];
  const seen = new Set();
  const take = (station) => {
    if (!station || seen.has(station.id) || selected.length >= RADIO_DIRECTORY_LIMIT) return;
    seen.add(station.id);
    selected.push(station);
  };
  for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
  resultSets.flat().sort((a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name)).forEach(take);

  const timestamp = Date.now();
  const successfulQueries = outcomes.filter((o) => o.succeeded).length;
  const broadQueryHealthy = outcomes[0].succeeded && outcomes[0].stations.length > 0;
  const healthReasons = [];
  if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
  if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES) healthReasons.push('query-coverage-below-policy');
  if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS) healthReasons.push('station-coverage-below-policy');
  const degraded = healthReasons.length > 0;
  const coverage = { successfulQueries, totalQueries: queries.length, stationCount: selected.length, healthyStationMinimum: RADIO_CATALOG_HEALTHY_MIN_STATIONS };

  return {
    cachedAt: timestamp,
    updatedAt: new Date(timestamp).toISOString(),
    stations: selected.map(publicRadioStation),
    stationIds: selected.map((s) => s.id),
    degraded,
    degradedReason: degraded ? healthReasons.join(',') : null,
    coverage,
  };
}

export async function fireRadioClick(id) {
  try { await fetchPath(`/json/url/${id}`); } catch { /* best-effort */ }
}
