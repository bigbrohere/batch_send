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

// Single adapter instance; swap here to change providers.
const provider: NftProvider = new AlchemyNftProvider();

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
  const items = await provider.getNftsForOwner(chain, address);
  cache.set(ck, { at: Date.now(), items });
  return items;
}
