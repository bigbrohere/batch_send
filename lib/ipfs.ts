/**
 * IPFS URL helpers, shared by the client (to decide whether to proxy) and the
 * image proxy route (to resolve gateway candidates). Pure string logic.
 */

/** Ordered gateways, most reliable first. The proxy falls through the list. */
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://4everland.io/ipfs/",
];

/**
 * Extract the `<cid>/<path…>` portion from an `ipfs://` URI or any `/ipfs/`
 * gateway URL. Returns null when the URL isn't IPFS-backed.
 */
export function ipfsPath(url: string): string | null {
  const u = url.trim();
  if (u.startsWith("ipfs://")) {
    return u.slice("ipfs://".length).replace(/^ipfs\//, "");
  }
  const m = u.match(/\/ipfs\/(.+)$/);
  return m ? m[1] : null;
}

export function isIpfsUrl(url: string): boolean {
  return ipfsPath(url) !== null;
}
