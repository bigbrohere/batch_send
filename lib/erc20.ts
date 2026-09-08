import { getAddress, type Address } from "viem";
import { MULTICALL3_ADDRESS, type ChainEntry } from "./chains";
import { hasMulticall3, publicClientFor } from "./evm";
import { mapWithConcurrency } from "./concurrency";

/**
 * Minimal ERC-20 helpers: metadata, balances (multicall), and the transfer call.
 * Reads/estimates go through the per-chain dRPC public client, like everything
 * else. Token decimals are resolved server-side so amounts can't be spoofed.
 */

export const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export interface TokenInfo {
  contract: string;
  symbol: string;
  decimals: number;
  name: string;
}

// Cache decimals per (chain,contract) so signing routes don't re-fetch each tx.
const decimalsCache = new Map<string, number>();

export async function fetchTokenInfo(
  chain: ChainEntry,
  contract: string,
): Promise<TokenInfo> {
  const client = publicClientFor(chain);
  const address = getAddress(contract) as Address;

  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
    client
      .readContract({ address, abi: ERC20_ABI, functionName: "symbol" })
      .catch(() => ""),
    client
      .readContract({ address, abi: ERC20_ABI, functionName: "name" })
      .catch(() => ""),
  ]);

  const dec = Number(decimals);
  decimalsCache.set(`${chain.id}:${address.toLowerCase()}`, dec);
  return {
    contract: address,
    decimals: dec,
    symbol: (symbol as string) || "TOKEN",
    name: (name as string) || "",
  };
}

export async function tokenDecimals(
  chain: ChainEntry,
  contract: string,
): Promise<number> {
  const key = `${chain.id}:${getAddress(contract).toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached != null) return cached;
  const info = await fetchTokenInfo(chain, contract);
  return info.decimals;
}

/** Raw balances (base units, as strings) for a list of holders. */
export async function fetchTokenBalances(
  chain: ChainEntry,
  contract: string,
  addresses: string[],
): Promise<Record<string, string>> {
  const client = publicClientFor(chain);
  const address = getAddress(contract) as Address;
  const holders = addresses.map((a) => getAddress(a));
  const result: Record<string, string> = {};

  if (await hasMulticall3(chain)) {
    const res = await client.multicall({
      contracts: holders.map((h) => ({
        address,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [h] as const,
      })),
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    });
    holders.forEach((h, i) => {
      result[h] =
        res[i].status === "success" ? (res[i].result as bigint).toString() : "0";
    });
  } else {
    const bals = await mapWithConcurrency(holders, 10, (h) =>
      client
        .readContract({
          address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [h],
        })
        .catch(() => 0n),
    );
    holders.forEach((h, i) => {
      result[h] = (bals[i] as bigint).toString();
    });
  }

  return result;
}
