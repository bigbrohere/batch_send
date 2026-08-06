import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { publicClientFor } from "@/lib/evm";

export const runtime = "nodejs";

const schema = z.object({ chain: z.string().min(1) });

const GAS_PER_TRANSFER = 21000n;

/**
 * Current per-transfer gas cost estimate (wei, as string) for the dry-run
 * preview: 21000 gas × current fee-per-gas. Uses estimateFeesPerGas, which viem
 * derives from EIP-1559 fields where supported and legacy gasPrice otherwise.
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
    const client = publicClientFor(chain);
    const fees = await client.estimateFeesPerGas();
    const perGas =
      fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const perTransfer = GAS_PER_TRANSFER * perGas;
    return NextResponse.json({
      gasLimit: GAS_PER_TRANSFER.toString(),
      feePerGas: perGas.toString(),
      perTransfer: perTransfer.toString(),
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to estimate fees" },
      { status: 502 },
    );
  }
}
