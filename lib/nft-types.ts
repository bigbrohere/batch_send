export type NftStandard = "erc721" | "erc1155";

/** A single owned NFT, normalized across providers. Client-safe (no secrets). */
export interface NftItem {
  contract: string;
  /** String — token ids can exceed Number.MAX_SAFE_INTEGER. */
  tokenId: string;
  standard: NftStandard;
  /** ERC-1155 balance as a string; "1" for ERC-721. */
  balance: string;
  name: string;
  collectionName: string;
  imageUrl: string | null;
  /** Registry chain id this item was discovered on. */
  chain: string;
}

/** Precheck result for one prospective transfer row. */
export interface PrecheckResult {
  status: "ok" | "not_owned";
  /** Gas units estimate (string) for ok rows. */
  gasEstimate?: string;
  reason?: string;
}
