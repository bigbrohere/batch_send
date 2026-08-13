"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAddress } from "viem";
import type { ChainInfo, ParseError, Recipient } from "@/lib/types";
import { parseRecipients } from "@/lib/parse";
import { formatRaw } from "@/lib/amount";
import { sumRaw, truncateAddress } from "@/lib/ui";
import { CopyButton } from "@/components/CopyButton";
import { RecipientsTable } from "@/components/RecipientsTable";

const SOLANA_CHUNK = 15;
const SOLANA_FEE_PER_SIG = 5000n; // lamports
const RECEIPT_POLL_MS = 2000;

function normalizeAddr(addr: string, kind: "evm" | "solana"): string {
  return kind === "evm" ? getAddress(addr) : addr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SendTab() {
  const router = useRouter();

  const [chains, setChains] = useState<ChainInfo[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [uniformMode, setUniformMode] = useState(false);
  const [uniformAmount, setUniformAmount] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [parsed, setParsed] = useState(false);

  const [senderBalanceRaw, setSenderBalanceRaw] = useState<string | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);

  const [feePerTransfer, setFeePerTransfer] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);

  const [executing, setExecuting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [hasFailure, setHasFailure] = useState(false);

  const activeChain = useMemo(
    () => chains?.find((c) => c.id === activeId) ?? null,
    [chains, activeId],
  );

  // Keep latest recipients in a ref so the async execution loop reads fresh state.
  const recipientsRef = useRef<Recipient[]>([]);
  recipientsRef.current = recipients;

  const patchRow = useCallback((index: number, patch: Partial<Recipient>) => {
    setRecipients((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], ...patch };
      recipientsRef.current = next;
      return next;
    });
  }, []);

  // --- Load enabled chains + sender addresses ------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/wallet-info");
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error("Failed to load wallet info");
        const data = (await res.json()) as { chains: ChainInfo[] };
        if (cancelled) return;
        setChains(data.chains);
        const first = data.chains[0];
        setActiveId(first?.id ?? null);
        setSelectedSender(first?.senders[0] ?? null);
      } catch {
        if (!cancelled) setLoadError("Failed to load wallet info");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // --- Chain switch clears parse state -------------------------------------
  const switchChain = useCallback(
    (id: string) => {
      setActiveId(id);
      const next = chains?.find((c) => c.id === id);
      // Keep the current sender when it's valid on the new chain (all EVM chains
      // share the same sender set); otherwise default to that chain's first.
      setSelectedSender((prev) =>
        next && prev && next.senders.includes(prev)
          ? prev
          : (next?.senders[0] ?? null),
      );
      setRecipients([]);
      setParseErrors([]);
      setParsed(false);
      // Amounts mean a different token per chain — clear the shared amount too.
      setUniformAmount("");
      setSenderBalanceRaw(null);
      setFeePerTransfer(null);
      setFeeError(null);
      setRunError(null);
      setHasFailure(false);
    },
    [chains],
  );

  // --- Balances ------------------------------------------------------------
  const fetchBalances = useCallback(
    async (rows: Recipient[]) => {
      if (!activeChain || !selectedSender) return;
      setLoadingBalances(true);
      try {
        const recipientAddrs = rows.map((r) =>
          normalizeAddr(r.address, activeChain.kind),
        );
        const senderAddr = selectedSender;
        const all = Array.from(new Set([senderAddr, ...recipientAddrs]));
        const res = await fetch("/api/balances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chain: activeChain.id, addresses: all }),
        });
        if (!res.ok) throw new Error("balances failed");
        const data = (await res.json()) as {
          balances: Record<string, string>;
        };
        setSenderBalanceRaw(data.balances[senderAddr] ?? "0");
        setRecipients((prev) => {
          const next = prev.map((r) => {
            const key = normalizeAddr(r.address, activeChain.kind);
            return { ...r, balanceRaw: data.balances[key] ?? "0" };
          });
          recipientsRef.current = next;
          return next;
        });
      } catch {
        // Leave existing values; balances are best-effort for display.
      } finally {
        setLoadingBalances(false);
      }
    },
    [activeChain, selectedSender],
  );

  // Refresh sender balance only (used before we have recipients).
  const refreshAll = useCallback(async () => {
    await fetchBalances(recipientsRef.current);
  }, [fetchBalances]);

  // Load balances whenever the active chain or selected sender changes.
  useEffect(() => {
    if (activeChain && selectedSender) void fetchBalances(recipientsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selectedSender]);

  // --- Fee estimate (EVM) --------------------------------------------------
  const fetchFees = useCallback(async () => {
    if (!activeChain || activeChain.kind !== "evm") {
      setFeePerTransfer(null);
      return;
    }
    setFeeError(null);
    try {
      const res = await fetch("/api/evm/fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChain.id }),
      });
      if (!res.ok) throw new Error("fees failed");
      const data = (await res.json()) as { perTransfer: string };
      setFeePerTransfer(data.perTransfer);
    } catch {
      setFeeError("Could not estimate gas");
      setFeePerTransfer(null);
    }
  }, [activeChain]);

  // --- Parse ---------------------------------------------------------------
  const onParse = useCallback(async () => {
    if (!activeChain) return;
    setRunError(null);
    setHasFailure(false);
    const { recipients: parsedRows, errors } = parseRecipients(
      text,
      activeChain.kind,
      activeChain.decimals,
      { uniformAmount: uniformMode ? uniformAmount.trim() : null },
    );
    setParseErrors(errors);
    if (errors.length > 0) {
      setParsed(false);
      setRecipients([]);
      return;
    }
    setRecipients(parsedRows);
    recipientsRef.current = parsedRows;
    setParsed(true);
    await Promise.all([fetchBalances(parsedRows), fetchFees()]);
  }, [activeChain, text, uniformMode, uniformAmount, fetchBalances, fetchFees]);

  // --- Totals / preview ----------------------------------------------------
  const totalAmountRaw = useMemo(
    () => sumRaw(recipients.map((r) => r.rawAmount)),
    [recipients],
  );

  const solanaBatchCount = useMemo(
    () => Math.ceil(recipients.length / SOLANA_CHUNK),
    [recipients.length],
  );

  const gasCostRaw = useMemo(() => {
    if (!activeChain) return 0n;
    if (activeChain.kind === "solana") {
      return SOLANA_FEE_PER_SIG * BigInt(solanaBatchCount);
    }
    if (feePerTransfer == null) return 0n;
    return BigInt(feePerTransfer) * BigInt(recipients.length);
  }, [activeChain, feePerTransfer, recipients.length, solanaBatchCount]);

  const totalCostRaw = totalAmountRaw + gasCostRaw;

  const insufficientFunds = useMemo(() => {
    if (senderBalanceRaw == null) return false;
    return BigInt(senderBalanceRaw) < totalCostRaw;
  }, [senderBalanceRaw, totalCostRaw]);

  // --- Execution: EVM ------------------------------------------------------
  const runEvm = useCallback(async () => {
    if (!activeChain || !selectedSender) return;
    setRunError(null);
    setExecuting(true);
    setHasFailure(false);
    try {
      const prep = await fetch("/api/evm/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChain.id, from: selectedSender }),
      });
      if (!prep.ok) {
        const body = await prep.json().catch(() => ({}));
        setRunError(body.error ?? "Failed to prepare");
        setHasFailure(true);
        return;
      }
      let { nonce } = (await prep.json()) as { nonce: number };

      const rows = recipientsRef.current;
      for (let i = 0; i < rows.length; i++) {
        const current = recipientsRef.current[i];
        // Never re-send rows already broadcast/confirmed.
        if (current.status === "confirmed" || current.status === "unconfirmed") {
          continue;
        }

        patchRow(i, { status: "sending", error: undefined });
        let hash: string;
        try {
          const res = await fetch("/api/evm/send-one", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chain: activeChain.id,
              from: selectedSender,
              to: current.address,
              amountDecimal: current.amountDecimal,
              nonce,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? "send failed");
          }
          ({ hash } = (await res.json()) as { hash: string });
        } catch (e) {
          patchRow(i, {
            status: "failed",
            error: e instanceof Error ? e.message : "send failed",
          });
          setHasFailure(true);
          return; // stop the loop on failure
        }

        // Broadcast succeeded — consume the nonce locally and start polling.
        nonce += 1;
        patchRow(i, { status: "pending", hash });

        const deadline = Date.now() + activeChain.receiptTimeoutMs;
        let settled = false;
        while (Date.now() < deadline) {
          await sleep(RECEIPT_POLL_MS);
          try {
            const r = await fetch(
              `/api/evm/receipt?chain=${encodeURIComponent(
                activeChain.id,
              )}&hash=${hash}`,
            );
            if (!r.ok) continue;
            const { status } = (await r.json()) as { status: string };
            if (status === "success") {
              patchRow(i, { status: "confirmed" });
              settled = true;
              break;
            }
            if (status === "reverted") {
              patchRow(i, { status: "failed", error: "reverted" });
              setHasFailure(true);
              return; // stop on a reverted tx
            }
          } catch {
            // keep polling
          }
        }
        if (!settled) {
          // Timed out — tx was broadcast, so keep it and move on.
          patchRow(i, { status: "unconfirmed" });
        }
      }
    } finally {
      setExecuting(false);
      void fetchBalances(recipientsRef.current);
    }
  }, [activeChain, selectedSender, patchRow, fetchBalances]);

  // --- Execution: Solana ---------------------------------------------------
  const runSolana = useCallback(async () => {
    if (!activeChain || !selectedSender) return;
    setRunError(null);
    setExecuting(true);
    setHasFailure(false);
    try {
      const rows = recipientsRef.current;
      for (let start = 0; start < rows.length; start += SOLANA_CHUNK) {
        const indices: number[] = [];
        for (
          let j = start;
          j < Math.min(start + SOLANA_CHUNK, rows.length);
          j++
        ) {
          indices.push(j);
        }
        // Skip fully-confirmed chunks (transfers are atomic per batch).
        const allConfirmed = indices.every(
          (idx) => recipientsRef.current[idx].status === "confirmed",
        );
        if (allConfirmed) continue;

        indices.forEach((idx) =>
          patchRow(idx, { status: "sending", error: undefined }),
        );

        try {
          const res = await fetch("/api/solana/send-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: selectedSender,
              transfers: indices.map((idx) => ({
                to: recipientsRef.current[idx].address,
                amountDecimal: recipientsRef.current[idx].amountDecimal,
              })),
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? "batch failed");
          }
          const { signature } = (await res.json()) as { signature: string };
          indices.forEach((idx) =>
            patchRow(idx, { status: "confirmed", hash: signature }),
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : "batch failed";
          indices.forEach((idx) =>
            patchRow(idx, { status: "failed", error: message }),
          );
          setHasFailure(true);
          return; // stop on failure
        }
      }
    } finally {
      setExecuting(false);
      void fetchBalances(recipientsRef.current);
    }
  }, [activeChain, selectedSender, patchRow, fetchBalances]);

  const onSend = useCallback(() => {
    if (!activeChain) return;
    if (activeChain.kind === "evm") void runEvm();
    else void runSolana();
  }, [activeChain, runEvm, runSolana]);

  const confirmedCount = recipients.filter(
    (r) => r.status === "confirmed",
  ).length;

  // --- Render --------------------------------------------------------------
  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-red-400">{loadError}</p>
      </div>
    );
  }

  if (!chains) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (chains.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="mb-2 text-sm text-zinc-300">No chains enabled.</p>
          <p className="text-xs text-zinc-500">
            Set the required environment variables to enable one or more chains.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-edge bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">
              Batch Send
            </span>
          </div>

          {/* Chain selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            {chains.map((c) => (
              <button
                key={c.id}
                onClick={() => switchChain(c.id)}
                disabled={executing}
                className={`rounded-full border px-3 py-1 text-xs transition disabled:opacity-50 ${
                  c.id === activeId
                    ? "border-zinc-400 bg-zinc-100 text-zinc-900"
                    : "border-edge text-zinc-300 hover:border-zinc-500"
                }`}
              >
                {c.name}{" "}
                <span
                  className={
                    c.id === activeId ? "text-zinc-500" : "text-zinc-500"
                  }
                >
                  {c.symbol}
                </span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-4">
            {activeChain && selectedSender && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-zinc-500">
                  sender
                  {activeChain.senders.length > 1 && (
                    <span className="ml-1 text-zinc-600">
                      ({activeChain.senders.length})
                    </span>
                  )}
                </span>
                {activeChain.senders.length > 1 ? (
                  <select
                    value={selectedSender}
                    onChange={(e) => setSelectedSender(e.target.value)}
                    disabled={executing}
                    className="num rounded border border-edge bg-panelalt px-1.5 py-0.5 text-xs text-zinc-200 outline-none focus:border-zinc-500 disabled:opacity-50"
                    title={selectedSender}
                  >
                    {activeChain.senders.map((s) => (
                      <option key={s} value={s}>
                        {truncateAddress(s, 6, 4)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="num text-zinc-300" title={selectedSender}>
                    {truncateAddress(selectedSender, 6, 4)}
                  </span>
                )}
                <CopyButton value={selectedSender} />
              </div>
            )}
            {activeChain && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-zinc-500">balance</span>
                <span className="num text-zinc-100">
                  {senderBalanceRaw != null
                    ? `${formatRaw(senderBalanceRaw, activeChain.decimals)} ${
                        activeChain.symbol
                      }`
                    : "—"}
                </span>
              </div>
            )}
            <button
              onClick={refreshAll}
              disabled={loadingBalances || !activeChain}
              className="rounded border border-edge px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
            >
              {loadingBalances ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {/* Recipient input */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs uppercase tracking-wide text-zinc-500">
              Recipients —{" "}
              {uniformMode ? (
                <>
                  one <code className="text-zinc-400">address</code> per line
                </>
              ) : (
                <>
                  one <code className="text-zinc-400">address,amount</code> per
                  line
                </>
              )}
              {activeChain && (
                <>
                  {" "}
                  (amounts in{" "}
                  <span className="text-zinc-200">{activeChain.symbol}</span>)
                </>
              )}
            </h2>

            {/* Amount mode toggle */}
            <div className="flex items-center gap-1 rounded-full border border-edge bg-panelalt p-0.5 text-xs">
              <button
                onClick={() => setUniformMode(false)}
                disabled={executing}
                className={`rounded-full px-3 py-1 transition disabled:opacity-50 ${
                  !uniformMode
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Per-recipient amount
              </button>
              <button
                onClick={() => setUniformMode(true)}
                disabled={executing}
                className={`rounded-full px-3 py-1 transition disabled:opacity-50 ${
                  uniformMode
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Same amount for all
              </button>
            </div>
          </div>

          {/* Uniform amount input — labeled with the active chain's gas token */}
          {uniformMode && activeChain && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-zinc-500">
                Amount sent to every recipient
              </label>
              <div className="flex items-stretch overflow-hidden rounded-lg border border-edge bg-panelalt focus-within:border-zinc-500">
                <input
                  type="text"
                  inputMode="decimal"
                  value={uniformAmount}
                  onChange={(e) => setUniformAmount(e.target.value)}
                  disabled={executing}
                  spellCheck={false}
                  placeholder="0.01"
                  className="w-40 bg-transparent px-3 py-1.5 text-sm num outline-none disabled:opacity-60"
                />
                <span className="flex items-center border-l border-edge bg-panel px-3 text-xs font-medium text-zinc-300">
                  {activeChain.symbol}
                </span>
              </div>
            </div>
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={executing}
            rows={6}
            spellCheck={false}
            placeholder={
              uniformMode
                ? activeChain?.kind === "solana"
                  ? "SoLPubkey...\nSoLPubkey..."
                  : "0xabc...\n0xdef..."
                : activeChain?.kind === "solana"
                  ? "SoLPubkey...,0.5\nSoLPubkey...,1.25"
                  : "0xabc...,0.01\n0xdef...,0.5"
            }
            className="w-full resize-y rounded-lg border border-edge bg-panelalt px-3 py-2 text-sm num outline-none focus:border-zinc-500 disabled:opacity-60"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={onParse}
              disabled={
                executing ||
                text.trim().length === 0 ||
                (uniformMode && uniformAmount.trim().length === 0)
              }
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
            >
              Parse
            </button>
            {parsed && (
              <span className="text-xs text-emerald-400">
                {recipients.length} valid recipient
                {recipients.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {parseErrors.length > 0 && (
            <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3">
              <p className="mb-2 text-xs font-medium text-red-300">
                {parseErrors.length} invalid line
                {parseErrors.length === 1 ? "" : "s"} — fix before sending:
              </p>
              <ul className="space-y-1 text-xs text-red-200/90">
                {parseErrors.map((e) => (
                  <li key={e.line} className="num">
                    <span className="text-red-400">
                      {e.line === 0 ? "shared amount:" : `line ${e.line}:`}
                    </span>{" "}
                    {e.reason}
                    {e.content ? (
                      <span className="text-red-300/70"> — “{e.content}”</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Preview / dry run */}
        {parsed && activeChain && recipients.length > 0 && (
          <section className="grid gap-3 rounded-lg border border-edge bg-panel p-4 sm:grid-cols-4">
            <Stat label="Recipients" value={String(recipients.length)} />
            <Stat
              label="Total amount"
              value={`${formatRaw(
                totalAmountRaw.toString(),
                activeChain.decimals,
              )} ${activeChain.symbol}`}
            />
            <Stat
              label={
                activeChain.kind === "solana"
                  ? `Est. fees (${solanaBatchCount} batch${
                      solanaBatchCount === 1 ? "" : "es"
                    })`
                  : "Est. gas total"
              }
              value={
                activeChain.kind === "evm" && feePerTransfer == null
                  ? feeError ?? "—"
                  : `${formatRaw(
                      gasCostRaw.toString(),
                      activeChain.decimals,
                    )} ${activeChain.symbol}`
              }
            />
            <Stat
              label="Total cost"
              value={`${formatRaw(
                totalCostRaw.toString(),
                activeChain.decimals,
              )} ${activeChain.symbol}`}
              highlight={insufficientFunds}
            />

            <div className="sm:col-span-4 flex flex-wrap items-center gap-3 pt-1">
              {insufficientFunds && (
                <span className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
                  Insufficient balance for total cost
                </span>
              )}
              {runError && (
                <span className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
                  {runError}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {hasFailure && !executing && (
                  <button
                    onClick={onSend}
                    className="rounded border border-amber-600 px-3 py-1.5 text-sm text-amber-300 transition hover:bg-amber-950/40"
                  >
                    Resume from failed
                  </button>
                )}
                <button
                  onClick={onSend}
                  disabled={
                    executing ||
                    insufficientFunds ||
                    recipients.length === 0 ||
                    confirmedCount === recipients.length
                  }
                  className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {executing
                    ? "Sending…"
                    : confirmedCount === recipients.length
                      ? "All confirmed"
                      : hasFailure
                        ? "Retry all"
                        : `Send ${recipients.length}`}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Recipients table */}
        {activeChain && (
          <RecipientsTable recipients={recipients} chain={activeChain} />
        )}
      </div>

      <footer className="mx-auto max-w-6xl px-4 py-8 text-center text-xs text-zinc-600">
        Hot wallet tool — keep only operational funds in this wallet.
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div
        className={`num text-sm ${
          highlight ? "text-red-300" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
