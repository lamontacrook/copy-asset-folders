#!/usr/bin/env node

/**
 * Local proxy server — serves the UI and forwards requests to AEM,
 * bypassing browser CORS restrictions.
 *
 * Usage:
 *   node server.js
 *   Then open http://localhost:3000
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;

// Strip /content/dam prefix — the Assets HTTP API is relative to that root.
// Each path segment is percent-encoded so names with spaces/parens/etc. work.
function toApiPath(damPath) {
  const stripped = (damPath || '').replace(/\/$/, '').replace(/^\/content\/dam/, '') || '';
  return stripped.split('/').map((seg) => seg ? encodeURIComponent(seg) : '').join('/');
}

function aemRequest(host, method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    let baseUrl;
    try { baseUrl = new URL(host); } catch (e) { return reject(new Error('Invalid host URL')); }

    const isHttps = baseUrl.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = { 'Authorization': `Bearer ${token}` };

    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    // COPY method requires both Destination (full URL) and X-Destination (path only)
    if (method === 'COPY' && apiPath._dest) {
      headers['Destination'] = `${host}${apiPath._dest}`;
      headers['X-Destination'] = apiPath._dest;
      headers['X-Overwrite'] = 'F';
      apiPath = apiPath._src;
    }

    const options = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: apiPath,
      method,
      headers,
    };

    console.log(`[proxy] ${method} ${host}${options.path}`);

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        console.log(`[proxy] Response: HTTP ${res.statusCode}`);
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function sendJSON(res, status, obj) {
  const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {

  // ── Serve the UI ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── POST /proxy/create-folder ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/proxy/create-folder') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, parentPath, folderName, folderTitle } = payload;
    if (!host || !token || !parentPath || !folderName)
      return sendJSON(res, 400, { error: 'Missing required fields' });

    const apiPath = `/api/assets${toApiPath(parentPath)}/${folderName}`;
    const body = JSON.stringify({
      class: 'assetFolder',
      properties: { 'dc:title': folderTitle || folderName },
    });

    try {
      const r = await aemRequest(host, 'POST', apiPath, token, body);
      sendJSON(res, r.status, r.body);
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── POST /proxy/list-assets ───────────────────────────────────────────────
  // Lists the direct children of a DAM folder.
  if (req.method === 'POST' && req.url === '/proxy/list-assets') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, folderPath } = payload;
    if (!host || !token || !folderPath)
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, folderPath' });

    const apiPath = `/api/assets${toApiPath(folderPath)}.json`;

    try {
      const r = await aemRequest(host, 'GET', apiPath, token);
      sendJSON(res, r.status, r.body);
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── POST /proxy/copy-asset ────────────────────────────────────────────────
  // Copies a single asset or folder from sourcePath to destPath.
  if (req.method === 'POST' && req.url === '/proxy/copy-asset') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, sourcePath, destPath } = payload;
    if (!host || !token || !sourcePath || !destPath)
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, sourcePath, destPath' });

    const srcApi = `/api/assets${toApiPath(sourcePath)}`;
    const dstApi = `/api/assets${toApiPath(destPath)}`;

    try {
      const r = await aemRequest(host, 'COPY', { _src: srcApi, _dest: dstApi }, token);
      sendJSON(res, r.status, r.body || JSON.stringify({ status: r.status }));
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── POST /proxy/update-folder ────────────────────────────────────────────
  // Updates jcr:title on an existing DAM folder via the Sling POST servlet.
  if (req.method === 'POST' && req.url === '/proxy/update-folder') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, folderPath, folderTitle } = payload;
    if (!host || !token || !folderPath || !folderTitle)
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, folderPath, folderTitle' });

    let baseUrl;
    try { baseUrl = new URL(host); } catch { return sendJSON(res, 400, { error: 'Invalid host URL' }); }

    const isHttps = baseUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    // Use the Sling POST servlet on the full JCR path to reliably set node properties.
    const params = new URLSearchParams();
    params.append('_charset_', 'utf-8');
    params.append('jcr:title', folderTitle);
    params.append('jcr:content/jcr:title', folderTitle);
    const formBody = params.toString();

    const options = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: folderPath,   // full JCR path, e.g. /content/dam/seat-01
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    };

    console.log(`[proxy] POST ${host}${folderPath} (set title: "${folderTitle}")`);

    const r = await new Promise((resolve, reject) => {
      const req2 = mod.request(options, (res2) => {
        let data = '';
        res2.on('data', (c) => { data += c; });
        res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.write(formBody);
      req2.end();
    }).catch((e) => ({ status: 502, body: JSON.stringify({ error: e.message }) }));

    console.log(`[proxy] Response: HTTP ${r.status}`);
    sendJSON(res, r.status, r.body || JSON.stringify({ status: r.status }));
    return;
  }

  // ── POST /proxy/get-permissions ──────────────────────────────────────────
  // Returns the current ACL for a DAM folder path.
  if (req.method === 'POST' && req.url === '/proxy/get-permissions') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, folderPath } = payload;
    if (!host || !token || !folderPath)
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, folderPath' });

    // ACLs in AEM are stored as a rep:policy child node under the folder path.
    let baseUrl;
    try { baseUrl = new URL(host); } catch { return sendJSON(res, 400, { error: 'Invalid host URL' }); }

    const isHttps = baseUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    // Fetch the rep:policy node with full depth so all ACEs are included
    const jsonAclPath = `${folderPath}/rep:policy.infinity.json`;

    const options = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (isHttps ? 443 : 80),
      path: jsonAclPath,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    };

    console.log(`[proxy] GET ${host}${jsonAclPath}`);

    const r = await new Promise((resolve, reject) => {
      const req2 = mod.request(options, (res2) => {
        let data = '';
        res2.on('data', (c) => { data += c; });
        res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
      });
      req2.on('error', reject);
      req2.end();
    }).catch((e) => ({ status: 502, body: JSON.stringify({ error: e.message }) }));

    console.log(`[proxy] Response: HTTP ${r.status}`);
    sendJSON(res, r.status, r.body);
    return;
  }

  // ── POST /proxy/set-permissions ───────────────────────────────────────────
  // Sets an ACE via the Sling Jackrabbit Access Manager servlet.
  // Uses .modifyAce.html selector and includes a CSRF token.
  if (req.method === 'POST' && req.url === '/proxy/set-permissions') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, folderPath, principalId, privileges, effect } = payload;
    if (!host || !token || !folderPath || !principalId || !privileges?.length)
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, folderPath, principalId, privileges' });

    let baseUrl;
    try { baseUrl = new URL(host); } catch { return sendJSON(res, 400, { error: 'Invalid host URL' }); }

    const isHttps  = baseUrl.protocol === 'https:';
    const mod      = isHttps ? https : http;
    const hostname = baseUrl.hostname;
    const port     = baseUrl.port || (isHttps ? 443 : 80);
    const authHdr  = `Bearer ${token}`;

    // Helper: generic HTTP request
    function makeRequest(method, path, headers, body) {
      return new Promise((resolve, reject) => {
        const opts = { hostname, port, path, method, headers };
        console.log(`[proxy] ${method} ${host}${path}`);
        const r = mod.request(opts, (res2) => {
          let data = '';
          res2.on('data', (c) => { data += c; });
          res2.on('end', () => {
            console.log(`[proxy]   → HTTP ${res2.statusCode}`);
            resolve({ status: res2.statusCode, body: data, headers: res2.headers });
          });
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
      });
    }

    // Expand aggregate privileges — modifyAce rejects jcr:all / jcr:write
    // as composites on some AEM versions; expand them to base privileges.
    const AGGREGATE = {
      'jcr:all':   ['jcr:read','jcr:write','jcr:readAccessControl','jcr:modifyAccessControl',
                    'jcr:lockManagement','jcr:versionManagement','jcr:nodeTypeManagement',
                    'jcr:retentionManagement','jcr:lifecycleManagement','rep:write',
                    'crx:replicate'],
      'jcr:write': ['jcr:modifyProperties','jcr:addChildNodes','jcr:removeNode','jcr:removeChildNodes'],
      'rep:write': ['jcr:modifyProperties','jcr:addChildNodes','jcr:removeNode',
                    'jcr:removeChildNodes','jcr:nodeTypeManagement'],
    };
    const expandedPrivileges = [...new Set(
      privileges.flatMap((p) => AGGREGATE[p] || [p])
    )];

    const isGrant     = effect !== 'deny';
    const grantOrDeny = isGrant ? 'granted' : 'denied';

    console.log(`[proxy] principal: ${principalId}, effect: ${effect}`);
    console.log(`[proxy] privileges (raw):      ${JSON.stringify(privileges)}`);
    console.log(`[proxy] privileges (expanded): ${expandedPrivileges.join(', ')}`);
    console.log(`[proxy] folderPath: ${folderPath}`);

    try {
      // Fetch a fresh CSRF token per call — AEM CS may require it even with Bearer auth.
      // Fetching fresh each time avoids the single-use reuse problem from the old approach.
      let csrfToken = '';
      try {
        const csrfRes = await makeRequest('GET', '/libs/granite/csrf/token.json', {
          'Authorization': authHdr,
          'Accept': 'application/json',
        });
        console.log(`[proxy] CSRF fetch: HTTP ${csrfRes.status}, body: ${csrfRes.body}`);
        const csrfData = JSON.parse(csrfRes.body);
        csrfToken = csrfData.token || '';
      } catch (e) {
        console.warn(`[proxy] CSRF fetch failed (non-fatal): ${e.message}`);
      }
      console.log(`[proxy] CSRF token: ${csrfToken ? csrfToken.slice(0, 20) + '…' : '(none)'}`);

      const params = new URLSearchParams();
      params.append('_charset_', 'utf-8');
      params.append('principalId', principalId);
      if (csrfToken) params.append(':cq_csrf_token', csrfToken);
      for (const priv of expandedPrivileges) {
        params.append(`privilege@${priv}`, grantOrDeny);
      }
      const formBody = params.toString();
      console.log(`[proxy] POST body: ${formBody}`);

      const aceUrl = `${folderPath}.modifyAce.html`;
      const r = await makeRequest('POST', aceUrl, {
        'Authorization': authHdr,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        'Referer': host,
      }, formBody);

      console.log(`[proxy] modifyAce response body: ${r.body.slice(0, 500)}`);
      if (r.status !== 200 && r.status !== 201) {
        console.error(`[proxy] modifyAce FAILED HTTP ${r.status}`);
      }
      sendJSON(res, r.status, r.body || JSON.stringify({ status: r.status }));
    } catch (e) {
      console.error('[proxy] set-permissions error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── POST /proxy/apply-aces ────────────────────────────────────────────────
  // Applies a batch of ACEs to a folder in series, waiting for a fresh CSRF
  // token before each call to avoid the single-use-per-second reuse problem.
  // Duplicate ACEs for the same principal are merged before applying.
  if (req.method === 'POST' && req.url === '/proxy/apply-aces') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }

    const { host, token, folderPath, aces } = payload;
    if (!host || !token || !folderPath || !Array.isArray(aces))
      return sendJSON(res, 400, { error: 'Missing required fields: host, token, folderPath, aces' });

    let baseUrl;
    try { baseUrl = new URL(host); } catch { return sendJSON(res, 400, { error: 'Invalid host URL' }); }

    const isHttps  = baseUrl.protocol === 'https:';
    const mod      = isHttps ? https : http;
    const hostname = baseUrl.hostname;
    const port     = baseUrl.port || (isHttps ? 443 : 80);
    const authHdr  = `Bearer ${token}`;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Returns { status, body, headers } — headers lets callers forward Set-Cookie.
    function makeReq(method, path, headers, body) {
      return new Promise((resolve, reject) => {
        const opts = { hostname, port, path, method, headers };
        console.log(`[proxy] ${method} ${host}${path}`);
        const r = mod.request(opts, (res2) => {
          let data = '';
          res2.on('data', (c) => { data += c; });
          res2.on('end', () => {
            console.log(`[proxy]   → HTTP ${res2.statusCode}`);
            resolve({ status: res2.statusCode, body: data, headers: res2.headers });
          });
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
      });
    }

    // Merge ACEs by principalId+effect so duplicate entries are combined.
    const AGGREGATE = {
      'jcr:all':   ['jcr:read','jcr:write','jcr:readAccessControl','jcr:modifyAccessControl',
                    'jcr:lockManagement','jcr:versionManagement','jcr:nodeTypeManagement',
                    'jcr:retentionManagement','jcr:lifecycleManagement','rep:write','crx:replicate'],
      'jcr:write': ['jcr:modifyProperties','jcr:addChildNodes','jcr:removeNode','jcr:removeChildNodes'],
      'rep:write': ['jcr:modifyProperties','jcr:addChildNodes','jcr:removeNode',
                    'jcr:removeChildNodes','jcr:nodeTypeManagement'],
    };

    const merged = new Map();
    for (const ace of aces) {
      const key = `${ace.principalId}||${ace.effect || 'allow'}`;
      if (!merged.has(key)) merged.set(key, { principalId: ace.principalId, effect: ace.effect || 'allow', privSet: new Set() });
      for (const p of (ace.privileges || [])) {
        for (const ep of (AGGREGATE[p] || [p])) merged.get(key).privSet.add(ep);
      }
    }

    console.log(`[proxy] apply-aces: ${merged.size} unique principal(s) for ${folderPath}`);

    // Verify which principals actually exist in AEM before calling modifyAce.
    // Oak's modifyAce returns 422 "invalid payload" for unknown principals.
    async function principalExists(principalId) {
      // Strategy 1: Granite security search (requires admin; returns 500 for IMS Bearer)
      try {
        const r = await makeReq('GET',
          `/libs/granite/security/search/authorizables.json?type=group&query=${encodeURIComponent(principalId)}&chunk=0&limit=5`,
          { 'Authorization': authHdr, 'Accept': 'application/json' });
        if (r.status === 200) {
          const data = JSON.parse(r.body);
          const items = data.authorizables || data.hits || [];
          const found = items.some((a) => a.id === principalId || a.name === principalId || a.rep_principalName === principalId);
          console.log(`[proxy] principal check (security): "${principalId}" found=${found}`);
          return found;
        }
        console.log(`[proxy] principal check (security) HTTP ${r.status} — trying QueryBuilder`);
      } catch (e) {
        console.warn(`[proxy] principal check (security) error: ${e.message}`);
      }

      // Strategy 2: JCR QueryBuilder — works with IMS Bearer tokens if user has /home read access
      try {
        const qb = `/bin/querybuilder.json?type=rep:Group&property=rep:principalName&property.value=${encodeURIComponent(principalId)}&p.limit=1`;
        const r = await makeReq('GET', qb, { 'Authorization': authHdr, 'Accept': 'application/json' });
        if (r.status === 200) {
          const data = JSON.parse(r.body);
          const found = (data.total || 0) > 0;
          console.log(`[proxy] principal check (querybuilder): "${principalId}" total=${data.total} found=${found}`);
          return found;
        }
        // Also try for users (not just groups)
        const qu = `/bin/querybuilder.json?type=rep:User&property=rep:principalName&property.value=${encodeURIComponent(principalId)}&p.limit=1`;
        const ru = await makeReq('GET', qu, { 'Authorization': authHdr, 'Accept': 'application/json' });
        if (ru.status === 200) {
          const data = JSON.parse(ru.body);
          const found = (data.total || 0) > 0;
          console.log(`[proxy] principal check (querybuilder user): "${principalId}" total=${data.total} found=${found}`);
          return found;
        }
        console.log(`[proxy] principal check (querybuilder) HTTP ${r.status} — cannot verify`);
      } catch (e) {
        console.warn(`[proxy] principal check (querybuilder) error: ${e.message}`);
      }

      // Can't verify — attempt modifyAce anyway; it will fail with 422 if missing
      console.warn(`[proxy] Cannot verify principal "${principalId}" — attempting modifyAce`);
      return true;
    }

    const results = [];
    let lastCsrfToken = null;
    let lastCsrfCookie = '';

    for (const { principalId, effect, privSet } of merged.values()) {
      const expandedPrivileges = [...privSet];
      if (expandedPrivileges.length === 0) continue;

      // Check principal existence first to avoid wasting CSRF tokens on known-bad principals.
      const exists = await principalExists(principalId);
      if (!exists) {
        console.warn(`[proxy] Skipping "${principalId}" — principal not found in AEM`);
        results.push({ principalId, effect, status: 404, ok: false, error: 'principal not found' });
        continue;
      }

      // Poll for a fresh CSRF token (different from the last one used).
      // AEM tokens are time-based JWTs with 1-second granularity; same-second
      // calls get the same token, which is single-use.
      let csrfToken = '';
      let csrfCookie = lastCsrfCookie;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (attempt > 0) await sleep(200);
        try {
          const csrfRes = await makeReq('GET', '/libs/granite/csrf/token.json', {
            'Authorization': authHdr, 'Accept': 'application/json',
          });
          csrfToken = (JSON.parse(csrfRes.body).token || '');
          // Forward any Set-Cookie headers AEM sends — CSRF validation may rely on them.
          const sc = csrfRes.headers['set-cookie'];
          if (sc) {
            const cookies = Array.isArray(sc) ? sc : [sc];
            csrfCookie = cookies.map((c) => c.split(';')[0]).join('; ');
            lastCsrfCookie = csrfCookie;
          }
        } catch (e) {
          console.warn(`[proxy] CSRF fetch error: ${e.message}`);
        }
        if (csrfToken && csrfToken !== lastCsrfToken) break;
        console.log(`[proxy] CSRF token unchanged (attempt ${attempt + 1}), waiting 200 ms…`);
      }
      lastCsrfToken = csrfToken;
      console.log(`[proxy] principal: ${principalId} | effect: ${effect} | privs: ${expandedPrivileges.join(', ')}`);
      console.log(`[proxy] CSRF: ${csrfToken ? csrfToken.slice(0, 20) + '…' : '(none)'} | cookies: ${csrfCookie || '(none)'}`);

      const params = new URLSearchParams();
      params.append('_charset_', 'utf-8');
      params.append('principalId', principalId);
      if (csrfToken) params.append(':cq_csrf_token', csrfToken);
      for (const priv of expandedPrivileges) params.append(`privilege@${priv}`, effect !== 'deny' ? 'granted' : 'denied');
      const formBody = params.toString();

      const postHeaders = {
        'Authorization': authHdr,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        'Referer': host,
      };
      if (csrfCookie) postHeaders['Cookie'] = csrfCookie;

      try {
        const r = await makeReq('POST', `${folderPath}.modifyAce.html`, postHeaders, formBody);
        const ok = r.status === 200 || r.status === 201;
        // 422 = "invalid payload" — Oak throws this for unknown principals.
        const warn = r.status === 422;
        if (ok)   console.log(`[proxy] modifyAce OK for ${principalId}`);
        if (!ok)  console.error(`[proxy] modifyAce FAILED HTTP ${r.status} for ${principalId}: ${r.body.slice(0, 200)}`);
        results.push({ principalId, effect, status: r.status, ok,
          warn, error: warn ? 'principal not found in AEM user store (422)' : undefined });
      } catch (e) {
        console.error(`[proxy] modifyAce error for ${principalId}: ${e.message}`);
        results.push({ principalId, effect, status: 502, ok: false, warn: false, error: e.message });
      }
    }

    const allOk = results.every((r) => r.ok);
    sendJSON(res, allOk ? 200 : 207, { results });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
