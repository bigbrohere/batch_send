import { NextResponse } from "next/server";
import { z } from "zod";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { requireAuth } from "@/lib/session";
import { getEvmChain } from "@/lib/chains";
import { isChainEnabled } from "@/lib/env";
import { assertChainId, resolveEvmFees, walletClientFor } from "@/lib/evm";
import { burnerAccountForAddress, isFundingAddress } from "@/lib/wallets";
import {
  estimateTransferGas,
  transferCall,
  verifyOwnership,
} from "@/lib/nft-onchain";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  chain: z.string().min(1),
  from: z.string().min(1),
  contract: z.string().min(1),
  tokenId: z.string().min(1),
  standard: z.enum(["erc721", "erc1155"]),
  to: z.string().min(1),
  amount: z.string().optional(),
  nonce: z.number().int().nonnegative(),
});

const GAS_HEADROOM_NUM = 120n;
const GAS_HEADROOM_DEN = 100n;

/**
 * Sign and broadcast one NFT transfer from a BURNER wallet. Before signing:
 * refuse the funding wallet (403), re-verify ownership, checksum-validate the
 * recipient, reject the zero address and self-transfer, estimate gas with +20%
 * headroom, and apply the chain's registry priority-fee floor.
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

  const { from, to, contract, tokenId, standard, amount, nonce } = parsed.data;

  // Recipient validation: valid checksum, not the zero address, not self.
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
  if (toAddr === getAddress(from)) {
    return NextResponse.json(
      { error: "Recipient must differ from sender" },
      { status: 400 },
    );
  }

  // NFT transfers must never sign with the funding wallet.
  if (isFundingAddress(from)) {
    return NextResponse.json(
      { error: "Funding wallet cannot sign NFT transfers" },
      { status: 403 },
    );
  }
  const account = burnerAccountForAddress(from);
  if (!account) {
    return NextResponse.json(
      { error: "Unknown burner address" },
      { status: 400 },
    );
  }

  try {
    await assertChainId(chain);

    // Re-verify ownership on-chain to avoid wasting gas on a stale row.
    const [owned] = await verifyOwnership(chain, [
      { contract, tokenId, standard, owner: account.address, amount },
    ]);
    if (!owned) {
      return NextResponse.json(
        { error: "Sender no longer owns this token" },
        { status: 409 },
      );
    }

    // Gas limit: estimate + 20% headroom (never the native-send 21000 constant).
    const estimated = await estimateTransferGas(chain, {
      contract,
      tokenId,
      standard,
      owner: account.address,
      to: toAddr,
      amount,
    });
    const gas = (estimated * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;

    const fees = await resolveEvmFees(chain);
    const call = transferCall(standard, account.address, toAddr, tokenId, amount);
    const wallet = walletClientFor(chain, account);

    const hash = await wallet.writeContract({
      address: getAddress(contract) as Address,
      abi: call.abi,
      functionName: call.functionName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: call.args as any,
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
