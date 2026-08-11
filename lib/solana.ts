import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getChain } from "./chains";
import { rpcUrlFor, solanaPrivateKeys } from "./env";

/**
 * Server-side Solana helpers. Each secret key is a sender, provided in Phantom's
 * base58 export format (64-byte secret key).
 */

let cachedConnection: Connection | null = null;
let cachedKeypairs: Keypair[] | null = null;

/**
 * All configured Solana sender keypairs, in env order, de-duplicated by address.
 * Malformed keys are skipped (never logged) so one bad key can't disable Solana.
 */
export function solanaKeypairs(): Keypair[] {
  if (cachedKeypairs) return cachedKeypairs;
  const secrets = solanaPrivateKeys();
  if (secrets.length === 0) {
    throw new Error("No Solana private key is configured");
  }
  const seen = new Set<string>();
  const keypairs: Keypair[] = [];
  secrets.forEach((secret, i) => {
    try {
      const bytes = bs58.decode(secret);
      if (bytes.length !== 64) throw new Error("bad length");
      const kp = Keypair.fromSecretKey(bytes);
      const addr = kp.publicKey.toBase58();
      if (!seen.has(addr)) {
        seen.add(addr);
        keypairs.push(kp);
      }
    } catch {
      // Skip an invalid key without exposing its material.
      console.warn(`Skipping malformed Solana private key at index ${i}`);
    }
  });
  if (keypairs.length === 0) throw new Error("No valid Solana private key");
  cachedKeypairs = keypairs;
  return keypairs;
}

/** All Solana sender addresses (base58). */
export function solanaAddresses(): string[] {
  return solanaKeypairs().map((k) => k.publicKey.toBase58());
}

/** Find the sender keypair matching an address, or undefined. */
export function solanaKeypairForAddress(address: string): Keypair | undefined {
  return solanaKeypairs().find((k) => k.publicKey.toBase58() === address);
}

export function solanaConnection(): Connection {
  if (cachedConnection) return cachedConnection;
  const chain = getChain("solana")!;
  const rpc = rpcUrlFor(chain);
  if (!rpc) throw new Error("SOLANA_RPC_URL is not configured");
  cachedConnection = new Connection(rpc, "confirmed");
  return cachedConnection;
}

/** Validate a base58 Solana public key. */
export function isSolanaAddress(value: string): boolean {
  try {
    const pk = new PublicKey(value);
    // Reject values that decode to the wrong byte length.
    return pk.toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Fetch lamport balances for a list of base58 addresses. Uses
 * getMultipleAccountsInfo in chunks of 100; a missing account is 0 lamports.
 */
export async function fetchSolanaBalances(
  addresses: string[],
): Promise<Record<string, string>> {
  const conn = solanaConnection();
  const result: Record<string, string> = {};
  const CHUNK = 100;

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK);
    const pubkeys = slice.map((a) => new PublicKey(a));
    const infos = await conn.getMultipleAccountsInfo(pubkeys);
    slice.forEach((addr, j) => {
      const info = infos[j];
      result[addr] = info ? String(info.lamports) : "0";
    });
  }

  return result;
}
