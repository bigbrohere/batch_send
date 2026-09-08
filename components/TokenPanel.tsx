"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainInfo, ParseError, Recipient, RowStatus } from "@/lib/types";
import { parseRecipients } from "@/lib/parse";
import { formatRaw } from "@/lib/amount";
import { isValidEvmAddress } from "@/lib/validate-client";
import { sumRaw, truncateAddress } from "@/lib/ui";
import { CopyButton } from "@/components/CopyButton";

const POLL_MS = 2000;
const WALLET_PARALLELISM = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TokenInfo {
  contract: string;
  symbol: string;
  decimals: number;
  name: string;
}

interface SweepRow {
  address: string;
  label: string;
  balanceRaw: string;
  status: RowStatus;
  hash?: string;
  error?: string;
}

const STATUS_DOT: Record<RowStatus, string> = {
  queued: "bg-zinc-600",
  sending: "bg-amber-400 animate-pulse",
  pending: "bg-sky-400 animate-pulse",
  confirmed: "bg-emerald-500",
  failed: "bg-red-500",
  unconfirmed: "bg-yellow-500",
};

/**
 * ERC-20 transfers, rendered inside the Send tab. Two modes:
 *  - "Send to many": from one selected wallet to many recipients.
 *  - "Consolidate": sweep the token from the main wallet + all burners to one
 *    destination.
 * EVM-only; native/Solana stay on the main Send flow.
 */
