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

export function evmPrivateKey(): string | undefined {
  return readEnv("EVM_PRIVATE_KEY");
}

export function solanaPrivateKey(): string | undefined {
  return readEnv("SOLANA_PRIVATE_KEY");
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
 * A chain is enabled when its keys and (where required) RPC are present:
 *  - EVM: requires EVM_PRIVATE_KEY. Ethereum additionally requires its RPC env
 *    var. The other five EVM chains fall back to a default public RPC.
 *  - Solana: requires both SOLANA_PRIVATE_KEY and SOLANA_RPC_URL.
 */
export function isChainEnabled(chain: ChainEntry): boolean {
  if (chain.kind === "evm") {
    if (!evmPrivateKey()) return false;
    // Any chain without a default RPC (e.g. Ethereum) needs an explicit env var.
    return rpcUrlFor(chain) !== undefined;
  }
  // Solana
  return Boolean(solanaPrivateKey()) && rpcUrlFor(chain) !== undefined;
}

export function enabledChains(): ChainEntry[] {
  return CHAINS.filter(isChainEnabled);
}

export function isChainIdEnabled(id: string): boolean {
  const c = getChain(id);
  return c ? isChainEnabled(c) : false;
}
