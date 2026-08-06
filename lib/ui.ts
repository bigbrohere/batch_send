export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Sum an array of decimal-string raw amounts as bigint. */
export function sumRaw(values: string[]): bigint {
  return values.reduce((acc, v) => acc + BigInt(v), 0n);
}
