import { getAddress, type Address } from "viem";
import type { ChainEntry } from "./chains";
import { publicClientFor } from "./evm";
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

  const results = await client.multicall({ contracts, allowFailure: true });

  return rows.map((r, i) => {
    const res = results[i];
    if (res.status !== "success") return false;
    if (r.standard === "erc721") {
      const owner = res.result as Address;
      return getAddress(owner) === getAddress(r.owner);
    }
    const bal = res.result as bigint;
    return bal >= BigInt(r.amount ?? "1");
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
