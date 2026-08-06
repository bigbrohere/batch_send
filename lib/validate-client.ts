import { isAddress, getAddress } from "viem";
import bs58 from "bs58";

/**
 * Client-safe address validation. Imports only browser-safe modules (viem, bs58)
 * — never anything from lib/env or the Node runtime.
 */

const EVM_FORMAT = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate an EVM address: correct format, and a correct checksum when the string
 * is mixed-case. All-lowercase/all-uppercase are accepted as un-checksummed.
 */
export function isValidEvmAddress(value: string): boolean {
  const v = value.trim();
  if (!EVM_FORMAT.test(v)) return false;
  // 0x prefix is always lowercase 'x'; compare the hex body only.
  const body = v.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return isAddress(v);
  }
  try {
    return getAddress(v) === v;
  } catch {
    return false;
  }
}

/** Validate a base58 Solana public key (decodes to exactly 32 bytes). */
export function isValidSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value.trim()).length === 32;
  } catch {
    return false;
  }
}
