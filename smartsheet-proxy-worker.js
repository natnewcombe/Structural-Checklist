/**
 * Smartsheet proxy — Cloudflare Worker
 * ------------------------------------
 * Solves two problems the Frame Checklist tablet app can't solve on its own:
 *   1. api.smartsheet.com sends no CORS headers, so a browser can never call
 *      it directly.
 *   2. The Smartsheet Personal Access Token must never sit in client-side JS
 *      (anyone on the tablet could open devtools and read it).
 *
 * This Worker holds the token as a secret and does three things:
 *   - GET  /api/*        Plain JSON passthrough to Smartsheet (reports, sheets,
 *                         rows, attachment metadata listings, etc.)
 *   - GET  /download      Resolves an attachment's pre-signed URL AND fetches
 *                         the bytes in the same request, because that URL
 *                         expires in 60 seconds — the client should never see it.
 *   - POST /upload         Forwards raw file bytes to Smartsheet as a new
 *                         attachment or a new version, with the exact three
 *                         headers Smartsheet's upload endpoint requires
 *                         (Content-Type, Content-Length, Content-Disposition).
 *
 * Every request must carry header  X-App-Key: <APP_KEY>  — a shared secret
 * separate from the Smartsheet token, so the Worker's URL leaking alone
 * doesn't hand out Smartsheet access.
 *
 * ---- One-time setup (Cloudflare dashboard) ----
 * 1. Workers & Pages -> Create -> Create Worker. Paste this whole file in
 *    (Quick Edit), Deploy.
 * 2. Settings -> Variables and Secrets -> add two ENCRYPTED secrets:
 *      SMARTSHEET_TOKEN   = your Smartsheet Personal Access Token
 *      APP_KEY            = any long random string you make up
 * 3. Note the Worker's URL (https://<name>.<subdomain>.workers.dev) and the
 *    APP_KEY — both go into the tablet app's Settings screen.
 */

const SMARTSHEET_BASE = 'https://api.smartsheet.com/2.0';
const UPLOAD_CAP_BYTES = 30 * 1024 * 1024; // Smartsheet's API cap

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, X-Filename, X-Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
  });
}

async function smartsheetFetch(env, path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Authorization': 'Bearer ' + env.SMARTSHEET_TOKEN }, opts.headers || {});
  let res = await fetch(SMARTSHEET_BASE + path, Object.assign({}, opts, { headers }));

  // Smartsheet: 300 requests/min per token. Retry once on 429, non-reentrant.
  if (res.status === 429 && !opts._retried) {
    await new Promise(r => setTimeout(r, 60000));
    return smartsheetFetch(env, path, Object.assign({}, opts, { _retried: true }));
  }
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const appKey = request.headers.get('X-App-Key') || url.searchParams.get('k');
    if (!appKey || appKey !== env.APP_KEY) {
      return jsonResponse({ error: 'Missing or invalid X-App-Key' }, 403, origin);
    }

    try {
      // ---------------------------------------------------------------
      // GET /api/*  — plain JSON passthrough
      // ---------------------------------------------------------------
      if (url.pathname.startsWith('/api/') && request.method === 'GET') {
        const ssPath = url.pathname.replace(/^\/api/, '') + url.search;
        const res = await smartsheetFetch(env, ssPath);
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
        });
      }

      // ---------------------------------------------------------------
      // GET /download?sheetId=X&attachmentId=Y
      // Resolves the pre-signed URL and fetches bytes server-side in one
      // round trip, so the client never sees (or races) the 60s expiry.
      // ---------------------------------------------------------------
      if (url.pathname === '/download' && request.method === 'GET') {
        const sheetId = url.searchParams.get('sheetId');
        const attachmentId = url.searchParams.get('attachmentId');
        if (!sheetId || !attachmentId) {
          return jsonResponse({ error: 'sheetId and attachmentId are required' }, 400, origin);
        }
        const metaRes = await smartsheetFetch(env, '/sheets/' + sheetId + '/attachments/' + attachmentId);
        if (!metaRes.ok) {
          return jsonResponse({ error: 'Could not resolve attachment metadata' }, metaRes.status, origin);
        }
        const meta = await metaRes.json();
        // Pre-signed URL: NO Authorization header — sending one can break it.
        const fileRes = await fetch(meta.url);
        if (!fileRes.ok) {
          return jsonResponse({ error: 'Could not fetch attachment bytes' }, 502, origin);
        }
        const bytes = await fileRes.arrayBuffer();
        return new Response(bytes, {
          status: 200,
          headers: Object.assign({
            'Content-Type': meta.mimeType || 'application/octet-stream',
            'X-Attachment-Name': meta.name || ''
          }, corsHeaders(origin))
        });
      }

      // ---------------------------------------------------------------
      // POST /upload?sheetId=X&rowId=Y&filename=Z&mode=new
      // POST /upload?sheetId=X&attachmentId=W&filename=Z&mode=version
      // Body: raw file bytes (NOT JSON, NOT multipart, NOT base64).
      // ---------------------------------------------------------------
      if (url.pathname === '/upload' && request.method === 'POST') {
        const sheetId = url.searchParams.get('sheetId');
        const rowId = url.searchParams.get('rowId');
        const attachmentId = url.searchParams.get('attachmentId');
        const filename = url.searchParams.get('filename');
        const mode = url.searchParams.get('mode') || 'new';
        const contentType = request.headers.get('X-Content-Type') || 'application/pdf';

        if (!sheetId || !filename || (mode === 'new' && !rowId) || (mode === 'version' && !attachmentId)) {
          return jsonResponse({ error: 'Missing required parameters' }, 400, origin);
        }

        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > UPLOAD_CAP_BYTES) {
          return jsonResponse({ error: 'File exceeds Smartsheet\'s 30MB API upload cap' }, 413, origin);
        }

        const ssPath = mode === 'version'
          ? '/sheets/' + sheetId + '/attachments/' + attachmentId + '/versions'
          : '/sheets/' + sheetId + '/rows/' + rowId + '/attachments';

        const res = await smartsheetFetch(env, ssPath, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(bytes.byteLength),
            'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"'
          },
          body: bytes
        });
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin))
        });
      }

      return jsonResponse({ error: 'Not found' }, 404, origin);
    } catch (err) {
      return jsonResponse({ error: 'Proxy error: ' + err.message }, 500, origin);
    }
  }
};
