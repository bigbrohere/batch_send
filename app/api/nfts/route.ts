import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { getNftsForOwnerCached } from "@/lib/nft-provider";
import { burnerAccountForAddress } from "@/lib/wallets";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  chain: z.string().min(1),
  address: z.string().min(1),
  refresh: z.boolean().optional(),
});

/**
 * NFTs owned by ONE burner wallet on one chain. The client fans out one request
 * per wallet for progressive loading — a single all-wallets request is forbidden.
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
  if (!chain || !isChainEnabled(chain) || !chain.nftSupport) {
    return NextResponse.json(
      { error: "NFTs not available on this chain" },
      { status: 400 },
    );
  }

  // Only discover for configured burner wallets.
  const account = burnerAccountForAddress(parsed.data.address);
  if (!account) {
    return NextResponse.json(
      { error: "Unknown burner address" },
      { status: 400 },
    );
  }

  try {
    const items = await getNftsForOwnerCached(
      chain,
      account.address,
      parsed.data.refresh ?? false,
    );
    return NextResponse.json({ address: account.address, items });
  } catch {
    return NextResponse.json(
      { error: "Failed to load NFTs" },
      { status: 502 },
    );
  }
}
