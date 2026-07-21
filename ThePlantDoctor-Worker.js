/**
 * The Plant Doctor — Cloudflare Worker Proxy (Pl@ntNet + Gemini backend — free tier)
 *
 * SETUP (one-time, ~5 minutes):
 * ──────────────────────────────
 * 1. Get a free Pl@ntNet API key (500 identifications/day, no credit card required):
 *    https://my.plantnet.org
 * 2. Get a free Gemini API key (no credit card required):
 *    https://aistudio.google.com/apikey
 * 3. Go to https://workers.cloudflare.com  →  sign up free
 * 4. Click "Create a Worker"
 * 5. Delete all existing code in the editor and paste THIS entire file
 * 6. Click "Save and Deploy"
 * 7. Copy your Worker URL (looks like: https://plant-doctor.YOURNAME.workers.dev)
 *
 * ADD YOUR API KEYS AS SECRETS:
 * 8. In the Worker dashboard → click "Settings" tab → "Variables and Secrets"
 * 9. Click "Add" twice →
 *    Name:  PLANTNET_API_KEY   Value: your key from my.plantnet.org
 *    Name:  GEMINI_API_KEY     Value: your key from aistudio.google.com/apikey
 * 10. Save (encrypted) and redeploy if prompted.
 *
 * PASTE YOUR WORKER URL INTO THE APP:
 * 11. Open index.html → Settings → "AI Proxy (Worker URL)", paste the URL from step 6.
 *     Done — plant identification and AI-enhanced care tips both run through this
 *     one Worker; neither key ever reaches the browser.
 */

// Newer flagship Gemini models often ship with very tight free-tier quotas,
// so a busy key can get "high demand" on every single call, not just an
// occasional spike. Retrying the same model won't help with that.
// Fall back through progressively more available models instead.
const MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const RETRY_DELAYS_MS = [1000, 2000];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function isRetryableGeminiError(status, message) {
  if (status === 429 || status === 503) return true;
  const m = (message || '').toLowerCase();
  return m.includes('overloaded') || m.includes('high demand') || m.includes('unavailable');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiModel(model, geminiBody, apiKey) {
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(geminiBody)
    }
  );

  const upstreamData = await upstream.json();

  if (upstream.ok) {
    return { ok: true, data: upstreamData };
  }

  const status = upstream.status;
  const message = upstreamData.error?.message || `Gemini error (HTTP ${status})`;
  return { ok: false, status, message };
}

async function callGeminiWithRetry(geminiBody, apiKey) {
  let lastResult;

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const result = await callGeminiModel(model, geminiBody, apiKey);

      if (result.ok) return result;

      lastResult = result;

      if (attempt < RETRY_DELAYS_MS.length && isRetryableGeminiError(result.status, result.message)) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
    // If the last model's failure wasn't demand-related (e.g. bad request,
    // blocked content), there's no reason to expect a different model to help.
    if (!isRetryableGeminiError(lastResult.status, lastResult.message)) break;
  }

  return lastResult;
}

// ── /identify — plant photo(s) → Pl@ntNet species ID ──
// Pure passthrough: forward the client's multipart form straight to Pl@ntNet
// with our own secret key appended, and hand back Pl@ntNet's response as-is
// so the existing client-side parsePlantNetResponse() needs no changes.
async function handleIdentify(request, env, url) {
  if (!env.PLANTNET_API_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Pl@ntNet API key not configured in Worker secrets. See setup instructions.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }

  const nbResults = url.searchParams.get('nb-results') || '6';
  const lang = url.searchParams.get('lang') || 'en';
  const plantnetUrl = `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(env.PLANTNET_API_KEY)}&nb-results=${encodeURIComponent(nbResults)}&lang=${encodeURIComponent(lang)}`;

  const form = await request.formData();
  const upstream = await fetch(plantnetUrl, { method: 'POST', body: form });
  const text = await upstream.text();

  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ── /care — region-specific care tips via Gemini ──
// Accepts the same {max_tokens, messages:[{role:'user',content:[{type:'text',text}]}]}
// shape the client already builds, and replies in the same {content:[{type:'text',text}]}
// envelope it already parses — only the transport changes, not the client's JSON handling.
async function handleCare(request, env) {
  if (!env.GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({ error: { message: 'Gemini API key not configured in Worker secrets. See setup instructions.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }

  try {
    const body = await request.json();

    const userMessage = body.messages?.[0];
    const blocks = Array.isArray(userMessage?.content) ? userMessage.content : [];
    const textBlock = blocks.find(b => b.type === 'text');

    if (!textBlock) {
      return new Response(
        JSON.stringify({ error: { message: 'Request missing text content.' } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    const geminiBody = {
      contents: [{ parts: [{ text: textBlock.text }] }],
      generationConfig: {
        maxOutputTokens: body.max_tokens || 1200,
        // This is a short, deterministic JSON-extraction task, not a reasoning
        // task, so thinking is turned off entirely (budget 0) rather than just
        // hidden — otherwise the model's reasoning tokens eat most of
        // maxOutputTokens and can leak into the answer as plain text on
        // thinking-capable models. includeThoughts:false is kept as a
        // defensive backup in case a future model can't fully disable thinking.
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false }
      }
    };

    const result = await callGeminiWithRetry(geminiBody, env.GEMINI_API_KEY);

    if (!result.ok) {
      return new Response(
        JSON.stringify({ error: { message: result.message } }),
        { status: result.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    const upstreamData = result.data;
    // Defense-in-depth: drop any part explicitly marked as a thought, even
    // though thinkingConfig above should prevent them from appearing at all.
    const text = (upstreamData.candidates?.[0]?.content?.parts || [])
      .filter(p => !p.thought)
      .map(p => p.text || '').join('');

    if (!text) {
      const blockReason = upstreamData.promptFeedback?.blockReason;
      return new Response(
        JSON.stringify({ error: { message: blockReason ? `Gemini blocked the request: ${blockReason}` : 'Gemini returned an empty response.' } }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    return new Response(
      JSON.stringify({ content: [{ type: 'text', text }] }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err.message || 'Worker error' } }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      }
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/identify') {
      return handleIdentify(request, env, url);
    }
    if (url.pathname === '/care') {
      return handleCare(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};
