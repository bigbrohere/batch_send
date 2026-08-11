import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  isAddress,
  getAddress,
  type PublicClient,
  type WalletClient,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MULTICALL3_ADDRESS,
  type ChainEntry,
} from "./chains";
import { evmPrivateKey, rpcUrlFor } from "./env";
import { mapWithConcurrency } from "./concurrency";

/**
 * Server-side EVM helpers built on viem. One private key is reused across every
 * EVM chain (same address). Clients are cached per chain in module scope.
 */

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

const publicClients = new Map<string, PublicClient>();
const walletClients = new Map<string, WalletClient>();

// Per-chain cache of whether Multicall3 is deployed. null = not yet probed.
const multicallPresence = new Map<string, boolean>();

function normalizedKey(): Hex {
  const key = evmPrivateKey();
  if (!key) throw new Error("EVM_PRIVATE_KEY is not configured");
  const withPrefix = key.startsWith("0x") ? key : `0x${key}`;
  return withPrefix as Hex;
}

export function evmAccount() {
  return privateKeyToAccount(normalizedKey());
}

export function evmAddress(): Address {
  return evmAccount().address;
}

export function publicClientFor(chain: ChainEntry): PublicClient {
  if (chain.kind !== "evm" || !chain.viemChain) {
    throw new Error(`Not an EVM chain: ${chain.id}`);
  }
  const cached = publicClients.get(chain.id);
  if (cached) return cached;

  const rpc = rpcUrlFor(chain);
  if (!rpc) throw new Error(`No RPC configured for ${chain.id}`);

  const client = createPublicClient({
    chain: chain.viemChain,
    transport: http(rpc),
  }) as PublicClient;
  publicClients.set(chain.id, client);
  return client;
}

export function walletClientFor(chain: ChainEntry): WalletClient {
  if (chain.kind !== "evm" || !chain.viemChain) {
    throw new Error(`Not an EVM chain: ${chain.id}`);
  }
  const cached = walletClients.get(chain.id);
  if (cached) return cached;

  const rpc = rpcUrlFor(chain);
  if (!rpc) throw new Error(`No RPC configured for ${chain.id}`);

  const client = createWalletClient({
    account: evmAccount(),
    chain: chain.viemChain,
    transport: http(rpc),
  });
  walletClients.set(chain.id, client);
  return client;
}

/**
 * Assert the RPC actually serves the chain we think it does. A mis-set RPC env
 * var must hard-fail here so we never sign a transaction for the wrong network.
 */
export async function assertChainId(chain: ChainEntry): Promise<number> {
  if (chain.chainId == null) throw new Error("Chain has no chainId");
  const client = publicClientFor(chain);
  const actual = await client.getChainId();
  if (actual !== chain.chainId) {
    throw new Error(
      `chainId mismatch for ${chain.id}: RPC reports ${actual}, expected ${chain.chainId}. Check ${chain.rpcEnvVar}.`,
    );
  }
  return actual;
}

/** EIP-1559 fee fields, or a legacy gasPrice, ready to spread into a tx. */
export type EvmFees =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint };

/**
 * Estimate fees and apply the chain's registry priority-fee floor, if any.
 *
 * The floor is read from the registry entry (keyed by chainId, never by name).
 * When the chain has no `minPriorityFeeWei`, estimates pass through unchanged.
 * When the floor raises the tip, `maxFeePerGas` is lifted to keep covering
 * base fee + the floored tip. All math is bigint.
 */
export async function resolveEvmFees(chain: ChainEntry): Promise<EvmFees> {
  const client = publicClientFor(chain);
  const fees = await client.estimateFeesPerGas();

  if (fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null) {
    let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    let maxFeePerGas = fees.maxFeePerGas;

    const floor = chain.minPriorityFeeWei;
    if (floor != null && maxPriorityFeePerGas < floor) {
      maxPriorityFeePerGas = floor; // max(estimated, floor)
      // Keep maxFeePerGas covering the raised tip: max(estMaxFee, tip + 2*base).
      const block = await client.getBlock({ blockTag: "latest" });
      const baseFee = block.baseFeePerGas ?? 0n;
      const needed = maxPriorityFeePerGas + 2n * baseFee;
      if (maxFeePerGas < needed) maxFeePerGas = needed;
    }
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  // Legacy (pre-1559) chains: no priority fee to floor; pass gasPrice through.
  return { gasPrice: fees.gasPrice ?? 0n };
}

/**
 * Decide whether Multicall3 can be used for this chain. Known deployments short
 * circuit; unknown chains are probed once via getCode and cached in module scope.
 */
export async function hasMulticall3(chain: ChainEntry): Promise<boolean> {
  if (multicallPresence.has(chain.id)) {
    return multicallPresence.get(chain.id)!;
  }
  let present: boolean;
  if (chain.multicall3) {
    present = true;
  } else {
    const client = publicClientFor(chain);
    const code = await client.getCode({ address: MULTICALL3_ADDRESS });
    present = Boolean(code && code !== "0x");
  }
  multicallPresence.set(chain.id, present);
  return present;
}

/**
 * Fetch native balances (in wei, as strings) for a list of addresses. Uses
 * Multicall3 when available, otherwise parallel getBalance with concurrency 10.
 */
export async function fetchEvmBalances(
  chain: ChainEntry,
  addresses: string[],
): Promise<Record<string, string>> {
  const client = publicClientFor(chain);
  const checksummed = addresses.map((a) => getAddress(a));

  const result: Record<string, string> = {};

  if (await hasMulticall3(chain)) {
    const contract = getContract({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      client,
    });
    const calls = checksummed.map((addr) =>
      contract.read.getEthBalance([addr]),
    );
    const balances = await Promise.all(calls);
    checksummed.forEach((addr, i) => {
      result[addr] = (balances[i] as bigint).toString();
    });
  } else {
    const balances = await mapWithConcurrency(
      checksummed,
      10,
      (addr) => client.getBalance({ address: addr as Address }),
    );
    checksummed.forEach((addr, i) => {
      result[addr] = balances[i].toString();
    });
  }

  return result;
}

export { isAddress, getAddress };
