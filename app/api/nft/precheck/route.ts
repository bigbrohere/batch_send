import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  estimateTransferGas,
  verifyOwnership,
  type OwnershipRow,
} from "@/lib/nft-onchain";
import type { PrecheckResult } from "@/lib/nft-types";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  chain: z.string().min(1),
  rows: z
    .array(
      z.object({
        contract: z.string().min(1),
        tokenId: z.string().min(1),
        standard: z.enum(["erc721", "erc1155"]),
        owner: z.string().min(1),
        to: z.string().min(1),
        amount: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Per-row ownership + gas precheck. Ownership is verified with a single multicall
 * (ownerOf / balanceOf); owned rows then get a gas estimate. Rows that are not
 * owned are surfaced (never silently dropped) so the UI can exclude them.
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

  const rows = parsed.data.rows;

  try {
    const owned = await verifyOwnership(chain, rows as OwnershipRow[]);

    const results = await mapWithConcurrency<
      (typeof rows)[number],
      PrecheckResult
    >(rows, 5, async (row, i) => {
      if (!owned[i]) return { status: "not_owned", reason: "not owned" };
      try {
        const gas = await estimateTransferGas(chain, row as OwnershipRow & {
          to: string;
        });
        return { status: "ok", gasEstimate: gas.toString() };
      } catch {
        // Owned but estimate failed — keep it ok without an estimate so the row
        // is not silently dropped; the transfer will surface any real error.
        return { status: "ok" };
      }
    });

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "Precheck failed" }, { status: 502 });
  }
}
