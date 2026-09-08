#!/usr/bin/env node
// AIS live-vessel relay — a small always-on Node service.
//
// WHY THIS EXISTS: AISStream (wss://stream.aisstream.io) allows exactly one
// WebSocket connection per API key and expects it to stay open indefinitely.
// Vercel serverless functions are stateless and short-lived, so they cannot
// hold that connection — this relay does, and exposes the accumulated vessel
// state over plain HTTP so /api/ais-live on Vercel can just proxy to it.
//
// Deploy this ANYWHERE that runs a persistent Node process: Fly.io, Railway,
// Render, a small VPS, even a spare Raspberry Pi. It needs no database and no
// inbound traffic beyond the two HTTP routes below.
//
// Routes:
//   GET /ais-live              -> { rows, source, status, error, refreshing, ... }
//   GET /ais-live/track?mmsi=  -> { mmsi, samples, source, retainedSec }
//
// Env vars:
//   AISSTREAM_API_KEY          (required) — from https://aisstream.io
//   AISSTREAM_BOUNDING_BOXES   (optional) — JSON, e.g. [[[24,-10],[60,40]]]
//   AISSTREAM_MESSAGE_TYPES    (optional) — CSV or JSON array
//   AISSTREAM_SILENCE_TIMEOUT_MS (optional) — 0 disables the silence watchdog
//   PORT                       (optional, default 8080)
//   RELAY_TOKEN                (optional) — if set, requests must send
//                               `Authorization: Bearer <token>` (recommended
//                               for anything reachable on the public internet)

import http from 'node:http';
import { createHash, createRequire } from 'node:crypto';
import { createAisStreamAdapter, isRecognizedAisEnvelope } from './aisStreamAdapter.js';
import { parseSilenceTimeoutEnv } from './aisWatchdog.js';

const require = createRequire(import.meta.url);

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const AISSTREAM_DEFAULT_BBOXES = [[[-90, -180], [90, 180]]];
const AISSTREAM_DEFAULT_MESSAGE_TYPES = [
  'PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport',
  'ShipStaticData', 'StaticDataReport',
];
const AISSTREAM_CACHE_MAX = 50000;
const AISSTREAM_STALE_MS = 30 * 60 * 1000;
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
const AISSTREAM_SILENCE_REPORT_MS = 120_000;
const AISSTREAM_RECYCLE_RATIO = 2.5;
const AISSTREAM_BACKOFF_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);
const AISSTREAM_DOWN_RETRY_MS = 900_000;
const AISSTREAM_AUTH_PROBE_MS = 3_600_000;
const AISSTREAM_TICK_MS = 15_000;
const PORT = Number(process.env.PORT) || 8080;

const _aisStreamVessels = new Map();
const _aisStreamStatic = new Map();
const _aisStreamTracks = new Map();
const _aisStreamTrackPending = new Map();
let _aisAdapter = null;
let _aisWatchdogPolicy = null;
let _aisStreamTickTimer = null;
let _aisWebSocketImpl;

function aisWebSocketImpl() {
  if (_aisWebSocketImpl !== undefined) return _aisWebSocketImpl;
  try {
    _aisWebSocketImpl = require('ws');
  } catch (error) {
    _aisWebSocketImpl = null;
    console.warn('[AISStream] `ws` is unavailable; the live vessel feed is off.', error?.message || '');
  }
  return _aisWebSocketImpl;
}

function parseJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { console.warn(`[AISStream] Invalid ${key}; using default.`); return fallback; }
}

function parseCsvOrJsonEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function stringValue(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}
function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function aisStreamSubscription() {
  return {
    APIKey: process.env.AISSTREAM_API_KEY,
    BoundingBoxes: parseJsonEnv('AISSTREAM_BOUNDING_BOXES', AISSTREAM_DEFAULT_BBOXES),
    FilterMessageTypes: parseCsvOrJsonEnv('AISSTREAM_MESSAGE_TYPES', AISSTREAM_DEFAULT_MESSAGE_TYPES),
  };
}

