import { CHAINS, getChain, type ChainEntry } from "./chains";

/**
 * Server-only environment access + chain enablement rules.
 *
 * Never import this from a client component. All values here are read from
 * process.env at request time and must never be exposed to the browser.
 */

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Read one or more values from the given env vars, splitting each on comma,
 * semicolon, or whitespace/newlines. Order is preserved and exact duplicates are
 * removed. Safe for hex (0x…) and base58 keys, which never contain separators.
 */
function readEnvList(...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const v = process.env[name];
    if (v == null) continue;
    for (const token of v.split(/[\s,;]+/)) {
      const t = token.trim();
      if (t) out.push(t);
    }
  }
  return Array.from(new Set(out));
}

/** All configured EVM private keys (one key = one sender address, all chains). */
export function evmPrivateKeys(): string[] {
  return readEnvList("EVM_PRIVATE_KEY", "EVM_PRIVATE_KEYS");
}

/**
 * Funding-wallet key(s): the FUNDING role for the NFT console (EVM_PRIVATE_KEY).
 * The funding wallet powers native sends and is never used to sign NFT transfers.
 */
export function evmFundingKeys(): string[] {
  return readEnvList("EVM_PRIVATE_KEY");
}

/** Burner-wallet keys: the BURNER role for the NFT console (EVM_PRIVATE_KEYS). */
export function evmBurnerKeys(): string[] {
  return readEnvList("EVM_PRIVATE_KEYS");
}

/** Alchemy NFT API key — used for read-only NFT discovery, never tx broadcast. */
export function alchemyNftApiKey(): string | undefined {
  return readEnv("ALCHEMY_NFT_API_KEY");
}

/** All configured Solana secret keys (base58, Phantom export format). */
export function solanaPrivateKeys(): string[] {
  return readEnvList("SOLANA_PRIVATE_KEY", "SOLANA_PRIVATE_KEYS");
}

export function adminPassword(): string | undefined {
  return readEnv("ADMIN_PASSWORD");
}

export function sessionSecret(): string | undefined {
  return readEnv("SESSION_SECRET");
}

/**
 * Resolve the RPC URL for a chain, honoring the env override and falling back to
 * the registry default. Returns undefined when no URL is available.
 */
export function rpcUrlFor(chain: ChainEntry): string | undefined {
  return readEnv(chain.rpcEnvVar) ?? chain.defaultRpc ?? undefined;
}

/**
 * A chain is enabled when at least one key and (where required) RPC are present:
 *  - EVM: requires at least one EVM key. Ethereum additionally requires its RPC
 *    env var. The other five EVM chains fall back to a default public RPC.
 *  - Solana: requires at least one Solana key and SOLANA_RPC_URL.
 */
export function isChainEnabled(chain: ChainEntry): boolean {
  if (chain.kind === "evm") {
    if (evmPrivateKeys().length === 0) return false;
    // Any chain without a default RPC (e.g. Ethereum) needs an explicit env var.
    return rpcUrlFor(chain) !== undefined;
  }
  // Solana
  return solanaPrivateKeys().length > 0 && rpcUrlFor(chain) !== undefined;
}

export function enabledChains(): ChainEntry[] {
  return CHAINS.filter(isChainEnabled);
}

export function isChainIdEnabled(id: string): boolean {
  const c = getChain(id);
  return c ? isChainEnabled(c) : false;
}
