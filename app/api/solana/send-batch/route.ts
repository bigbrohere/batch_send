import { NextResponse } from "next/server";
import { z } from "zod";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { requireAuth } from "@/lib/session";
import { getChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import {
  isSolanaAddress,
  solanaConnection,
  solanaKeypair,
} from "@/lib/solana";
import { parseAmountToRaw } from "@/lib/amount";

export const runtime = "nodejs";
export const maxDuration = 60;

const SOLANA_DECIMALS = 9;

const schema = z.object({
  transfers: z
    .array(
      z.object({
        to: z.string().min(1),
        amountDecimal: z.string().min(1),
      }),
    )
    .min(1)
    .max(15),
});

/**
 * Build one transaction with up to 15 SystemProgram.transfer instructions, sign,
 * send, and confirm at 'confirmed'. Amounts are re-parsed to lamports server-side
 * and every address re-validated.
 */
export async function POST(req: Request) {
  const unauth = requireAuth();
  if (unauth) return unauth;

  const chain = getChain("solana");
  if (!chain || !isChainEnabled(chain)) {
    return NextResponse.json(
      { error: "Chain not available" },
      { status: 400 },
    );
  }

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

  for (const t of parsed.data.transfers) {
    if (!isSolanaAddress(t.to)) {
      return NextResponse.json(
        { error: "Invalid recipient address" },
        { status: 400 },
      );
    }
  }

  let lamports: bigint[];
  try {
    lamports = parsed.data.transfers.map((t) =>
      parseAmountToRaw(t.amountDecimal, SOLANA_DECIMALS),
    );
  } catch {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }

  try {
    const conn = solanaConnection();
    const payer = solanaKeypair();
    const tx = new Transaction();
    parsed.data.transfers.forEach((t, i) => {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: new PublicKey(t.to),
          lamports: lamports[i],
        }),
      );
    });

    const signature = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
    });
    return NextResponse.json({ signature });
  } catch {
    return NextResponse.json(
      { error: "Batch transaction failed" },
      { status: 400 },
    );
  }
}
