# MyIPTV Cloud Worker

A small Cloudflare Worker that exposes private, IPTV-player-friendly M3U and XMLTV URLs from configured upstream sources.

## Important architecture note

This Worker does **not** run the JioTV Go Go binary or perform JioTV login. Cloudflare Workers are not a place to run JioTV Go as a persistent Go server. The Worker fetches M3U/XMLTV files from an upstream server that you control or are authorized to use, caches them in Workers KV, and serves stable URLs for an IPTV player.

JioTV Go may require an eligible Indian residential network. A Cloudflare Worker does not provide an Indian residential IP. Do not try to spoof forwarding headers to bypass that restriction.

## Endpoints

- `GET /health` — configuration status; no authentication.
- `GET /playlist.m3u?token=YOUR_TOKEN` — protected M3U. Its `x-tvg-url` points to this service's protected `/epg.xml` endpoint.
- `GET /epg.xml?token=YOUR_TOKEN` — protected XMLTV. Gzipped upstream XML is decompressed automatically.

The playlist's channel stream URLs are preserved. This service does not relay video streams.

## Cloudflare setup

Requirements: a Cloudflare account, Node.js LTS, and npm.

1. Install Wrangler in this directory:

   ```sh
   npm install --save-dev wrangler
   ```

2. Create a KV namespace:

   ```sh
   npx wrangler kv namespace create CACHE
   ```

3. Copy the returned namespace ID into `kv_namespaces[0].id` in `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

4. Configure the upstream URLs in `wrangler.jsonc`:

   - `SOURCE_M3U_URL`: HTTPS URL serving an M3U playlist.
   - `SOURCE_EPG_URL`: HTTPS URL serving XMLTV, either plain XML or gzip-compressed XML.

   These must be reachable from Cloudflare. Do not put passwords, OTPs, API keys, or other secrets in these values.

5. Create a strong random API token and store it as a Worker secret:

   ```sh
   npx wrangler secret put API_TOKEN
   ```

   Do not commit the token to GitHub or share it in chat.

6. Deploy:

   ```sh
   npx wrangler deploy
   ```

7. Test:

   ```sh
   curl https://YOUR-WORKER.workers.dev/health
   curl "https://YOUR-WORKER.workers.dev/playlist.m3u?token=YOUR_TOKEN"
   ```

   Add the playlist URL to your IPTV app. The M3U advertises the matching EPG URL automatically.

## Local development

After creating the KV namespace and setting local values in a `.dev.vars` file (do not commit it), run:

```sh
npx wrangler dev
```

Example `.dev.vars`:

```dotenv
API_TOKEN=replace-with-a-long-random-token
SOURCE_M3U_URL=https://example.com/playlist.m3u
SOURCE_EPG_URL=https://example.com/epg.xml
```

## Caching

M3U defaults to 180 seconds and EPG to 900 seconds. Change `M3U_CACHE_SECONDS` and `EPG_CACHE_SECONDS` in `wrangler.jsonc` as needed. KV is eventually consistent, so it is used only as a cache here, not as an authentication database.

## Current limitations

- An upstream M3U and XMLTV source must already exist.
- The Worker does not authenticate to JioTV, run JioTV Go, or obtain residential network access.
- Stream URLs are passed through unchanged and may expire or be region-restricted.
- This is a playlist/EPG gateway, not a video proxy.
