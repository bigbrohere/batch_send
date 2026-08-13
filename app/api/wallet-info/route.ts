import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/session";
import { enabledChains } from "@/lib/env";
import { receiptTimeoutFor } from "@/lib/chains";
import { evmAddresses } from "@/lib/evm";
import { solanaAddresses } from "@/lib/solana";

export const runtime = "nodejs";

/** Enabled chains + their sender address and native symbol. Enabled only. */
export async function GET() {
  const unauth = requireAuth();
  if (unauth) return unauth;

  try {
    const enabled = enabledChains();
    // Only derive addresses for kinds that are actually enabled — deriving EVM
    // addresses with no EVM key (or vice versa) would throw.
    const evm = enabled.some((c) => c.kind === "evm") ? evmAddresses() : [];
    const solana = enabled.some((c) => c.kind === "solana")
      ? solanaAddresses()
      : [];
    const chains = enabled.map((c) => ({
      id: c.id,
      name: c.name,
      symbol: c.nativeSymbol,
      decimals: c.nativeDecimals,
      kind: c.kind,
      explorerBaseUrl: c.explorerBaseUrl,
      senders: c.kind === "evm" ? evm : solana,
      receiptTimeoutMs: receiptTimeoutFor(c),
      nftSupport: Boolean(c.nftSupport),
    }));
    return NextResponse.json({ chains });
  } catch {
    return NextResponse.json(
      { error: "Failed to load wallet info" },
      { status: 500 },
    );
  }
}