export function TokenPanel({ chain }: { chain: ChainInfo }) {
  const isEvm = chain.kind === "evm";

  const [contract, setContract] = useState("");
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);

  const [mode, setMode] = useState<"send" | "consolidate">("send");
  const [executing, setExecuting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // --- Send mode ----------------------------------------------------------
  const [sender, setSender] = useState<string | null>(chain.senders[0] ?? null);
  const [text, setText] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [parsed, setParsed] = useState(false);
  const [senderBalance, setSenderBalance] = useState<string | null>(null);

  // --- Consolidate mode ---------------------------------------------------
  const [wallets, setWallets] = useState<{ address: string; label: string }[]>(
    [],
  );
  const [destination, setDestination] = useState("");
  const [sweepRows, setSweepRows] = useState<SweepRow[]>([]);

  // Shared row state for the send-mode recipients loop.
  const recipientsRef = useRef<Recipient[]>([]);
  recipientsRef.current = recipients;
  const patchRecipient = useCallback((i: number, patch: Partial<Recipient>) => {
    setRecipients((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      recipientsRef.current = next;
      return next;
    });
  }, []);

  const sweepRef = useRef<SweepRow[]>([]);
  sweepRef.current = sweepRows;
  const patchSweep = useCallback((i: number, patch: Partial<SweepRow>) => {
    setSweepRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      sweepRef.current = next;
      return next;
    });
  }, []);

  // Reset token/state when the chain changes.
  useEffect(() => {
    setToken(null);
    setContract("");
    setTokenError(null);
    setParsed(false);
    setRecipients([]);
    setParseErrors([]);
    setSenderBalance(null);
    setSweepRows([]);
    setRunError(null);
    setSender(chain.senders[0] ?? null);
  }, [chain.id, chain.senders]);

  // --- Load token metadata ------------------------------------------------
  const loadToken = useCallback(async () => {
    if (!isValidEvmAddress(contract.trim())) {
      setTokenError("Invalid token contract address");
      return;
    }
    setLoadingToken(true);
    setTokenError(null);
    setToken(null);
    setParsed(false);
    setRecipients([]);
    setSweepRows([]);
    try {
      const res = await fetch("/api/token/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: chain.id, contract: contract.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load token");
      setToken(data as TokenInfo);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : "Failed to load token");
    } finally {
      setLoadingToken(false);
    }
  }, [contract, chain.id]);

  // --- Balances (send mode: sender + recipients) --------------------------
  const fetchSendBalances = useCallback(
    async (rows: Recipient[]) => {
      if (!token || !sender) return;
      try {
        const addrs = Array.from(
          new Set([sender, ...rows.map((r) => r.address)]),
        );
        const res = await fetch("/api/token/balances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chain: chain.id,
            contract: token.contract,
            addresses: addrs,
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { balances: Record<string, string> };
        const lower = (a: string) =>
          data.balances[a] ??
          data.balances[Object.keys(data.balances).find(
            (k) => k.toLowerCase() === a.toLowerCase(),
          ) ?? ""] ??
          "0";
        setSenderBalance(lower(sender));
        setRecipients((prev) => {
          const next = prev.map((r) => ({ ...r, balanceRaw: lower(r.address) }));
          recipientsRef.current = next;
          return next;
        });
      } catch {
        /* best-effort */
      }
    },
    [token, sender, chain.id],
  );

  // Refresh sender balance when token/sender changes.
  useEffect(() => {
    if (token && sender) void fetchSendBalances(recipientsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sender]);

  // --- Parse recipients (send mode) ---------------------------------------
  const onParse = useCallback(async () => {
    if (!token) return;
    setRunError(null);
    const { recipients: rows, errors } = parseRecipients(
      text,
      "evm",
      token.decimals,
    );
    setParseErrors(errors);
    if (errors.length > 0) {
      setParsed(false);
      setRecipients([]);
      return;
    }
    setRecipients(rows);
    recipientsRef.current = rows;
    setParsed(true);
    await fetchSendBalances(rows);
  }, [token, text, fetchSendBalances]);

  const totalSend = useMemo(
    () => sumRaw(recipients.map((r) => r.rawAmount)),
    [recipients],
  );

  // --- Consolidate: load wallets + balances -------------------------------
  const loadWallets = useCallback(async () => {
    if (!token) return;
    try {
      const wRes = await fetch("/api/wallets");
      if (!wRes.ok) return;
      const w = (await wRes.json()) as {
        funding: { address: string } | null;
        burners: { address: string; index: number }[];
      };
      const list: { address: string; label: string }[] = [];
      if (w.funding) list.push({ address: w.funding.address, label: "main" });
      w.burners.forEach((b) => list.push({ address: b.address, label: `#${b.index}` }));
      setWallets(list);

      const bRes = await fetch("/api/token/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: chain.id,
          contract: token.contract,
          addresses: list.map((x) => x.address),
        }),
      });
      if (!bRes.ok) return;
      const data = (await bRes.json()) as { balances: Record<string, string> };
      const lookup = (a: string) =>
        data.balances[
          Object.keys(data.balances).find(
            (k) => k.toLowerCase() === a.toLowerCase(),
          ) ?? ""
        ] ?? "0";
      setSweepRows(
        list.map((x) => ({
          address: x.address,
          label: x.label,
          balanceRaw: lookup(x.address),
          status: "queued" as RowStatus,
        })),
      );
    } catch {
      /* best-effort */
    }
  }, [token, chain.id]);

  useEffect(() => {
    if (token && mode === "consolidate") void loadWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, mode]);

  const sweepable = useMemo(
    () => sweepRows.filter((r) => BigInt(r.balanceRaw || "0") > 0n),
    [sweepRows],
  );
  const sweepTotal = useMemo(
    () => sumRaw(sweepRows.map((r) => r.balanceRaw || "0")),
    [sweepRows],
  );

  // --- Execution helpers --------------------------------------------------
  const pollReceipt = useCallback(
    async (hash: string): Promise<"success" | "reverted" | "timeout"> => {
      const deadline = Date.now() + chain.receiptTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        try {
          const r = await fetch(
            `/api/evm/receipt?chain=${encodeURIComponent(chain.id)}&hash=${hash}`,
          );
          if (!r.ok) continue;
          const { status } = (await r.json()) as { status: string };
          if (status === "success") return "success";
          if (status === "reverted") return "reverted";
        } catch {
          /* keep polling */
        }
      }
      return "timeout";
    },
    [chain.id, chain.receiptTimeoutMs],
  );

  const prepareNonce = useCallback(
    async (from: string): Promise<number> => {
      const res = await fetch("/api/evm/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: chain.id, from }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "prepare failed");
      }
      return ((await res.json()) as { nonce: number }).nonce;
    },
    [chain.id],
  );

  // --- Execute: send to many ----------------------------------------------
  const runSend = useCallback(async () => {
    if (!token || !sender) return;
    setExecuting(true);
    setRunError(null);
    try {
      let nonce: number;
      try {
        nonce = await prepareNonce(sender);
      } catch (e) {
        setRunError(e instanceof Error ? e.message : "prepare failed");
        return;
      }
      const rows = recipientsRef.current;
      for (let i = 0; i < rows.length; i++) {
        if (recipientsRef.current[i].status === "confirmed") continue;
        patchRecipient(i, { status: "sending", error: undefined });
        let hash: string;
        try {
          const res = await fetch("/api/token/send-one", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chain: chain.id,
              from: sender,
              contract: token.contract,
              to: rows[i].address,
              amountDecimal: rows[i].amountDecimal,
              nonce,
            }),
          });
          if (!res.ok) {
            const b = await res.json().catch(() => ({}));
            throw new Error(b.error ?? "transfer failed");
          }
          ({ hash } = (await res.json()) as { hash: string });
        } catch (e) {
          patchRecipient(i, {
            status: "failed",
            error: e instanceof Error ? e.message : "transfer failed",
          });
          return;
        }
        nonce += 1;
        patchRecipient(i, { status: "pending", hash });
        const outcome = await pollReceipt(hash);
        if (outcome === "success") patchRecipient(i, { status: "confirmed" });
        else if (outcome === "reverted") {
          patchRecipient(i, { status: "failed", error: "reverted" });
          return;
        } else patchRecipient(i, { status: "unconfirmed" });
      }
    } finally {
      setExecuting(false);
      void fetchSendBalances(recipientsRef.current);
    }
  }, [token, sender, chain.id, prepareNonce, pollReceipt, patchRecipient, fetchSendBalances]);

  // --- Execute: consolidate (sweep) ---------------------------------------
  const runConsolidate = useCallback(async () => {
    if (!token) return;
    const dest = destination.trim();
    if (!isValidEvmAddress(dest)) {
      setRunError("Invalid destination address");
      return;
    }
    setExecuting(true);
    setRunError(null);
    try {
      const targets = sweepRef.current
        .map((r, i) => ({ r, i }))
        .filter(
          ({ r }) =>
            BigInt(r.balanceRaw || "0") > 0n &&
            r.address.toLowerCase() !== dest.toLowerCase() &&
            r.status !== "confirmed",
        );

      let cursor = 0;
      const worker = async () => {
        while (cursor < targets.length) {
          const { r, i } = targets[cursor++];
          patchSweep(i, { status: "sending", error: undefined });
          let nonce: number;
          try {
            nonce = await prepareNonce(r.address);
          } catch (e) {
            patchSweep(i, {
              status: "failed",
              error: e instanceof Error ? e.message : "prepare failed",
            });
            continue;
          }
          let hash: string;
          try {
            const res = await fetch("/api/token/send-one", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chain: chain.id,
                from: r.address,
                contract: token.contract,
                to: dest,
                amountRaw: r.balanceRaw,
                nonce,
              }),
            });
            if (!res.ok) {
              const b = await res.json().catch(() => ({}));
              throw new Error(b.error ?? "transfer failed");
            }
            ({ hash } = (await res.json()) as { hash: string });
          } catch (e) {
            patchSweep(i, {
              status: "failed",
              error: e instanceof Error ? e.message : "transfer failed",
            });
            continue;
          }
          patchSweep(i, { status: "pending", hash });
          const outcome = await pollReceipt(hash);
          if (outcome === "success") patchSweep(i, { status: "confirmed" });
          else if (outcome === "reverted")
            patchSweep(i, { status: "failed", error: "reverted" });
          else patchSweep(i, { status: "unconfirmed" });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(WALLET_PARALLELISM, targets.length) }, () =>
          worker(),
        ),
      );
    } finally {
      setExecuting(false);
      void loadWallets();
    }
  }, [token, destination, chain.id, prepareNonce, pollReceipt, patchSweep, loadWallets]);

  const explorer = (hash: string) => `${chain.explorerBaseUrl}${hash}`;

  // --- Render --------------------------------------------------------------
  if (!isEvm) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-6 text-center text-sm text-zinc-400">
        ERC-20 token transfers are only available on EVM chains. Select an EVM
        chain above.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Token loader */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[260px]">
          <label className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            ERC-20 token contract
          </label>
          <input
            value={contract}
            onChange={(e) => setContract(e.target.value)}
            disabled={executing}
            spellCheck={false}
            placeholder="0x… token contract on this chain"
            className="num w-full rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
        </div>
        <button
          onClick={loadToken}
          disabled={loadingToken || executing || contract.trim().length === 0}
          className="rounded bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
        >
          {loadingToken ? "Loading…" : "Load token"}
        </button>
        {token && (
          <span className="text-xs text-emerald-400">
            {token.name ? `${token.name} · ` : ""}
            <span className="text-zinc-200">{token.symbol}</span> ·{" "}
            {token.decimals} dec
          </span>
        )}
      </div>
      {tokenError && <p className="text-xs text-red-400">{tokenError}</p>}

      {token && (
        <>
          {/* Mode toggle */}
          <div className="flex items-center gap-1 rounded-full border border-edge bg-panelalt p-0.5 text-xs w-fit">
            <button
              onClick={() => setMode("send")}
              disabled={executing}
              className={`rounded-full px-3 py-1 ${mode === "send" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400"}`}
            >
              Send to many
            </button>
            <button
              onClick={() => setMode("consolidate")}
              disabled={executing}
              className={`rounded-full px-3 py-1 ${mode === "consolidate" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400"}`}
            >
              Consolidate to one
            </button>
          </div>

          {mode === "send" ? (
            <SendMode
              chain={chain}
              token={token}
              sender={sender}
              setSender={setSender}
              senderBalance={senderBalance}
              text={text}
              setText={setText}
              onParse={onParse}
              parsed={parsed}
              recipients={recipients}
              parseErrors={parseErrors}
              totalSend={totalSend}
              executing={executing}
              runError={runError}
              onSend={runSend}
              explorer={explorer}
            />
          ) : (
            <ConsolidateMode
              chain={chain}
              token={token}
              destination={destination}
              setDestination={setDestination}
              sweepRows={sweepRows}
              sweepable={sweepable.length}
              sweepTotal={sweepTotal}
              executing={executing}
              runError={runError}
              onRun={runConsolidate}
              onRefresh={loadWallets}
              explorer={explorer}
            />
          )}
        </>
      )}
    </div>
  );
}

