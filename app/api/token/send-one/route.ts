import { NextResponse } from "next/server";
import { z } from "zod";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import {
  assertChainId,
  evmAccountForAddress,
  publicClientFor,
  resolveEvmFees,
  walletClientFor,
} from "@/lib/evm";
import { ERC20_ABI, tokenDecimals } from "@/lib/erc20";
import { parseAmountToRaw } from "@/lib/amount";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  chain: z.string().min(1),
  from: z.string().min(1),
  contract: z.string().min(1),
  to: z.string().min(1),
  // Either a decimal amount (re-parsed with the token's decimals) or a raw
  // base-unit amount (used for full-balance sweeps).
  amountDecimal: z.string().optional(),
  amountRaw: z.string().regex(/^\d+$/).optional(),
  nonce: z.number().int().nonnegative(),
});

const GAS_HEADROOM_NUM = 120n;
const GAS_HEADROOM_DEN = 100n;

/**
 * Sign and broadcast one ERC-20 transfer from any configured wallet (the main
 * funding wallet or a burner). Server resolves the token's decimals itself and
 * re-parses the amount, validates the recipient, estimates gas (+20% headroom),
 * and applies the registry priority-fee floor.
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

  const { from, to, contract, amountDecimal, amountRaw, nonce } = parsed.data;
  if (!isAddress(to) || !isAddress(from) || !isAddress(contract)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const toAddr = getAddress(to);
  if (toAddr === zeroAddress) {
    return NextResponse.json(
      { error: "Refusing transfer to the zero address" },
      { status: 400 },
    );
  }

  const account = evmAccountForAddress(from);
  if (!account) {
    return NextResponse.json(
      { error: "Unknown sender address" },
      { status: 400 },
    );
  }

  try {
    await assertChainId(chain);

    // Resolve amount authoritatively server-side.
    let value: bigint;
    if (amountRaw != null) {
      value = BigInt(amountRaw);
    } else if (amountDecimal != null) {
      const decimals = await tokenDecimals(chain, contract);
      value = parseAmountToRaw(amountDecimal, decimals);
    } else {
      return NextResponse.json({ error: "Missing amount" }, { status: 400 });
    }
    if (value <= 0n) {
      return NextResponse.json(
        { error: "Amount must be greater than zero" },
        { status: 400 },
      );
    }

    const tokenAddr = getAddress(contract) as Address;
    const client = walletClientFor(chain, account);

    // Estimate gas (reverts here on insufficient balance — before any signing).
    const publicEstimate = await publicClientFor(chain).estimateContractGas({
      address: tokenAddr,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddr, value],
      account: account.address,
    });
    const gas = (publicEstimate * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;

    const fees = await resolveEvmFees(chain);
    const hash = await client.writeContract({
      address: tokenAddr,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddr, value],
      account,
      chain: chain.viemChain,
      gas,
      nonce,
      ...fees,
    });

    return NextResponse.json({ hash });
  } catch (e) {
    const message =
      e instanceof Error && /chainId mismatch/.test(e.message)
        ? e.message
        : "Transfer failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
