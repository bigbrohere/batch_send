import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/session";
import { burnerList, fundingAddress } from "@/lib/wallets";

export const runtime = "nodejs";

/**
 * Wallet roster for the NFT console: the funding wallet address and the burner
 * wallets (address + index). Addresses only — never key material.
 */
export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;

  try {
    const funding = fundingAddress();
    return NextResponse.json({
      funding: funding ? { address: funding } : null,
      burners: burnerList(),
    });
  } catch (e) {
    // Malformed key -> message names the index only (never the key material).
    const message =
      e instanceof Error ? e.message : "Failed to load wallets";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
