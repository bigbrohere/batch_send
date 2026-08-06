import { NextResponse } from "next/server";
import type { Hash } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { publicClientFor } from "@/lib/evm";

export const runtime = "nodejs";

/**
 * Report the status of a single transaction: pending (not yet mined), success,
 * or reverted. The client polls this to flip row status.
 */
export async function GET(req: Request) {
  const unauth = requireAuth();
  if (unauth) return unauth;

  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain");
  const hash = url.searchParams.get("hash");

  if (!chainId || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const chain = getEvmChain(chainId);
  if (!chain || !isChainEnabled(chain)) {
    return NextResponse.json(
      { error: "Chain not available" },
      { status: 400 },
    );
  }

  try {
    const client = publicClientFor(chain);
    const receipt = await client
      .getTransactionReceipt({ hash: hash as Hash })
      .catch(() => null);

    if (!receipt) {
      return NextResponse.json({ status: "pending" });
    }
    return NextResponse.json({
      status: receipt.status === "success" ? "success" : "reverted",
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch receipt" },
      { status: 502 },
    );
  }
}
