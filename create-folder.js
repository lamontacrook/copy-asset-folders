#!/usr/bin/env node

/**
 * Creates a new folder in AEM Assets using the Assets HTTP API.
 *
 * Usage:
 *   node create-folder.js --host <host> --path <parent-path> --name <folder-name> [--title <title>] --user <user> --pass <password>
 *
 * Example:
 *   node create-folder.js \
 *     --host https://author-p186976-e1967129.adobeaemcloud.com \
 *     --path /content/dam/my-project \
 *     --name new-folder \
 *     --title "New Folder" \
 *     --user admin \
 *     --pass admin
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

function createFolder({ host, path, name, title, user, pass }) {
  if (!host || !path || !name || !user || !pass) {
    console.error('Missing required arguments: --host, --path, --name, --user, --pass');
    console.error('Usage: node create-folder.js --host <host> --path <parent-path> --name <folder-name> [--title <title>] --user <user> --pass <password>');
    process.exit(1);
  }

  const folderTitle = title || name;
  const apiPath = `/api/assets${path}/${name}`;
  const body = JSON.stringify({
    class: 'assetFolder',
    properties: {
      'dc:title': folderTitle,
    },
  });

  const baseUrl = new URL(host);
  const isHttps = baseUrl.protocol === 'https:';
  const requestModule = isHttps ? https : http;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  const options = {
    hostname: baseUrl.hostname,
    port: baseUrl.port || (isHttps ? 443 : 80),
    path: apiPath,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  console.log(`Creating folder "${name}" at ${host}${apiPath} ...`);

  return new Promise((resolve, reject) => {
    const req = requestModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 201) {
          console.log(`✓ Folder created successfully (HTTP ${res.statusCode})`);
          try {
            const json = JSON.parse(data);
            console.log('Response:', JSON.stringify(json, null, 2));
          } catch {
            console.log('Response:', data);
          }
          resolve({ status: res.statusCode, body: data });
        } else {
          console.error(`✗ Failed to create folder (HTTP ${res.statusCode})`);
          console.error('Response:', data);
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

const args = parseArgs(process.argv);
createFolder(args).catch(() => process.exit(1));
