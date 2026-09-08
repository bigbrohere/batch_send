import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { fetchTokenBalances } from "@/lib/erc20";

export const runtime = "nodejs";

const schema = z.object({
  chain: z.string().min(1),
  contract: z.string().min(1),
  addresses: z.array(z.string().min(1)).max(5000),
});

/** ERC-20 raw balances (base units, strings) for a list of holders. */
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
  if (
    !isAddress(parsed.data.contract) ||
    parsed.data.addresses.some((a) => !isAddress(a))
  ) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const balances = await fetchTokenBalances(
      chain,
      parsed.data.contract,
      Array.from(new Set(parsed.data.addresses)),
    );
    return NextResponse.json({ balances });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch token balances" },
      { status: 502 },
    );
  }
}