function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(metadata.ShipName ?? message.Name ?? message.ShipName ?? message.ReportA?.Name ?? staticData.name);
}
function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(message.Type ?? message.ShipType ?? message.ReportB?.ShipType ?? staticData.type);
}
function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
  const existing = _aisStreamVessels.get(mmsi);
  if (!existing) return;
  if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`)) existing.name = staticData.name;
  if (staticData.type && !existing.type) existing.type = staticData.type;
  if (staticData.destination && !existing.destination) existing.destination = staticData.destination;
  if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
}

function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

function appendAisTrackSample(mmsi, lat, lon, epochSec) {
  let track = _aisStreamTracks.get(mmsi);
  if (!track) {
    const pending = _aisStreamTrackPending.get(mmsi);
    if (!pending) { _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec }); return; }
    if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
    if (approxMetersBetween(pending.lat, pending.lon, lat, lon) < AIS_TRACK_MIN_MOVE_M) return;
    track = { lats: new Float32Array(AIS_TRACK_SAMPLES), lons: new Float32Array(AIS_TRACK_SAMPLES), times: new Uint32Array(AIS_TRACK_SAMPLES), head: 0, len: 0 };
    _aisStreamTracks.set(mmsi, track);
    _aisStreamTrackPending.delete(mmsi);
    writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
    writeAisTrackSample(track, lat, lon, epochSec);
    return;
  }
  const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  if (epochSec - track.times[lastIdx] < AIS_TRACK_MIN_GAP_SEC) return;
  if (approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) < AIS_TRACK_MIN_MOVE_M) return;
  writeAisTrackSample(track, lat, lon, epochSec);
}

function readAisTrack(mmsi) {
  const track = _aisStreamTracks.get(mmsi);
  if (!track || !track.len) return [];
  const samples = [];
  const start = (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  for (let i = 0; i < track.len; i++) {
    const idx = (start + i) % AIS_TRACK_SAMPLES;
    samples.push({ lat: track.lats[idx], lon: track.lons[idx], t: track.times[idx] });
  }
  return samples;
}

function pruneAisStreamCache() {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  for (const [mmsi, row] of _aisStreamVessels) {
    if (row._updatedAt < cutoff) { _aisStreamVessels.delete(mmsi); _aisStreamTracks.delete(mmsi); _aisStreamTrackPending.delete(mmsi); }
  }
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec) _aisStreamTrackPending.delete(mmsi);
  }
  if (_aisStreamVessels.size <= AISSTREAM_CACHE_MAX) return;
  const ordered = [..._aisStreamVessels.entries()].sort((a, b) => a[1]._updatedAt - b[1]._updatedAt);
  for (const [mmsi] of ordered.slice(0, _aisStreamVessels.size - AISSTREAM_CACHE_MAX)) {
    _aisStreamVessels.delete(mmsi); _aisStreamTracks.delete(mmsi); _aisStreamTrackPending.delete(mmsi);
  }
}

function ingestAisStreamEnvelope(envelope) {
  if (!isRecognizedAisEnvelope(envelope)) return false;
  const messageType = envelope?.MessageType;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const mmsi = stringValue(metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi);
  if (!mmsi) return false;

  if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
    const staticData = {
      name: vesselNameFromAis(metadata, message, _aisStreamStatic.get(mmsi)),
      type: vesselTypeFromAis(message, _aisStreamStatic.get(mmsi)),
      destination: stringValue(message.Destination),
      imo: stringValue(message.ImoNumber ?? message.IMO),
    };
    _aisStreamStatic.set(mmsi, staticData);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
  }

  const lat = numberValue(metadata.latitude ?? metadata.Latitude ?? message.Latitude);
  const lon = numberValue(metadata.longitude ?? metadata.Longitude ?? message.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;

  const staticData = _aisStreamStatic.get(mmsi) || {};
  _aisStreamVessels.set(mmsi, {
    lat, lon,
    name: vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`,
    mmsi,
    imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
    type: vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    speed: numberValue(message.Sog ?? message.SOG),
    course: numberValue(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    last_position_UTC: normalizeAisTimestamp(metadata.time_utc ?? metadata.TimeUtc),
    last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    _updatedAt: Date.now(),
  });
  appendAisTrackSample(mmsi, lat, lon, aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc));
  pruneAisStreamCache();
  return true;
}

function aisStreamRows(maxRows) {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  const rows = [];
  for (const row of _aisStreamVessels.values()) if (row._updatedAt >= cutoff) rows.push(row);
  rows.sort((a, b) => b._updatedAt - a._updatedAt);
  return rows.slice(0, maxRows).map(({ _updatedAt, ...row }) => row);
}
function newestAisPositionAt(rows) { return rows[0]?.last_position_UTC || null; }

function aisWatchdogPolicy() {
  if (_aisWatchdogPolicy) return _aisWatchdogPolicy;
  const customSubscription = Boolean(process.env.AISSTREAM_BOUNDING_BOXES || process.env.AISSTREAM_MESSAGE_TYPES);
  const override = parseSilenceTimeoutEnv(process.env.AISSTREAM_SILENCE_TIMEOUT_MS, (msg) => console.warn(msg));
  const reportMs = override.kind === 'timeout' ? override.value : AISSTREAM_SILENCE_REPORT_MS;
  _aisWatchdogPolicy = {
    silenceWatch: override.kind === 'off' ? false : (override.kind === 'timeout' || !customSubscription),
    reportMs,
    recycleMs: Math.round(reportMs * AISSTREAM_RECYCLE_RATIO),
    url: process.env.AISSTREAM_URL || AISSTREAM_URL,
  };
  return _aisWatchdogPolicy;
}

