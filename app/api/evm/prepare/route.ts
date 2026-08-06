import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { assertChainId, evmAddress, publicClientFor } from "@/lib/evm";

export const runtime = "nodejs";

const schema = z.object({ chain: z.string().min(1) });

/**
 * Verify the RPC serves the expected chainId (hard-fails on mismatch, nothing is
 * signed), then return the sender and its pending nonce for the client loop.
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
    return NextResponse.json(
      { error: "Chain not available" },
      { status: 400 },
    );
  }

  try {
    const chainId = await assertChainId(chain);
    const from = evmAddress();
    const client = publicClientFor(chain);
    const nonce = await client.getTransactionCount({
      address: from,
      blockTag: "pending",
    });
    return NextResponse.json({ from, nonce, chainId });
  } catch (e) {
    const message =
      e instanceof Error && /chainId mismatch/.test(e.message)
        ? e.message
        : "Failed to prepare transaction";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
