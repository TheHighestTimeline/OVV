// Kitchen Agent — Recipe URL Importer (Netlify Function)
// SETUP: Requires ANTHROPIC_API_KEY env var (same as claude.js)
// Supports: YouTube, Instagram, any recipe website with JSON-LD or plain HTML
// Timeout: set to 26s in netlify.toml

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// All ingredient IDs the app knows about — Claude maps imported ingredients to these
const INGREDIENT_IDS = [
  'chicken_breast','chicken_thigh','ground_beef','ground_turkey','steak',
  'salmon','shrimp','tuna','tofu','eggs','bacon','ham',
  'milk','cheese_cheddar','cheese_mozzarella','cheese_parmesan','cheese_feta',
  'cream_cheese','butter','yogurt','sour_cream','heavy_cream',
  'onion','garlic','tomato','cherry_tomato','bell_pepper','jalapeno',
  'lettuce','spinach','kale','broccoli','cauliflower','carrot','celery',
  'cucumber','zucchini','mushroom','potato','sweet_potato','avocado',
  'corn','green_onion','cilantro','parsley','basil','ginger','lemon','lime',
  'banana','apple','strawberry','blueberry',
  'rice_white','rice_brown','pasta_spaghetti','pasta_macaroni','pasta_penne',
  'pasta_fettuccine','egg_noodles','bread','tortilla','wrap','flour','oats','quinoa',
  'olive_oil','vegetable_oil','sesame_oil',
  'soy_sauce','hot_sauce','sriracha','honey','bbq_sauce','ketchup','mayo','mustard',
  'vinegar','salsa','peanut_butter','cornstarch','sugar','brown_sugar',
  'black_beans','kidney_beans','chickpeas',
  'tomato_sauce','tomato_paste','diced_tomatoes','chicken_broth','coconut_milk',
  'salt','pepper','paprika','cumin','chili_powder','garlic_powder','onion_powder',
  'oregano','italian_seasoning','cinnamon','chili_flakes','cajun_seasoning',
  'almonds','walnuts','cashews','sesame_seeds','cooking_spray',
];

// ── Helpers ──────────────────────────────────────────────────────────

function youtubeVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .trim();
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// ── Platform extractors ───────────────────────────────────────────────

