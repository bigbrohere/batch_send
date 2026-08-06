import { parseAmountToRaw } from "./amount";
import { isValidEvmAddress, isValidSolanaAddress } from "./validate-client";
import type { ChainKind, ParseError, Recipient } from "./types";

/**
 * Parse the recipients textarea for a given chain. Each non-empty line must be
 * `address<sep>amount` where sep is comma, tab, or whitespace. Returns the parsed
 * recipients and a list of per-line errors (blocking when non-empty).
 */
export function parseRecipients(
  text: string,
  kind: ChainKind,
  decimals: number,
): { recipients: Recipient[]; errors: ParseError[] } {
  const recipients: Recipient[] = [];
  const errors: ParseError[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === "") return; // skip empty lines

    // Split on comma, tab, or runs of whitespace.
    const parts = trimmed.split(/[,\t\s]+/).filter((p) => p.length > 0);
    if (parts.length !== 2) {
      errors.push({
        line: lineNo,
        content: trimmed,
        reason:
          parts.length < 2
            ? "Expected `address amount`"
            : "Too many fields — expected `address amount`",
      });
      return;
    }

    const [address, amountDecimal] = parts;

    const addressValid =
      kind === "evm"
        ? isValidEvmAddress(address)
        : isValidSolanaAddress(address);
    if (!addressValid) {
      errors.push({
        line: lineNo,
        content: trimmed,
        reason:
          kind === "evm"
            ? "Invalid EVM address (format/checksum)"
            : "Invalid Solana address",
      });
      return;
    }

    let rawAmount: string;
    try {
      rawAmount = parseAmountToRaw(amountDecimal, decimals).toString();
    } catch (e) {
      errors.push({
        line: lineNo,
        content: trimmed,
        reason: e instanceof Error ? e.message : "Invalid amount",
      });
      return;
    }

    recipients.push({
      line: lineNo,
      address,
      amountDecimal,
      rawAmount,
      status: "queued",
    });
  });

  return { recipients, errors };
}
