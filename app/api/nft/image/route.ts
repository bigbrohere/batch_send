import { requireAuth } from "@/lib/session";
import { IPFS_GATEWAYS, ipfsPath } from "@/lib/ipfs";

export const runtime = "nodejs";
export const maxDuration = 20;

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Server-side image proxy for NFT thumbnails. IPFS-backed URLs are resolved
 * against several gateways (first success wins); plain https images are fetched
 * directly. Returns the image bytes with a long cache header, or 404 when every
 * candidate fails (the client then shows its placeholder).
 *
 * Auth-guarded like every route; same-origin <img> requests carry the session
 * cookie automatically.
 */
export async function GET(req: Request) {
  const unauth = requireAuth();
  if (unauth) return unauth;

  const u = new URL(req.url).searchParams.get("u");
  if (!u) return new Response("missing url", { status: 400 });

  // Build candidate URLs. Only http(s) and ipfs are allowed.
  const path = ipfsPath(u);
  let candidates: string[];
  if (path) {
    candidates = IPFS_GATEWAYS.map((g) => g + path);
  } else if (/^https?:\/\//i.test(u)) {
    candidates = [u];
  } else {
    return new Response("unsupported url", { status: 400 });
  }

  for (const c of candidates) {
    try {
      const res = await fetchWithTimeout(c);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      // Skip gateway error pages / non-images.
      if (ct.startsWith("text/") || ct.includes("html")) continue;
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len && len > MAX_BYTES) continue;

      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) continue;

      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": ct || "application/octet-stream",
          "cache-control": "public, max-age=86400, immutable",
        },
      });
    } catch {
      // timeout / network — try the next gateway
    }
  }

  return new Response("not found", { status: 404 });
}