async function extractYouTube(url) {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  let title = '', description = '', transcript = '';

  // 1. Try YouTube's internal player API (no key needed for public videos)
  try {
    const apiRes = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20230601.01.00',
              hl: 'en',
            },
          },
        }),
      }
    );
    if (apiRes.ok) {
      const data = await apiRes.json();
      title = data.videoDetails?.title || '';
      description = data.videoDetails?.shortDescription || '';

      // Try to get caption track URL
      const captionTracks =
        data.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const engTrack =
        captionTracks.find((t) => t.languageCode === 'en') ||
        captionTracks.find((t) => t.languageCode?.startsWith('en')) ||
        captionTracks[0];

      if (engTrack?.baseUrl) {
        try {
          const capRes = await fetch(engTrack.baseUrl + '&fmt=json3');
          if (capRes.ok) {
            const capData = await capRes.json();
            transcript = (capData.events || [])
              .filter((e) => e.segs)
              .map((e) => e.segs.map((s) => s.utf8 || '').join(''))
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
          }
        } catch (_) {
          // Try XML format as fallback
          try {
            const capRes = await fetch(engTrack.baseUrl);
            if (capRes.ok) {
              const xml = await capRes.text();
              transcript = (xml.match(/<text[^>]*>([^<]*)<\/text>/g) || [])
                .map((t) => decodeXmlEntities(t.replace(/<[^>]+>/g, '')))
                .join(' ');
            }
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.warn('YouTube player API failed:', e.message);
  }

  // 2. Fallback: fetch the watch page and grab meta description
  if (!title || !description) {
    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        if (!title) {
          const tm = html.match(/<title>([^<]*)<\/title>/);
          title = tm ? tm[1].replace(' - YouTube', '').trim() : '';
        }
        if (!description) {
          const dm = html.match(/<meta name="description" content="([^"]*)"/) ||
                     html.match(/<meta property="og:description" content="([^"]*)"/);
          description = dm ? dm[1] : '';
        }
      }
    } catch (e) {
      console.warn('YouTube page fetch failed:', e.message);
    }
  }

  const content = [
    title ? `Title: ${title}` : '',
    description ? `Description:\n${description}` : '',
    transcript ? `Transcript:\n${transcript.slice(0, 8000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!content.trim()) throw new Error('Could not extract content from YouTube video');
  return { content, source: `YouTube · ${title || url}`, source_url: url };
}

async function extractInstagram(url) {
  // Normalize to /p/ or /reel/ URL
  const pageRes = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!pageRes.ok) throw new Error(`Instagram fetch failed: ${pageRes.status}`);
  const html = await pageRes.text();

  let content = '';
  let title = 'Instagram Recipe';

  // Try Open Graph description (usually has the caption)
  const og = html.match(/<meta property="og:description" content="([^"]*)"/);
  const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (og) content += `Caption: ${decodeXmlEntities(og[1])}\n\n`;
  if (ogTitle) title = decodeXmlEntities(ogTitle[1]);

  // Try JSON-LD
  const ldMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const lm of ldMatches) {
    try {
      const json = JSON.parse(lm.replace(/<script[^>]*>|<\/script>/gi, '').trim());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item.description) content += `Description: ${item.description}\n\n`;
        if (item.name && item['@type'] !== 'Recipe') title = item.name;
      }
    } catch (_) {}
  }

  if (!content.trim()) {
    // Fallback: grab any readable text
    content = stripHtml(html).slice(0, 4000);
  }

  return { content, source: `Instagram · ${title}`, source_url: url };
}

async function extractGeneric(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`Could not fetch page: ${res.status} ${res.statusText}`);
  const html = await res.text();

  let title = '';
  const tm = html.match(/<title>([^<]*)<\/title>/);
  if (tm) title = tm[1].trim();

  // Try JSON-LD Recipe schema — most major recipe sites include this
  const ldMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const lm of ldMatches) {
    try {
      const raw = lm.replace(/<script[^>]*>|<\/script>/gi, '').trim();
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : (json['@graph'] || [json]);

      for (const item of items) {
        if (item['@type'] === 'Recipe' || (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))) {
          // Structured recipe data — format and return directly
          const ldContent = [
            `Title: ${item.name || title}`,
            item.description ? `Description: ${item.description}` : '',
            item.recipeIngredient?.length
              ? `Ingredients:\n${item.recipeIngredient.map((i) => `- ${i}`).join('\n')}`
              : '',
            item.recipeInstructions?.length
              ? `Steps:\n${(Array.isArray(item.recipeInstructions)
                  ? item.recipeInstructions
                      .map((s) => (typeof s === 'string' ? s : s.text || ''))
                  : [item.recipeInstructions]
                ).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
              : '',
            item.nutrition
              ? `Nutrition: calories ${item.nutrition.calories || '?'}, protein ${item.nutrition.proteinContent || '?'}g, carbs ${item.nutrition.carbohydrateContent || '?'}g, fat ${item.nutrition.fatContent || '?'}g`
              : '',
            `Servings: ${item.recipeYield || item.yield || '4'}`,
            item.prepTime ? `Prep: ${item.prepTime}` : '',
            item.cookTime ? `Cook: ${item.cookTime}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');

          return {
            content: ldContent,
            source: title || url,
            source_url: url,
            hasStructuredData: true,
          };
        }
      }
    } catch (_) {}
  }

  // No JSON-LD Recipe — extract readable text from HTML
  // Try to find main content area
  const mainMatch =
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<div[^>]*class="[^"]*(?:recipe|content|post|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  const rawContent = mainMatch ? mainMatch[1] : html;
  const text = stripHtml(rawContent);

  // Limit to 6000 chars so we don't blow up the Claude context
  const content = (title ? `Page: ${title}\n\n` : '') + text.slice(0, 6000);
  return { content, source: title || url, source_url: url };
}

// ── Claude Opus recipe parser ─────────────────────────────────────────

async function parseWithClaude(extracted, apiKey) {
  const prompt = `You are a recipe extraction expert. Extract the recipe from the content below and return it as structured JSON. Be precise — include exact ingredient measurements and clear step-by-step instructions. Strip any unrelated content (blog stories, ads, life anecdotes, author bios).

AVAILABLE INGREDIENT IDs (map each recipe ingredient to the closest match from this list; only use IDs from this list):
${INGREDIENT_IDS.join(', ')}

SOURCE: ${extracted.source}
SOURCE URL: ${extracted.source_url}

CONTENT:
${extracted.content}

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "name": "Recipe Name",
  "source": "${extracted.source}",
  "source_url": "${extracted.source_url}",
  "servings": 4,
  "prep_min": 15,
  "cook_min": 30,
  "meal_types": ["dinner"],
  "tags": ["high-protein", "chicken", "quick"],
  "proteins": ["chicken"],
  "macros": {
    "calories": 450,
    "protein": 38,
    "carbs": 32,
    "fat": 12
  },
  "ingredients": [
    "2 chicken breasts (about 500g)",
    "3 cloves garlic, minced"
  ],
  "canonical_ingredients": ["chicken_breast", "garlic"],
  "steps": [
    "Preheat oven to 375°F.",
    "Season the chicken breasts with salt and pepper."
  ]
}

Notes:
- meal_types: one or more of ["breakfast","lunch","dinner","snack"]
- tags: 2-5 descriptive tags (cuisine, diet type, cooking method, etc.)
- proteins: list of protein sources if any
- macros: estimate if not provided; use null for unknown fields
- canonical_ingredients: only IDs from the provided list that appear in this recipe
- ingredients: verbatim list with measurements from the source
- steps: clean numbered steps, no ads or sidebar content
- If content doesn't appear to be a recipe, return {"error": "No recipe found in content"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');

  const recipe = JSON.parse(jsonMatch[0]);
  if (recipe.error) throw new Error(recipe.error);

  // Add a stable ID based on name + source
  recipe.id = `imported_${Date.now()}_${(recipe.name || 'recipe').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)}`;
  recipe.imported_at = new Date().toISOString();

  return recipe;
}

// ── Handler ───────────────────────────────────────────────────────────

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

  const { url, text: pastedText } = body;
  if (!url && !pastedText) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'url or text is required' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
    };
  }

  try {
    let extracted;

    if (pastedText) {
      // User pasted raw text (recipe, description, etc.)
      extracted = { content: pastedText, source: 'Pasted recipe', source_url: '' };
    } else {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
        extracted = await extractYouTube(url);
      } else if (urlLower.includes('instagram.com')) {
        extracted = await extractInstagram(url);
      } else {
        extracted = await extractGeneric(url);
      }
    }

    const recipe = await parseWithClaude(extracted, apiKey);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ recipe }),
    };
  } catch (e) {
    console.error('Import error:', e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