function aisWatchdogBudgets() {
  const policy = aisWatchdogPolicy();
  return { staleMs: policy.reportMs, recycleAfterMs: policy.recycleMs, backoffMs: [...AISSTREAM_BACKOFF_MS], downRetryMs: AISSTREAM_DOWN_RETRY_MS, authProbeMs: AISSTREAM_AUTH_PROBE_MS };
}

function aisAdapter() {
  if (_aisAdapter) return _aisAdapter;
  _aisAdapter = createAisStreamAdapter({
    createSocket: (url) => {
      const WebSocketCtor = aisWebSocketImpl();
      if (!WebSocketCtor) throw new Error('ws transport unavailable');
      return new WebSocketCtor(url);
    },
    resolveUrl: () => aisWatchdogPolicy().url,
    buildSubscription: aisStreamSubscription,
    ingestEnvelope: ingestAisStreamEnvelope,
    warn: (message) => console.warn(message),
  });
  _aisAdapter.setWatchdogOptions(aisWatchdogBudgets());
  return _aisAdapter;
}

function aisKeyFingerprint() {
  const key = process.env.AISSTREAM_API_KEY;
  return key ? createHash('sha256').update(String(key)).digest('hex').slice(0, 12) : null;
}

function ensureAisStreamConnection() {
  const adapter = aisAdapter();
  const policy = aisWatchdogPolicy();
  adapter.ensure({
    hasKey: Boolean(process.env.AISSTREAM_API_KEY),
    hasTransport: Boolean(aisWebSocketImpl()),
    silenceWatch: policy.silenceWatch,
    keyFingerprint: aisKeyFingerprint(),
  });
}

function aisStreamStatusSnapshot() {
  const snapshot = _aisAdapter ? _aisAdapter.snapshot() : null;
  if (snapshot) return snapshot;
  return {
    status: process.env.AISSTREAM_API_KEY ? 'idle' : 'missing-key',
    error: process.env.AISSTREAM_API_KEY ? null : 'AISSTREAM_API_KEY is not set',
    lastMessageAt: null, silentForMs: null, reconnectAttempt: 0, nextAttemptAt: null,
    watchdog: 'armed', staleAfterMs: AISSTREAM_SILENCE_REPORT_MS,
  };
}

function startAisStreamWatchdogTick() {
  if (_aisStreamTickTimer) return;
  _aisStreamTickTimer = setInterval(() => {
    try { ensureAisStreamConnection(); } catch (error) { console.warn('[AISStream] watchdog tick failed', error?.message || ''); }
  }, AISSTREAM_TICK_MS);
  _aisStreamTickTimer.unref?.();
}

// --- HTTP server -----------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const token = process.env.RELAY_TOKEN;
  if (!token) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}`;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }

    ensureAisStreamConnection();

    if (url.pathname === '/ais-live/track') {
      const mmsi = String(url.searchParams.get('mmsi') || '').trim();
      if (!/^\d{5,10}$/.test(mmsi)) { sendJson(res, 400, { error: 'mmsi query param required', samples: [] }); return; }
      sendJson(res, 200, { mmsi, samples: readAisTrack(mmsi), source: 'AISStream (accumulated since relay start)', retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000) });
      return;
    }

    if (url.pathname === '/ais-live') {
      const maxRows = clampInt(url.searchParams.get('maxRows'), 1, AISSTREAM_CACHE_MAX, AISSTREAM_CACHE_MAX);
      const rows = aisStreamRows(maxRows);
      const feed = aisStreamStatusSnapshot();
      sendJson(res, process.env.AISSTREAM_API_KEY ? 200 : 503, {
        rows, source: 'AISStream', status: feed.status, error: feed.error,
        refreshing: feed.status !== 'live', newestPositionAt: newestAisPositionAt(rows),
        lastMessageAt: feed.lastMessageAt, silentForMs: feed.silentForMs,
        reconnectAttempt: feed.reconnectAttempt, nextAttemptAt: feed.nextAttemptAt,
        staleAfterMs: feed.staleAfterMs, watchdog: feed.watchdog,
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 502, { error: error?.message || 'AIS relay error', rows: [] });
  }
});

server.listen(PORT, () => {
  console.log(`[AIS relay] listening on :${PORT}`);
  if (!process.env.AISSTREAM_API_KEY) console.warn('[AIS relay] AISSTREAM_API_KEY is not set — the feed will stay idle.');
  if (!process.env.RELAY_TOKEN) console.warn('[AIS relay] RELAY_TOKEN is not set — anyone who can reach this port can read vessel data. Set RELAY_TOKEN if this is publicly reachable.');
  ensureAisStreamConnection();
  startAisStreamWatchdogTick();
});
