import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { fetchTokenInfo } from "@/lib/erc20";

export const runtime = "nodejs";

const schema = z.object({
  chain: z.string().min(1),
  contract: z.string().min(1),
});

/** ERC-20 metadata (symbol, decimals, name) for a contract on an EVM chain. */
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
  if (!isAddress(parsed.data.contract)) {
    return NextResponse.json(
      { error: "Invalid token contract address" },
      { status: 400 },
    );
  }

  try {
    const info = await fetchTokenInfo(chain, parsed.data.contract);
    return NextResponse.json(info);
  } catch {
    return NextResponse.json(
      { error: "Not an ERC-20 token on this chain" },
      { status: 400 },
    );
  }
}
