import {
  defineChain,
  type Chain as ViemChain,
} from "viem";
import { mainnet, base, arbitrum, polygon } from "viem/chains";

/**
 * Single source of truth for every supported chain.
 *
 * One EVM private key produces the same address on all EVM chains, so each EVM
 * entry only differs by network config. Solana is modeled here too so the UI can
 * treat the chain list uniformly, but it has its own key/address and code path.
 */

export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export type ChainKind = "evm" | "solana";

export interface ChainEntry {
  /** Stable string id used across the API and UI. */
  id: string;
  name: string;
  kind: ChainKind;
  /** Numeric chainId for EVM; null for Solana. */
  chainId: number | null;
  rpcEnvVar: string;
  /** Default public RPC, or null when an env var is mandatory. */
  defaultRpc: string | null;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Base explorer URL for a transaction; hash is appended directly. */
  explorerBaseUrl: string;
  /**
   * Known Multicall3 deployment address, or null when unknown/absent. Chains
   * marked null use the runtime getCode probe before deciding.
   */
  multicall3: string | null;
  /** viem Chain object for EVM chains; undefined for Solana. */
  viemChain?: ViemChain;
  /**
   * Minimum priority fee (wei) to enforce on EIP-1559 sends. When set, the
   * estimated maxPriorityFeePerGas is floored to this value so txs aren't
   * under-tipped. Omit on chains where tips don't affect inclusion/ordering.
   */
  minPriorityFeeWei?: bigint;
  /**
   * Max time (ms) the client polls for a receipt before marking a tx
   * "unconfirmed". Defaults handled at the call site when absent.
   */
  receiptTimeoutMs?: number;
  /** Whether the NFT console (discovery + transfers) is available on this chain. */
  nftSupport?: boolean;
  /** Which discovery adapter to use for this chain. Defaults to "alchemy". */
  nftProvider?: "alchemy" | "blockscout";
  /**
   * Alchemy network slug used to build the NFT API base URL
   * (`https://<slug>.g.alchemy.com/nft/v3/<key>`). Present only where nftSupport.
   */
  alchemyNetwork?: string;
  /**
   * Blockscout instance base URL (no trailing slash) for chains discovered via
   * the Blockscout NFT API (`/api/v2/addresses/{addr}/nft`). No API key needed.
   */
  blockscoutApiBase?: string;
}

// Custom chain objects for networks not shipped by viem.
export const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid.xyz/evm"] },
  },
  blockExplorers: {
    default: { name: "HyperEVM Scan", url: "https://hyperevmscan.io" },
  },
});

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

export const CHAINS: ChainEntry[] = [
  {
    id: "ethereum",
    name: "Ethereum",
    kind: "evm",
    chainId: 1,
    rpcEnvVar: "ETHEREUM_RPC_URL",
    defaultRpc: null, // L1 public endpoints are unreliable — require env.
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://etherscan.io/tx/",
    multicall3: MULTICALL3_ADDRESS,
    viemChain: mainnet,
    minPriorityFeeWei: 1_000_000_000n, // 1 gwei
    receiptTimeoutMs: 180_000,
    nftSupport: true,
    alchemyNetwork: "eth-mainnet",
  },
  {
    id: "base",
    name: "Base",
    kind: "evm",
    chainId: 8453,
    rpcEnvVar: "BASE_RPC_URL",
    defaultRpc: "https://mainnet.base.org",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://basescan.org/tx/",
    multicall3: MULTICALL3_ADDRESS,
    viemChain: base,
    minPriorityFeeWei: 50_000_000n, // 0.05 gwei
    receiptTimeoutMs: 60_000,
    nftSupport: true,
    alchemyNetwork: "base-mainnet",
  },
  {
    id: "arbitrum",
    name: "Arbitrum One",
    kind: "evm",
    chainId: 42161,
    rpcEnvVar: "ARBITRUM_RPC_URL",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://arbiscan.io/tx/",
    multicall3: MULTICALL3_ADDRESS,
    viemChain: arbitrum,
    // No minPriorityFeeWei: Nitro sequencer is FCFS — priority tips do not
    // affect ordering/inclusion, so flooring them only wastes fees.
    receiptTimeoutMs: 60_000,
    nftSupport: true,
    alchemyNetwork: "arb-mainnet",
  },
  {
    id: "polygon",
    name: "Polygon PoS",
    kind: "evm",
    chainId: 137,
    rpcEnvVar: "POLYGON_RPC_URL",
    defaultRpc: "https://polygon-rpc.com",
    nativeSymbol: "POL",
    nativeDecimals: 18,
    explorerBaseUrl: "https://polygonscan.com/tx/",
    multicall3: MULTICALL3_ADDRESS,
    viemChain: polygon,
    // No minPriorityFeeWei: leave current estimate behavior unchanged.
    receiptTimeoutMs: 60_000,
    nftSupport: true,
    alchemyNetwork: "polygon-mainnet",
  },
  {
    id: "hyperevm",
    name: "HyperEVM",
    kind: "evm",
    chainId: 999,
    rpcEnvVar: "HYPEREVM_RPC_URL",
    defaultRpc: "https://rpc.hyperliquid.xyz/evm",
    nativeSymbol: "HYPE",
    nativeDecimals: 18,
    explorerBaseUrl: "https://hyperevmscan.io/tx/",
    multicall3: null, // Unknown — probe with getCode at runtime.
    viemChain: hyperEvm,
    minPriorityFeeWei: 1_000_000_000n, // 1 gwei (HYPE)
    receiptTimeoutMs: 60_000,
  },
  {
    id: "robinhood",
    name: "Robinhood Chain",
    kind: "evm",
    chainId: 4663,
    rpcEnvVar: "ROBINHOOD_RPC_URL",
    defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorerBaseUrl: "https://robinhoodchain.blockscout.com/tx/",
    multicall3: null, // Unknown — probe with getCode at runtime.
    viemChain: robinhoodChain,
    // No minPriorityFeeWei: Arbitrum Nitro FCFS — tips do not affect ordering,
    // so flooring the priority fee only wastes funds.
    receiptTimeoutMs: 60_000,
    // NFTs via the chain's Blockscout instance (Alchemy has no Robinhood NFT API).
    nftSupport: true,
    nftProvider: "blockscout",
    blockscoutApiBase: "https://robinhoodchain.blockscout.com",
  },
  {
    id: "solana",
    name: "Solana",
    kind: "solana",
    chainId: null,
    rpcEnvVar: "SOLANA_RPC_URL",
    defaultRpc: null, // Require env — no reliable public default.
    nativeSymbol: "SOL",
    nativeDecimals: 9,
    explorerBaseUrl: "https://solscan.io/tx/",
    multicall3: null,
  },
];

/** Fallback receipt-polling timeout for any chain without an explicit value. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;

/** Receipt-polling timeout (ms) for a chain, from the registry. */
export function receiptTimeoutFor(chain: ChainEntry): number {
  return chain.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
}

export function getChain(id: string): ChainEntry | undefined {
  return CHAINS.find((c) => c.id === id);
}

export function getEvmChain(id: string): ChainEntry | undefined {
  const c = getChain(id);
  return c && c.kind === "evm" ? c : undefined;
}

export function explorerTxUrl(chain: ChainEntry, hash: string): string {
  return `${chain.explorerBaseUrl}${hash}`;
}
