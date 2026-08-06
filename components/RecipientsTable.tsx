"use client";

import type { ChainInfo, Recipient, RowStatus } from "@/lib/types";
import { formatRaw } from "@/lib/amount";
import { truncateAddress } from "@/lib/ui";

const STATUS_META: Record<
  RowStatus,
  { dot: string; label: string; text: string }
> = {
  queued: { dot: "bg-zinc-600", label: "queued", text: "text-zinc-400" },
  sending: { dot: "bg-amber-400 animate-pulse", label: "sending", text: "text-amber-300" },
  pending: { dot: "bg-sky-400 animate-pulse", label: "pending", text: "text-sky-300" },
  confirmed: { dot: "bg-emerald-500", label: "confirmed", text: "text-emerald-300" },
  failed: { dot: "bg-red-500", label: "failed", text: "text-red-300" },
  unconfirmed: { dot: "bg-yellow-500", label: "unconfirmed", text: "text-yellow-300" },
};

function StatusCell({ r }: { r: Recipient }) {
  const meta = STATUS_META[r.status];
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`flex items-center gap-1.5 ${meta.text}`}>
        <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
        {meta.label}
      </span>
      {r.error && (
        <span className="text-[10px] text-red-400/90" title={r.error}>
          {r.error.length > 60 ? `${r.error.slice(0, 60)}…` : r.error}
        </span>
      )}
    </div>
  );
}

export function RecipientsTable({
  recipients,
  chain,
}: {
  recipients: Recipient[];
  chain: ChainInfo;
}) {
  if (recipients.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-edge">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-panelalt text-[11px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2 text-right">#</th>
            <th className="px-3 py-2 text-left">Address</th>
            <th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2 text-right">Current balance</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Tx</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {recipients.map((r, i) => (
            <tr key={`${r.address}-${r.line}`} className="hover:bg-panelalt/50">
              <td className="px-3 py-2 text-right text-zinc-500 num">{i + 1}</td>
              <td className="px-3 py-2">
                <span className="num" title={r.address}>
                  {truncateAddress(r.address, 8, 6)}
                </span>
              </td>
              <td className="px-3 py-2 text-right num">
                {r.amountDecimal}{" "}
                <span className="text-zinc-500">{chain.symbol}</span>
              </td>
              <td
                className="px-3 py-2 text-right num text-zinc-300"
                title={
                  r.balanceRaw != null
                    ? `${r.balanceRaw} raw`
                    : undefined
                }
              >
                {r.balanceRaw != null
                  ? `${formatRaw(r.balanceRaw, chain.decimals)}`
                  : "—"}
              </td>
              <td className="px-3 py-2">
                <StatusCell r={r} />
              </td>
              <td className="px-3 py-2">
                {r.hash ? (
                  <a
                    href={`${chain.explorerBaseUrl}${r.hash}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="num text-sky-400 hover:underline"
                    title={r.hash}
                  >
                    {truncateAddress(r.hash, 6, 6)}
                  </a>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
