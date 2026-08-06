import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getChain } from "./chains";
import { rpcUrlFor, solanaPrivateKey } from "./env";

/**
 * Server-side Solana helpers. The secret key is provided in Phantom's base58
 * export format (64-byte secret key).
 */

let cachedConnection: Connection | null = null;

export function solanaKeypair(): Keypair {
  const secret = solanaPrivateKey();
  if (!secret) throw new Error("SOLANA_PRIVATE_KEY is not configured");
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error(
      "SOLANA_PRIVATE_KEY must be a 64-byte base58 secret key (Phantom export format)",
    );
  }
  return Keypair.fromSecretKey(bytes);
}

export function solanaAddress(): string {
  return solanaKeypair().publicKey.toBase58();
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
