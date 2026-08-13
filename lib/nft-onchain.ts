import { getAddress, type Address } from "viem";
import { MULTICALL3_ADDRESS, type ChainEntry } from "./chains";
import { hasMulticall3, publicClientFor } from "./evm";
import { mapWithConcurrency } from "./concurrency";
import { ERC721_ABI, ERC1155_ABI } from "./nft-abi";
import type { NftStandard } from "./nft-types";

/**
 * On-chain NFT helpers shared by precheck and transfer-one: ownership
 * verification (multicall), gas estimation, and safe-transfer call encoding.
 * All reads/estimates go through the per-chain dRPC public client.
 */

export interface OwnershipRow {
  contract: string;
  tokenId: string;
  standard: NftStandard;
  owner: string;
  /** ERC-1155 amount to verify/transfer; defaults to "1". */
  amount?: string;
}

/** viem writeContract-ready call for a safe transfer of one item. */
export function transferCall(
  standard: NftStandard,
  from: string,
  to: string,
  tokenId: string,
  amount?: string,
) {
  const fromAddr = getAddress(from);
  const toAddr = getAddress(to);
  if (standard === "erc721") {
    return {
      abi: ERC721_ABI,
      functionName: "safeTransferFrom" as const,
      args: [fromAddr, toAddr, BigInt(tokenId)] as const,
    };
  }
  return {
    abi: ERC1155_ABI,
    functionName: "safeTransferFrom" as const,
    args: [
      fromAddr,
      toAddr,
      BigInt(tokenId),
      BigInt(amount ?? "1"),
      "0x" as const,
    ] as const,
  };
}

/**
 * Verify ownership of each row via a single multicall. ERC-721 → ownerOf ===
 * owner; ERC-1155 → balanceOf(owner, id) >= amount. A reverting call (e.g. a
 * burned token) counts as not owned.
 */
export async function verifyOwnership(
  chain: ChainEntry,
  rows: OwnershipRow[],
): Promise<boolean[]> {
  if (rows.length === 0) return [];
  const client = publicClientFor(chain);

  const isOwned = (r: OwnershipRow, ok: boolean, value: unknown): boolean => {
    if (!ok) return false;
    if (r.standard === "erc721") {
      return getAddress(value as Address) === getAddress(r.owner);
    }
    return (value as bigint) >= BigInt(r.amount ?? "1");
  };

  const contracts = rows.map((r) =>
    r.standard === "erc721"
      ? {
          address: getAddress(r.contract) as Address,
          abi: ERC721_ABI,
          functionName: "ownerOf" as const,
          args: [BigInt(r.tokenId)] as const,
        }
      : {
          address: getAddress(r.contract) as Address,
          abi: ERC1155_ABI,
          functionName: "balanceOf" as const,
          args: [getAddress(r.owner), BigInt(r.tokenId)] as const,
        },
  );

  // Prefer Multicall3 when deployed. Pass the address explicitly so custom chains
  // (whose viem chain object has no multicall3 config) still work; otherwise fall
  // back to individual reads with bounded concurrency.
  if (await hasMulticall3(chain)) {
    const results = await client.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    });
    return rows.map((r, i) =>
      isOwned(r, results[i].status === "success", results[i].result),
    );
  }

  return mapWithConcurrency(contracts, 10, async (c, i) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = await client.readContract(c as any);
      return isOwned(rows[i], true, value);
    } catch {
      return false;
    }
  });
}

/** Estimate gas (units) for a single safe transfer from the owning burner. */
export async function estimateTransferGas(
  chain: ChainEntry,
  row: OwnershipRow & { to: string },
): Promise<bigint> {
  const client = publicClientFor(chain);
  const call = transferCall(
    row.standard,
    row.owner,
    row.to,
    row.tokenId,
    row.amount,
  );
  return client.estimateContractGas({
    address: getAddress(row.contract) as Address,
    abi: call.abi,
    functionName: call.functionName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: call.args as any,
    account: getAddress(row.owner),
  });
}
