export interface Env {
  CACHE: KVNamespace;
  API_TOKEN: string;
  SOURCE_M3U_URL: string;
  SOURCE_EPG_URL: string;
  M3U_CACHE_SECONDS?: string;
  EPG_CACHE_SECONDS?: string;
}

const encoder = new TextEncoder();

function response(body: string, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.API_TOKEN) return false;
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const supplied = bearer || url.searchParams.get("token") || "";
  return supplied.length > 0 && constantTimeEqual(supplied, env.API_TOKEN);
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchText(sourceUrl: string, maxBytes: number): Promise<string> {
  if (!validHttpsUrl(sourceUrl)) throw new Error("Source URL must be a valid HTTPS URL");
  const upstream = await fetch(sourceUrl, {
    headers: { "user-agent": "MyIPTV-Cloud/1.0" },
    redirect: "follow",
  });
  if (!upstream.ok) throw new Error(`Upstream returned HTTP ${upstream.status}`);
  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("Upstream response exceeded the size limit");

  let decoded = buffer;
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip) {
    decoded = await new Response(
      new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    if (decoded.byteLength > maxBytes) throw new Error("Decompressed response exceeded the size limit");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
}

async function getCachedSource(
  env: Env,
  key: string,
  sourceUrl: string,
  ttlValue: string | undefined,
  maxBytes: number,
): Promise<string> {
  const cached = await env.CACHE.get(key);
  if (cached !== null) return cached;

  const value = await fetchText(sourceUrl, maxBytes);
  const ttl = Math.max(60, Math.min(86400, Number(ttlValue) || 300));
  await env.CACHE.put(key, value, { expirationTtl: ttl });
  return value;
}

function addEpgUrl(m3u: string, epgUrl: string): string {
  const lines = m3u.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.trim().startsWith("#EXTM3U")) {
    throw new Error("The configured playlist is not a valid M3U file");
  }
  lines[0] = lines[0]
    .replace(/\s+(?:x-tvg-url|url-tvg|tvg-url)=(?:"[^"]*"|'[^']*')/gi, "")
    .trimEnd() + ` x-tvg-url="${epgUrl}"`;
  return lines.join("\n").trimEnd() + "\n";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response("Method not allowed", 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "MyIPTV Cloud",
        status: "ok",
        configured: {
          playlist: Boolean(env.SOURCE_M3U_URL),
          epg: Boolean(env.SOURCE_EPG_URL),
          cache: Boolean(env.CACHE),
          authentication: Boolean(env.API_TOKEN),
        },
        note: "This Worker formats and caches configured M3U/XMLTV sources; it does not run the JioTV Go server.",
      }, { headers: { "cache-control": "no-store" } });
    }

    if (!["/playlist.m3u", "/epg.xml"].includes(url.pathname)) {
      return response("Not found", 404);
    }
    if (!(await isAuthorized(request, env))) {
      return response("Unauthorized", 401);
    }

    try {
      if (url.pathname === "/playlist.m3u") {
        if (!env.SOURCE_M3U_URL) return response("SOURCE_M3U_URL is not configured", 503);
        const m3u = await getCachedSource(
          env, "source:m3u:v1", env.SOURCE_M3U_URL, env.M3U_CACHE_SECONDS, 5 * 1024 * 1024,
        );
        const epgUrl = new URL("/epg.xml", url.origin);
        epgUrl.searchParams.set("token", url.searchParams.get("token") || env.API_TOKEN);
        const output = addEpgUrl(m3u, epgUrl.toString());
        return new Response(request.method === "HEAD" ? null : output, {
          headers: {
            "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (!env.SOURCE_EPG_URL) return response("SOURCE_EPG_URL is not configured", 503);
      const xml = await getCachedSource(
        env, "source:epg:v1", env.SOURCE_EPG_URL, env.EPG_CACHE_SECONDS, 25 * 1024 * 1024,
      );
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<tv(?:\s|>)/i.test(xml)) {
        return response("The configured EPG source is not valid XMLTV", 502);
      }
      return new Response(request.method === "HEAD" ? null : xml, {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return response(`Source error: ${message}`, 502);
    }
  },
};
