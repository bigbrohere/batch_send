import type { ChainEntry } from "./chains";
import type { NftItem, NftStandard } from "./nft-types";
import { alchemyNftApiKey } from "./env";

/**
 * NFT discovery layer. UI and API depend on the NftProvider interface only, so
 * swapping the adapter is a one-file change. The Alchemy key is used here for
 * read-only discovery over HTTPS and is never used to broadcast transactions.
 */
export interface NftProvider {
  getNftsForOwner(chain: ChainEntry, address: string): Promise<NftItem[]>;
}

// --- Concurrency limiter (module-global, cap 3 across all Alchemy calls) ------
const MAX_CONCURRENCY = 3;
let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

// --- Per-(chain,address) cache, 60s TTL ---------------------------------------
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; items: NftItem[] }>();

function cacheKey(chainId: string, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with exponential backoff on HTTP 429 (1s base, up to 3 retries). */
async function fetchWithBackoff(url: string): Promise<Response> {
  const BASE_MS = 1000;
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
    await sleep(BASE_MS * 2 ** attempt);
  }
}

interface AlchemyNft {
  contract?: {
    address?: string;
    name?: string;
    tokenType?: string;
    openSeaMetadata?: { collectionName?: string | null } | null;
  };
  tokenId?: string;
  tokenType?: string;
  name?: string | null;
  balance?: string;
  image?: {
    thumbnailUrl?: string | null;
    cachedUrl?: string | null;
    originalUrl?: string | null;
  } | null;
}

function normalizeStandard(value: string | undefined): NftStandard {
  return value?.toUpperCase() === "ERC1155" ? "erc1155" : "erc721";
}

function mapItem(chain: ChainEntry, nft: AlchemyNft): NftItem | null {
  const contract = nft.contract?.address;
  const tokenId = nft.tokenId;
  if (!contract || tokenId == null) return null;

  const standard = normalizeStandard(nft.tokenType ?? nft.contract?.tokenType);
  const collectionName =
    nft.contract?.openSeaMetadata?.collectionName ??
    nft.contract?.name ??
    "";
  const imageUrl =
    nft.image?.thumbnailUrl ?? nft.image?.cachedUrl ?? nft.image?.originalUrl ??
    null;

  return {
    contract,
    tokenId,
    standard,
    balance: nft.balance ?? "1",
    name: nft.name?.trim() ? nft.name.trim() : `#${tokenId}`,
    collectionName,
    imageUrl,
    chain: chain.id,
  };
}

class AlchemyNftProvider implements NftProvider {
  async getNftsForOwner(
    chain: ChainEntry,
    address: string,
  ): Promise<NftItem[]> {
    if (!chain.nftSupport || !chain.alchemyNetwork) {
      throw new Error(`NFTs not supported on ${chain.id}`);
    }
    const key = alchemyNftApiKey();
    if (!key) throw new Error("ALCHEMY_NFT_API_KEY is not configured");

    const base = `https://${chain.alchemyNetwork}.g.alchemy.com/nft/v3/${key}/getNFTsForOwner`;
    const items: NftItem[] = [];
    let pageKey: string | undefined;
    const MAX_PAGES = 20; // safety bound (~2000 NFTs)

    await acquire();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          owner: address,
          withMetadata: "true",
          pageSize: "100",
        });
        if (pageKey) params.set("pageKey", pageKey);

        const res = await fetchWithBackoff(`${base}?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Alchemy NFT API error ${res.status}`);
        }
        const data = (await res.json()) as {
          ownedNfts?: AlchemyNft[];
          pageKey?: string;
        };
        for (const raw of data.ownedNfts ?? []) {
          const item = mapItem(chain, raw);
          if (item) items.push(item);
        }
        if (!data.pageKey) break;
        pageKey = data.pageKey;
      }
    } finally {
      release();
    }

    return items;
  }
}

// --- Blockscout adapter (keyless; for chains Alchemy doesn't index) ----------
interface BlockscoutNft {
  id?: string;
  token_type?: string;
  value?: string;
  image_url?: string | null;
  metadata?: { name?: string | null; image?: string | null } | null;
  token?: { address?: string; name?: string | null; type?: string } | null;
}

