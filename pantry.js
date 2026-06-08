// Kitchen Agent — Composio Instacart Handler (Netlify Function)
// SETUP: Add COMPOSIO_API_KEY to Netlify → Site → Environment variables
//        Also connect your Instacart account at https://app.composio.dev
//
// POST { items: [{name, quantity}], retailer?: "aldi", title?: "..." }
// Returns { url: "https://www.instacart.com/..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

  const { items, retailer = 'aldi', title = 'Kitchen Agent Shopping List' } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'items array is required' }) };
  }

  const composioKey = process.env.COMPOSIO_API_KEY;
  if (!composioKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'COMPOSIO_API_KEY not configured. Add it in Netlify → Site → Environment variables.',
        fallback: true,
      }),
    };
  }

  try {
    // ── Composio REST API call ──────────────────────────────────────────────
    // Composio executes the INSTACART_CREATE_SHOPPING_LIST_PAGE action
    // which creates a shareable Instacart shopping list URL
    const composioRes = await fetch(
      'https://backend.composio.dev/api/v2/actions/INSTACART_CREATE_SHOPPING_LIST_PAGE/execute',
      {
        method: 'POST',
        headers: {
          'x-api-key': composioKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          entityId: 'default',
          input: {
            title,
            ingredients: items.map((item) => ({
              name: item.name,
              quantity: item.quantity || item.qty || '1',
              unit: item.unit || '',
              display_text: item.display || `${item.quantity || '1'} ${item.name}`,
            })),
            // Optional: pass partner link-back URL
            landing_page_configuration: {
              partner_linkback_url: 'https://kitchen-agent.netlify.app',
            },
          },
        }),
      }
    );

    if (!composioRes.ok) {
      const errText = await composioRes.text();
      console.error('Composio API error:', composioRes.status, errText);

      // If Composio fails, fall back to direct Instacart search URL
      const fallbackUrl = buildFallbackUrl(items, retailer);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          url: fallbackUrl,
          fallback: true,
          fallback_reason: `Composio API error ${composioRes.status}`,
        }),
      };
    }

    const data = await composioRes.json();

    // Extract the Instacart URL from the Composio response
    // The response structure: data.response.data.products_link_url or similar
    const url =
      data?.response?.data?.products_link_url ||
      data?.data?.products_link_url ||
      data?.result?.url ||
      data?.url;

    if (!url) {
      console.warn('Composio returned no URL:', JSON.stringify(data).slice(0, 500));
      const fallbackUrl = buildFallbackUrl(items, retailer);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          url: fallbackUrl,
          fallback: true,
          fallback_reason: 'Composio returned no URL — check Instacart connection at app.composio.dev',
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url, fallback: false, item_count: items.length }),
    };
  } catch (e) {
    console.error('Composio handler error:', e.message);
    // Always fail open — return a usable search URL
    const fallbackUrl = buildFallbackUrl(items, retailer);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: fallbackUrl,
        fallback: true,
        fallback_reason: e.message,
      }),
    };
  }
};

/**
 * Build a direct Instacart search URL as a fallback.
 * Opens to the store search page with the first few items as the query.
 */
function buildFallbackUrl(items, retailer = 'aldi') {
  const query = items
    .slice(0, 5)
    .map((i) => i.name)
    .join(' ');
  return `https://www.instacart.com/store/${retailer}/search/${encodeURIComponent(query)}`;
}
