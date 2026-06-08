// Kitchen Agent — Airtable sync proxy (Netlify Function)
// Keeps the Airtable PAT server-side. Client posts {action, table, ...payload}.
//
// Required env vars:
//   AIRTABLE_TOKEN    — Personal Access Token (scoped to the kitchen base)
//   AIRTABLE_BASE_ID  — e.g. appXXXXXXXXXXXXXX
//
// Actions:
//   listForUser  { table, userId }              -> { records: [{id, fields}] }
//   upsert       { table, records: [...] }      -> { records: [{id, fields}] }
//                  each record: { id?, fields }  (id present = update, absent = create)
//   delete       { table, ids: [...] }          -> { deleted: [...] }
//   ensureUser   { userId, name, fingerprint }  -> { user: {...} }
//   listUsers    {}                              -> { users: [...] }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_TABLES = new Set([
  'Users', 'Pantry', 'Plan', 'CustomRecipes', 'Orders', 'Profile', 'CookedMarks',
]);

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- Airtable REST helpers ---
const AT_API = 'https://api.airtable.com/v0';

async function atFetch(baseId, token, path, opts = {}) {
  const url = `${AT_API}/${baseId}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.type || `Airtable ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// Filter records by userId (Airtable formula). Pantry/Plan/etc. all use a "userId" text field
// (not a linked record) so the schema is simpler — one PAT scope, no cross-table link setup.
function userFilterFormula(userId) {
  // Escape single quotes in userId for the formula literal.
  const safe = String(userId).replace(/'/g, "\\'");
  return `{userId}='${safe}'`;
}

async function listAll(baseId, token, table, formula) {
  const records = [];
  let offset;
  do {
    const params = new URLSearchParams();
    if (formula) params.set('filterByFormula', formula);
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const data = await atFetch(baseId, token, `/${encodeURIComponent(table)}?${params}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

// Airtable's create/update endpoints accept max 10 records per call.
async function batchUpsert(baseId, token, table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const creates = chunk.filter(r => !r.id);
    const updates = chunk.filter(r => r.id);

    if (creates.length) {
      const data = await atFetch(baseId, token, `/${encodeURIComponent(table)}`, {
        method: 'POST',
        body: JSON.stringify({ records: creates.map(r => ({ fields: r.fields })), typecast: true }),
      });
      out.push(...(data.records || []));
    }
    if (updates.length) {
      const data = await atFetch(baseId, token, `/${encodeURIComponent(table)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          records: updates.map(r => ({ id: r.id, fields: r.fields })),
          typecast: true,
        }),
      });
      out.push(...(data.records || []));
    }
  }
  return out;
}

async function batchDelete(baseId, token, table, ids) {
  const deleted = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const params = new URLSearchParams();
    chunk.forEach(id => params.append('records[]', id));
    const data = await atFetch(
      baseId, token,
      `/${encodeURIComponent(table)}?${params}`,
      { method: 'DELETE' }
    );
    deleted.push(...(data.records || []).map(r => r.id));
  }
  return deleted;
}

// --- Handler ---
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    return json(500, {
      error: 'AIRTABLE_TOKEN or AIRTABLE_BASE_ID is not set in Netlify environment variables.',
    });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { action, table } = payload;
  if (table && !ALLOWED_TABLES.has(table)) {
    return json(400, { error: `Unknown table: ${table}` });
  }

  try {
    switch (action) {

      case 'listForUser': {
        const { userId } = payload;
        if (!userId) return json(400, { error: 'userId required' });
        const records = await listAll(baseId, token, table, userFilterFormula(userId));
        return json(200, { records });
      }

      case 'upsert': {
        const { records } = payload;
        if (!Array.isArray(records)) return json(400, { error: 'records[] required' });
        const out = await batchUpsert(baseId, token, table, records);
        return json(200, { records: out });
      }

      case 'delete': {
        const { ids } = payload;
        if (!Array.isArray(ids) || !ids.length) return json(200, { deleted: [] });
        const deleted = await batchDelete(baseId, token, table, ids);
        return json(200, { deleted });
      }

      case 'ensureUser': {
        const { userId, name, fingerprint } = payload;
        if (!userId) return json(400, { error: 'userId required' });
        const formula = `{userId}='${String(userId).replace(/'/g, "\\'")}'`;
        const existing = await listAll(baseId, token, 'Users', formula);
        if (existing.length) {
          // Update name/fingerprint if changed
          const cur = existing[0];
          const needsUpdate =
            (name && cur.fields.name !== name) ||
            (fingerprint && cur.fields.fingerprint !== fingerprint);
          if (needsUpdate) {
            const updated = await batchUpsert(baseId, token, 'Users', [{
              id: cur.id,
              fields: {
                ...(name ? { name } : {}),
                ...(fingerprint ? { fingerprint } : {}),
              },
            }]);
            return json(200, { user: updated[0] });
          }
          return json(200, { user: cur });
        }
        const created = await batchUpsert(baseId, token, 'Users', [{
          fields: {
            userId,
            name: name || 'Unnamed',
            fingerprint: fingerprint || '',
            createdAt: new Date().toISOString(),
          },
        }]);
        return json(200, { user: created[0] });
      }

      case 'listUsers': {
        const records = await listAll(baseId, token, 'Users');
        return json(200, { users: records });
      }

      default:
        return json(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    return json(err.status || 500, {
      error: err.message || 'Airtable request failed',
      detail: err.detail,
    });
  }
};
