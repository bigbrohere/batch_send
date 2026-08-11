import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/session";
import { enabledChains } from "@/lib/env";
import { receiptTimeoutFor } from "@/lib/chains";
import { evmAddress } from "@/lib/evm";
import { solanaAddress } from "@/lib/solana";

export const runtime = "nodejs";

/** Enabled chains + their sender address and native symbol. Enabled only. */
export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;

  try {
    const chains = enabledChains().map((c) => ({
      id: c.id,
      name: c.name,
      symbol: c.nativeSymbol,
      decimals: c.nativeDecimals,
      kind: c.kind,
      explorerBaseUrl: c.explorerBaseUrl,
      address: c.kind === "evm" ? evmAddress() : solanaAddress(),
      receiptTimeoutMs: receiptTimeoutFor(c),
    }));
    return NextResponse.json({ chains });
  } catch {
    return NextResponse.json(
      { error: "Failed to load wallet info" },
      { status: 500 },
    );
  }
}
