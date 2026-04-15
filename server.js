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

    try {
      // Step 1: Fetch a CSRF token — required by AEM for mutating POST requests.
      const csrfRes = await makeRequest('GET', '/libs/granite/csrf/token.json', {
        'Authorization': authHdr,
        'Accept': 'application/json',
      });

      let csrfToken = '';
      try {
        const csrfData = JSON.parse(csrfRes.body);
        csrfToken = csrfData.token || '';
      } catch { /* non-fatal — try without token */ }

      console.log(`[proxy] CSRF token: ${csrfToken ? 'obtained' : 'unavailable'}`);

      // Step 2: POST to <folderPath>.modifyAce.html with the ACE parameters.
      const isGrant     = effect !== 'deny';
      const grantOrDeny = isGrant ? 'granted' : 'denied';

      const params = new URLSearchParams();
      params.append('_charset_', 'utf-8');
      params.append('principalId', principalId);
      if (csrfToken) params.append(':cq_csrf_token', csrfToken);
      for (const priv of privileges) {
        params.append(`privilege@${priv}`, grantOrDeny);
      }
      const formBody = params.toString();

      // .modifyAce.html is the registered Sling Jackrabbit Access Manager selector
      const aceUrl = `${folderPath}.modifyAce.html`;
      const r = await makeRequest('POST', aceUrl, {
        'Authorization': authHdr,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      }, formBody);

    sendJSON(res, r.status, r.body || JSON.stringify({ status: r.status }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
