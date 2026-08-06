import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { fetchEvmBalances, getAddress, isAddress } from "@/lib/evm";
import { fetchSolanaBalances, isSolanaAddress } from "@/lib/solana";

export const runtime = "nodejs";

const schema = z.object({
  chain: z.string().min(1),
  addresses: z.array(z.string().min(1)).max(5000),
});

/** Return native balances in raw units (wei/lamports) as strings, keyed by address. */
export async function POST(req: Request) {
  const unauth = requireAuth();
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const chain = getChain(parsed.data.chain);
  if (!chain || !isChainEnabled(chain)) {
    return NextResponse.json(
      { error: "Chain not available" },
      { status: 400 },
    );
  }

  try {
    if (chain.kind === "evm") {
      const invalid = parsed.data.addresses.filter((a) => !isAddress(a));
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: "Invalid EVM address in list" },
          { status: 400 },
        );
      }
      // De-dupe by checksummed address to avoid redundant RPC work.
      const unique = Array.from(
        new Set(parsed.data.addresses.map((a) => getAddress(a))),
      );
      const balances = await fetchEvmBalances(chain, unique);
      return NextResponse.json({ balances });
    }

    // Solana
    const invalid = parsed.data.addresses.filter((a) => !isSolanaAddress(a));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "Invalid Solana address in list" },
        { status: 400 },
      );
    }
    const unique = Array.from(new Set(parsed.data.addresses));
    const balances = await fetchSolanaBalances(unique);
    return NextResponse.json({ balances });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch balances" },
      { status: 502 },
    );
  }
}
