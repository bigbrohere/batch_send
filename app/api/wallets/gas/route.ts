import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { fetchEvmBalances } from "@/lib/evm";
import { burnerList, fundingAddress } from "@/lib/wallets";

export const runtime = "nodejs";

const schema = z.object({ chain: z.string().min(1) });

/**
 * Native gas balances (raw wei strings) for the funding wallet and every burner
 * on the active chain, via the existing multicall path.
 */
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

  const chain = getEvmChain(parsed.data.chain);
  if (!chain || !isChainEnabled(chain)) {
    return NextResponse.json({ error: "Chain not available" }, { status: 400 });
  }

  try {
    const addresses = [
      ...(fundingAddress() ? [fundingAddress() as string] : []),
      ...burnerList().map((b) => b.address),
    ];
    if (addresses.length === 0) {
      return NextResponse.json({ balances: {} });
    }
    const balances = await fetchEvmBalances(chain, addresses);
    return NextResponse.json({ balances });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch gas balances" },
      { status: 502 },
    );
  }
}
