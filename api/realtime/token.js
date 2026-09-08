// GET/POST /api/realtime/token — mints an OpenAI Realtime ephemeral client
// secret for GEV Voice Control (browser never sees OPENAI_API_KEY).
import { VOICE_MODELS, isKnownVoiceTier, resolveVoiceModel } from '../../src/voice/voiceCost.js';
import { GEV_REALTIME_TOOLS } from '../_lib/realtimeTools.js';
import { GEV_VOICE_INSTRUCTIONS } from '../_lib/voiceInstructions.js';
import { openAiRateLimiter, enforceOptInRateLimit } from '../_lib/rateLimit.js';

export const config = { maxDuration: 15 };

const OPENAI_REALTIME_MODEL_DEFAULT = VOICE_MODELS.standard.id;
const OPENAI_REALTIME_MODEL_MINI_DEFAULT = VOICE_MODELS.mini.id;
const OPENAI_REALTIME_VOICE_DEFAULT = 'marin';
const OPENAI_REALTIME_REASONING_DEFAULT = 'low';
const OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT = 3000;
const OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT = 0.5;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
    return;
  }

  const requestedTier = (() => {
    try { return new URL(req.url || '', 'http://localhost').searchParams.get('tier'); } catch { return null; }
  })();
  const tier = resolveVoiceModel(requestedTier).tier;
  const model = tier === 'mini'
    ? process.env.OPENAI_REALTIME_MODEL_MINI || OPENAI_REALTIME_MODEL_MINI_DEFAULT
    : process.env.OPENAI_REALTIME_MODEL || OPENAI_REALTIME_MODEL_DEFAULT;
  const voice = process.env.OPENAI_REALTIME_VOICE || OPENAI_REALTIME_VOICE_DEFAULT;
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || OPENAI_REALTIME_REASONING_DEFAULT;
  const contextTokenLimit = Math.round(Math.max(
    1000,
    Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT),
  ));
  const contextRetentionRatio = Math.max(
    0.1,
    Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT),
  );

  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: contextRetentionRatio,
        token_limits: { post_instructions: contextTokenLimit },
      },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false },
        },
        output: { voice },
      },
      instructions: GEV_VOICE_INSTRUCTIONS,
      tools: GEV_REALTIME_TOOLS,
      tool_choice: 'auto',
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'gev-vercel',
      },
      body: JSON.stringify(sessionConfig),
    });
    const body = await response.text();
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('X-GEV-Voice-Tier', tier);
    res.setHeader('X-GEV-Voice-Model', model);
    if (requestedTier && !isKnownVoiceTier(requestedTier)) {
      res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
    }
    res.end(body);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Failed to create Realtime token' }));
  }
}