function mapBlockscoutItem(
  chain: ChainEntry,
  nft: BlockscoutNft,
): NftItem | null {
  const contract = nft.token?.address;
  const tokenId = nft.id;
  if (!contract || tokenId == null) return null;

  const standard = normalizeStandard(nft.token_type ?? nft.token?.type);
  const name = nft.metadata?.name?.trim()
    ? (nft.metadata.name as string).trim()
    : `#${tokenId}`;

  return {
    contract,
    tokenId,
    standard,
    balance: nft.value && nft.value !== "0" ? nft.value : "1",
    name,
    collectionName: nft.token?.name ?? "",
    imageUrl: nft.image_url ?? nft.metadata?.image ?? null,
    chain: chain.id,
  };
}

class BlockscoutNftProvider implements NftProvider {
  async getNftsForOwner(
    chain: ChainEntry,
    address: string,
  ): Promise<NftItem[]> {
    if (!chain.nftSupport || !chain.blockscoutApiBase) {
      throw new Error(`Blockscout NFT discovery unavailable for ${chain.id}`);
    }
    const base = `${chain.blockscoutApiBase}/api/v2/addresses/${address}/nft`;
    const items: NftItem[] = [];
    // next_page_params is an opaque object echoed back as query params.
    let nextParams: Record<string, string | number> | null = null;
    const MAX_PAGES = 20;
    // Some Blockscout versions reject the combined `type` value — drop it if so.
    let useTypeFilter = true;

    await acquire();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams();
        if (useTypeFilter) params.set("type", "ERC-721,ERC-1155");
        if (nextParams) {
          for (const [k, v] of Object.entries(nextParams)) {
            params.set(k, String(v));
          }
        }
        const qs = params.toString();
        const res = await fetchWithBackoff(qs ? `${base}?${qs}` : base);

        if (!res.ok) {
          // Retry the first page once without the type filter before giving up.
          if (useTypeFilter && page === 0 && res.status >= 400 && res.status < 500) {
            useTypeFilter = false;
            page = -1; // loop will ++ back to 0
            continue;
          }
          const snippet = (await res.text().catch(() => "")).slice(0, 120);
          throw new Error(
            `Blockscout NFT API ${res.status} at ${chain.blockscoutApiBase}` +
              (snippet ? ` — ${snippet}` : ""),
          );
        }

        const data = (await res.json().catch(() => null)) as {
          items?: BlockscoutNft[];
          next_page_params?: Record<string, string | number> | null;
        } | null;
        if (!data) {
          throw new Error(
            `Blockscout NFT API at ${chain.blockscoutApiBase} returned non-JSON`,
          );
        }
        for (const raw of data.items ?? []) {
          const item = mapBlockscoutItem(chain, raw);
          if (item) items.push(item);
        }
        if (!data.next_page_params) break;
        nextParams = data.next_page_params;
      }
    } finally {
      release();
    }

    return items;
  }
}

// Adapter instances; select per chain via its registry `nftProvider`.
const alchemyProvider: NftProvider = new AlchemyNftProvider();
const blockscoutProvider: NftProvider = new BlockscoutNftProvider();

function providerForChain(chain: ChainEntry): NftProvider {
  return chain.nftProvider === "blockscout"
    ? blockscoutProvider
    : alchemyProvider;
}

/**
 * Discover NFTs for one owner on one chain, served from a 60s cache unless
 * `refresh` bypasses it. One wallet per call (progressive fan-out lives in the
 * client, never a single all-wallets request).
 */
export async function getNftsForOwnerCached(
  chain: ChainEntry,
  address: string,
  refresh = false,
): Promise<NftItem[]> {
  const ck = cacheKey(chain.id, address);
  if (!refresh) {
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  }
  const items = await providerForChain(chain).getNftsForOwner(chain, address);
  cache.set(ck, { at: Date.now(), items });
  return items;
}
