import { NextResponse } from "next/server";
import { z } from "zod";
import type { Address } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import {
  assertChainId,
  getAddress,
  isAddress,
  walletClientFor,
} from "@/lib/evm";
import { parseAmountToRaw } from "@/lib/amount";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  chain: z.string().min(1),
  to: z.string().min(1),
  amountDecimal: z.string().min(1),
  nonce: z.number().int().nonnegative(),
});

/**
 * Sign and broadcast a single native transfer. The server re-parses the decimal
 * amount to wei itself and re-validates the address; it returns the hash without
 * waiting for confirmation (the client polls the receipt endpoint).
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

  if (!isAddress(parsed.data.to)) {
    return NextResponse.json(
      { error: "Invalid recipient address" },
      { status: 400 },
    );
  }

  let value: bigint;
  try {
    value = parseAmountToRaw(parsed.data.amountDecimal, chain.nativeDecimals);
  } catch {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }

  try {
    // Re-assert chainId before signing so a mis-set RPC can never send funds on
    // the wrong network.
    await assertChainId(chain);
    const wallet = walletClientFor(chain);
    const hash = await wallet.sendTransaction({
      account: wallet.account!,
      chain: chain.viemChain,
      to: getAddress(parsed.data.to) as Address,
      value,
      nonce: parsed.data.nonce,
    });
    return NextResponse.json({ hash });
  } catch (e) {
    const message =
      e instanceof Error && /chainId mismatch/.test(e.message)
        ? e.message
        : "Transaction failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
