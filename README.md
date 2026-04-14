# AEM Assets — Create Folders & Copy Assets

A lightweight local web UI + Node.js proxy server for bulk-creating DAM folders in AEM as a Cloud Service and copying assets from a source folder into each one.

## Features

- Create one or more DAM folders in a single run
- Copy all assets from a source folder (e.g. `seat-00`) into each newly created folder
- Comma-separated batch input for folder names
- Live per-folder progress with collapsible detail rows
- Proxy server bypasses browser CORS restrictions

## Prerequisites

- [Node.js](https://nodejs.org/) v14 or later
- An AEM as a Cloud Service author instance
- A valid IMS Bearer token with DAM write permissions

## Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/lamontacrook/copy-asset-folders.git
   cd copy-asset-folders
   ```

2. Start the proxy server:

   ```bash
   node server.js
   ```

3. Open your browser to [http://localhost:3000](http://localhost:3000).

## Usage

| Field | Description |
|---|---|
| **AEM Host** | Your author URL, e.g. `https://author-p12345-e67890.adobeaemcloud.com` |
| **Bearer Token** | IMS access token (paste from Developer Console or token exchange) |
| **Parent DAM Path** | The DAM path to create folders under, e.g. `/content/dam/my-project` |
| **Folder Names** | Comma-separated list of folder names to create, e.g. `seat-01, seat-02, seat-03` |
| **Source Folder** | DAM path whose assets will be copied into each new folder, e.g. `/content/dam/seat-00` |

Click **Create Folders & Copy Assets** to run. The tool will:

1. List all assets in the source folder once
2. For each folder name in the list:
   - Create the folder via the AEM Assets HTTP API
   - Copy every asset from the source folder into the new folder

Results are shown per folder with a live progress bar and a final summary.

## CLI Alternative

A standalone Node.js script is also included for creating a single folder without the UI:

```bash
node create-folder.js \
  --host https://author-p12345-e67890.adobeaemcloud.com \
  --path /content/dam/my-project \
  --name new-folder \
  --title "New Folder" \
  --user admin \
  --pass yourpassword
```

## How It Works

The browser UI sends requests to the local proxy server (`server.js`) rather than directly to AEM. The proxy forwards each request server-to-server, which avoids browser CORS restrictions. Three proxy endpoints are used:

| Endpoint | Method | Purpose |
|---|---|---|
| `/proxy/create-folder` | POST | Creates a DAM folder via `POST /api/assets/{path}` |
| `/proxy/list-assets` | POST | Lists assets in a folder via `GET /api/assets/{path}.json` |
| `/proxy/copy-asset` | POST | Copies an asset via `COPY /api/assets/{path}` with `X-Destination` header |
