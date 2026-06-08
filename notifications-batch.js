// Kitchen Agent — Claude API Proxy (Netlify Function)
// SETUP: In Netlify dashboard → Site settings → Environment variables, add:
//   ANTHROPIC_API_KEY = <your key from console.anthropic.com>
//
// Model routing:
//   task = "meal-plan-skeleton" → Haiku (tiny output, must finish fast)
//   task = "meal-plan-day"      → Sonnet (per-day detail, parallel-safe)
//   task = "meal-plan"          → Sonnet (legacy single-call path)
//   task = "substitution"       → Haiku (one-shot, short)
//   task = anything else        → Sonnet (recipes, vision, etc.)
//   explicit `model` override   → respected as-is

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MODEL_OPUS   = 'claude-opus-4-7';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { task, messages, imageBase64, mimeType, model: modelOverride } = body;
  let routedModel = MODEL_SONNET;
  if (task === 'meal-plan-skeleton' || task === 'substitution') routedModel = MODEL_HAIKU;
  const model = modelOverride || routedModel;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set. Go to Netlify → Site → Environment variables and add it.' }),
    };
  }

  let msgs = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (msgs.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages array is required' }) };
  }

  if (imageBase64) {
    const lastIdx = msgs.length - 1;
    const lastMsg = msgs[lastIdx];
    if (lastMsg.role === 'user') {
      const textContent =
        typeof lastMsg.content === 'string'
          ? lastMsg.content
          : Array.isArray(lastMsg.content)
          ? lastMsg.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ')
          : '';
      msgs[lastIdx] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: textContent },
        ],
      };
    }
  }

  const maxTokens = task === 'meal-plan' ? 6000
                  : task === 'meal-plan-skeleton' ? 1500
                  : task === 'meal-plan-day' ? 2200
                  : task === 'substitution' ? 800
                  : 4096;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: msgs,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error ' + response.status + ':', errText);
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: 'Anthropic API returned ' + response.status + ': ' + errText }),
      };
    }

    const data = await response.json();
    const content = (data.content && data.content[0] && data.content[0].text) || '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ content, model, usage: data.usage }),
    };
  } catch (e) {
    console.error('Claude proxy error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Proxy error: ' + e.message }),
    };
  }
};
