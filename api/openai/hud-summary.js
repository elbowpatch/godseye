// POST /api/openai/hud-summary — five-word HUD summary via OpenAI Responses API.
// Falls back to a keyless heuristic summary when OPENAI_API_KEY is unset.
import { keylessHudSummaryResponse } from '../../src/hudSummaryResponse.js';
import { openAiRateLimiter, enforceOptInRateLimit } from '../_lib/rateLimit.js';
import { readJsonBody } from '../_lib/http.js';

const OPENAI_HUD_SUMMARY_MODEL_DEFAULT = 'gpt-5-nano';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const context = await readJsonBody(req);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: [
          "Write one concise intelligence-HUD summary for God's Eye View.",
          'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
          'Prefer the clearest named place and include a relevant enabled layer only when useful.',
          'Do not infer from coordinates or invent a place.',
          'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
        ].join(' '),
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractOpenAiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ summary: summary || null, error: response.ok ? null : data.error?.message || 'OpenAI HUD summary request failed' }));
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'OpenAI HUD summary request failed' }));
  }
}
