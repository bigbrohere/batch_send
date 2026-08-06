import { parseAmountToRaw } from "./amount";
import { isValidEvmAddress, isValidSolanaAddress } from "./validate-client";
import type { ChainKind, ParseError, Recipient } from "./types";

export interface ParseOptions {
  /**
   * When set, the same amount is applied to every recipient and each input line
   * is treated as a bare address (per-line amounts are rejected). When null,
   * each line must be `address<sep>amount`.
   */
  uniformAmount?: string | null;
}

/**
 * Parse the recipients textarea for a given chain.
 *
 * - Per-line mode (default): each non-empty line is `address<sep>amount`, where
 *   sep is comma, tab, or whitespace.
 * - Uniform mode (`uniformAmount` set): each non-empty line is a bare address and
 *   the shared amount is applied to all.
 *
 * Returns the parsed recipients and a list of blocking errors. In uniform mode a
 * bad shared amount is reported once with line 0.
 */
export function parseRecipients(
  text: string,
  kind: ChainKind,
  decimals: number,
  options: ParseOptions = {},
): { recipients: Recipient[]; errors: ParseError[] } {
  const recipients: Recipient[] = [];
  const errors: ParseError[] = [];

  const uniform = options.uniformAmount != null;

  // Validate the shared amount once, up front, in uniform mode.
  let uniformRaw: string | null = null;
  if (uniform) {
    try {
      uniformRaw = parseAmountToRaw(
        options.uniformAmount as string,
        decimals,
      ).toString();
    } catch (e) {
      errors.push({
        line: 0,
        content: options.uniformAmount as string,
        reason: e instanceof Error ? e.message : "Invalid shared amount",
      });
    }
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === "") return; // skip empty lines

    // Split on comma, tab, or runs of whitespace.
    const parts = trimmed.split(/[,\t\s]+/).filter((p) => p.length > 0);

    let address: string;
    let amountDecimal: string;

    if (uniform) {
      if (parts.length !== 1) {
        errors.push({
          line: lineNo,
          content: trimmed,
          reason:
            "Expected a single address per line (amount is set for all above)",
        });
        return;
      }
      address = parts[0];
      amountDecimal = options.uniformAmount as string;
    } else {
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
      [address, amountDecimal] = parts;
    }

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
    if (uniform) {
      // Shared amount already validated above; if it was invalid, skip rows so we
      // don't emit a per-line duplicate of the same error.
      if (uniformRaw == null) return;
      rawAmount = uniformRaw;
    } else {
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