// --- Send-to-many sub-UI ----------------------------------------------------
function SendMode(props: {
  chain: ChainInfo;
  token: TokenInfo;
  sender: string | null;
  setSender: (s: string) => void;
  senderBalance: string | null;
  text: string;
  setText: (s: string) => void;
  onParse: () => void;
  parsed: boolean;
  recipients: Recipient[];
  parseErrors: ParseError[];
  totalSend: bigint;
  executing: boolean;
  runError: string | null;
  onSend: () => void;
  explorer: (h: string) => string;
}) {
  const {
    chain,
    token,
    sender,
    setSender,
    senderBalance,
    text,
    setText,
    onParse,
    parsed,
    recipients,
    parseErrors,
    totalSend,
    executing,
    runError,
    onSend,
    explorer,
  } = props;
  const confirmed = recipients.filter((r) => r.status === "confirmed").length;
  const insufficient =
    senderBalance != null && BigInt(senderBalance) < totalSend;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-zinc-500">from</span>
        <select
          value={sender ?? ""}
          onChange={(e) => setSender(e.target.value)}
          disabled={executing}
          className="num rounded border border-edge bg-panelalt px-2 py-1 text-zinc-200"
        >
          {chain.senders.map((s) => (
            <option key={s} value={s}>
              {truncateAddress(s, 6, 4)}
            </option>
          ))}
        </select>
        {sender && <CopyButton value={sender} />}
        <span className="text-zinc-500">balance</span>
        <span className="num text-zinc-100">
          {senderBalance != null
            ? `${formatRaw(senderBalance, token.decimals)} ${token.symbol}`
            : "—"}
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={executing}
        rows={5}
        spellCheck={false}
        placeholder={`0xRecipient,1.5\n0xRecipient,0.25   (amounts in ${token.symbol})`}
        className="num w-full rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={onParse}
          disabled={executing || text.trim().length === 0}
          className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
        >
          Parse
        </button>
        {parsed && (
          <span className="text-xs text-emerald-400">
            {recipients.length} recipient{recipients.length === 1 ? "" : "s"} ·{" "}
            {formatRaw(totalSend.toString(), token.decimals)} {token.symbol} total
          </span>
        )}
      </div>

      {parseErrors.length > 0 && (
        <ul className="space-y-1 text-xs text-red-300">
          {parseErrors.map((e) => (
            <li key={e.line}>
              line {e.line}: {e.reason}
            </li>
          ))}
        </ul>
      )}

      {parsed && recipients.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-edge">
            <table className="w-full min-w-[560px] text-xs">
              <thead className="bg-panelalt text-[10px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 text-right">#</th>
                  <th className="px-2 py-1.5 text-left">To</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {recipients.map((r, i) => (
                  <tr key={`${r.address}-${r.line}`}>
                    <td className="px-2 py-1.5 text-right text-zinc-500 num">{i + 1}</td>
                    <td className="px-2 py-1.5 num" title={r.address}>
                      {truncateAddress(r.address, 6, 4)}
                    </td>
                    <td className="px-2 py-1.5 text-right num">
                      {r.amountDecimal} {token.symbol}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="flex items-center gap-1.5 text-zinc-300">
                        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[r.status]}`} />
                        {r.status}
                      </span>
                      {r.error && (
                        <span className="text-[10px] text-red-400">{r.error}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.hash ? (
                        <a
                          href={explorer(r.hash)}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="num text-sky-400 hover:underline"
                        >
                          {truncateAddress(r.hash, 5, 5)}
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

          <div className="flex flex-wrap items-center gap-3">
            {insufficient && (
              <span className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
                Insufficient {token.symbol} balance
              </span>
            )}
            {runError && (
              <span className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
                {runError}
              </span>
            )}
            <button
              onClick={onSend}
              disabled={
                executing || insufficient || confirmed === recipients.length
              }
              className="ml-auto rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
            >
              {executing
                ? "Sending…"
                : confirmed === recipients.length
                  ? "All confirmed"
                  : `Send ${token.symbol} ×${recipients.length}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Consolidate sub-UI -----------------------------------------------------
function ConsolidateMode(props: {
  chain: ChainInfo;
  token: TokenInfo;
  destination: string;
  setDestination: (s: string) => void;
  sweepRows: SweepRow[];
  sweepable: number;
  sweepTotal: bigint;
  executing: boolean;
  runError: string | null;
  onRun: () => void;
  onRefresh: () => void;
  explorer: (h: string) => string;
}) {
  const {
    token,
    destination,
    setDestination,
    sweepRows,
    sweepable,
    sweepTotal,
    executing,
    runError,
    onRun,
    onRefresh,
    explorer,
  } = props;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-500">Destination</label>
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          disabled={executing}
          spellCheck={false}
          placeholder="0x… gather all balances here"
          className="num min-w-[280px] flex-1 rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
        />
        <button
          onClick={onRefresh}
          disabled={executing}
          className="rounded border border-edge px-2 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
        >
          Refresh balances
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-edge">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="bg-panelalt text-[10px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 text-left">Wallet</th>
              <th className="px-2 py-1.5 text-right">Balance</th>
              <th className="px-2 py-1.5 text-left">Status</th>
              <th className="px-2 py-1.5 text-left">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {sweepRows.map((r) => {
              const zero = BigInt(r.balanceRaw || "0") === 0n;
              return (
                <tr key={r.address} className={zero ? "opacity-40" : ""}>
                  <td className="px-2 py-1.5 num" title={r.address}>
                    <span className="text-zinc-500">{r.label}</span>{" "}
                    {truncateAddress(r.address, 5, 4)}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-zinc-200">
                    {formatRaw(r.balanceRaw || "0", token.decimals)} {token.symbol}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1.5 text-zinc-300">
                      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[r.status]}`} />
                      {zero && r.status === "queued" ? "—" : r.status}
                    </span>
                    {r.error && (
                      <span className="text-[10px] text-red-400">{r.error}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.hash ? (
                      <a
                        href={explorer(r.hash)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="num text-sky-400 hover:underline"
                      >
                        {truncateAddress(r.hash, 5, 5)}
                      </a>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {sweepRows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-4 text-center text-zinc-500">
                  Loading wallet balances…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-zinc-400">
          {sweepable} wallet{sweepable === 1 ? "" : "s"} with a balance ·{" "}
          {formatRaw(sweepTotal.toString(), token.decimals)} {token.symbol} total
        </span>
        {runError && (
          <span className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
            {runError}
          </span>
        )}
        <button
          onClick={onRun}
          disabled={executing || sweepable === 0 || destination.trim().length === 0}
          className="ml-auto rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          {executing ? "Sweeping…" : `Consolidate ${sweepable}`}
        </button>
      </div>
    </div>
  );
}
