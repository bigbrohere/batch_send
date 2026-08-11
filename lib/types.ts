export type ChainKind = "evm" | "solana";

export interface ChainInfo {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  kind: ChainKind;
  explorerBaseUrl: string;
  address: string;
  /** Max ms the client polls for an EVM receipt before marking it unconfirmed. */
  receiptTimeoutMs: number;
}

export type RowStatus =
  | "queued"
  | "sending"
  | "pending"
  | "confirmed"
  | "failed"
  | "unconfirmed";

export interface Recipient {
  line: number;
  address: string;
  amountDecimal: string;
  /** Raw base-unit amount as string, for totals. */
  rawAmount: string;
  balanceRaw?: string;
  status: RowStatus;
  hash?: string;
  error?: string;
}

export interface ParseError {
  line: number;
  content: string;
  reason: string;
}
