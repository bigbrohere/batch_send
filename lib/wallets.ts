import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { evmBurnerKeys, evmFundingKeys } from "./env";

/**
 * Two-role wallet model for the NFT console:
 *  - FUNDING wallet: derived from EVM_PRIVATE_KEY. Powers native sends (the gas
 *    distribution tool). Never signs NFT transfers.
 *  - BURNER wallets: derived from EVM_PRIVATE_KEYS. Own and transfer NFTs.
 *
 * The client only ever sees addresses. Signing routes resolve an account from an
 * address via this module; unknown address -> reject. Keys are never logged or
 * included in errors/responses — malformed entries are reported by INDEX only.
 *
 * This module is intentionally independent of lib/evm's merged sender pool so the
 * existing native Send tab keeps working unchanged.
 */

export interface BurnerWallet {
  account: PrivateKeyAccount;
  index: number;
}

export interface WalletModel {
  funding: PrivateKeyAccount | null;
  /** Burners, in env order, excluding the funding address, de-duplicated. */
  burners: BurnerWallet[];
  /** Lowercased-address -> burner account (funding excluded). */
  burnerByAddress: Map<string, PrivateKeyAccount>;
}

let cached: WalletModel | null = null;

function normalizeKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/**
 * Build the wallet model from env. Throws a clear, key-free error (naming the
 * offending index) if a burner or funding key is malformed. An empty/absent
 * EVM_PRIVATE_KEYS is not an error — it yields zero burners.
 */
export function walletModel(): WalletModel {
  if (cached) return cached;

  // Funding wallet: first valid key from EVM_PRIVATE_KEY (may be absent).
  const fundingKeys = evmFundingKeys();
  let funding: PrivateKeyAccount | null = null;
  fundingKeys.forEach((key, i) => {
    if (funding) return;
    try {
      funding = privateKeyToAccount(normalizeKey(key));
    } catch {
      throw new Error(`EVM_PRIVATE_KEY entry at index ${i} is invalid`);
    }
  });

  const fundingAddress = funding
    ? (funding as PrivateKeyAccount).address.toLowerCase()
    : null;

  const burners: BurnerWallet[] = [];
  const burnerByAddress = new Map<string, PrivateKeyAccount>();
  const seen = new Set<string>();

  evmBurnerKeys().forEach((key, i) => {
    let account: PrivateKeyAccount;
    try {
      account = privateKeyToAccount(normalizeKey(key));
    } catch {
      throw new Error(`EVM_PRIVATE_KEYS entry at index ${i} is invalid`);
    }
    const lower = account.address.toLowerCase();
    // Dedupe, and never surface the funding wallet as a burner.
    if (lower === fundingAddress || seen.has(lower)) return;
    seen.add(lower);
    burnerByAddress.set(lower, account);
    burners.push({ account, index: burners.length });
  });

  cached = { funding, burners, burnerByAddress };
  return cached;
}

/** Funding wallet address, or null when EVM_PRIVATE_KEY is absent. */
export function fundingAddress(): Address | null {
  return walletModel().funding?.address ?? null;
}

/** Burner wallets as `{ address, index }` for the client (addresses only). */
export function burnerList(): { address: Address; index: number }[] {
  return walletModel().burners.map((b) => ({
    address: b.account.address,
    index: b.index,
  }));
}

/** True when the address is the configured funding wallet. */
export function isFundingAddress(address: string): boolean {
  if (!isAddress(address)) return false;
  const f = walletModel().funding;
  return !!f && getAddress(address) === f.address;
}

/**
 * Resolve a BURNER account by address for NFT signing. Returns undefined when the
 * address is not a configured burner (including when it is the funding wallet).
 */
export function burnerAccountForAddress(
  address: string,
): PrivateKeyAccount | undefined {
  if (!isAddress(address)) return undefined;
  return walletModel().burnerByAddress.get(address.toLowerCase());
}
