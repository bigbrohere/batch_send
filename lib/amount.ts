/**
 * Decimal → raw-unit parsing with strict validation, shared by client preview
 * and server-side re-validation. Never uses floating point.
 */

/**
 * Parse a positive decimal string into raw base units (e.g. wei/lamports) given
 * the token's decimals. Throws on any malformed or out-of-precision input.
 */
export function parseAmountToRaw(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${input}" exceeds ${decimals} decimals of precision`,
    );
  }
  const paddedFrac = frac.padEnd(decimals, "0");
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(combined === "" ? "0" : combined);
  if (value <= 0n) {
    throw new Error(`Amount must be greater than zero: "${input}"`);
  }
  return value;
}

/** True when the amount string is a valid, positive, in-precision decimal. */
export function isValidAmount(input: string, decimals: number): boolean {
  try {
    parseAmountToRaw(input, decimals);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a raw base-unit value into a full-precision decimal string with
 * trailing zeros trimmed (and no scientific notation). No rounding.
 */
export function formatRaw(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  let frac = decimals > 0 ? s.slice(s.length - decimals) : "";
  frac = frac.replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}
