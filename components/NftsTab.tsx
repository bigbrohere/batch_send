"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { ChainInfo } from "@/lib/types";
import type { NftItem, PrecheckResult } from "@/lib/nft-types";
import { formatRaw } from "@/lib/amount";
import { truncateAddress } from "@/lib/ui";
import { isValidEvmAddress } from "@/lib/validate-client";
import { CopyButton } from "@/components/CopyButton";
import { NftCard, type AggItem } from "@/components/NftCard";

const POLL_MS = 2000;
const WALLET_PARALLELISM = 3;
const DRAFT_KEY = "nft-draft-v1";

// Distinct dot colors for owning-wallet coding (cycled by burner index).
const WALLET_DOTS = [
  "bg-sky-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-fuchsia-400",
  "bg-rose-400",
  "bg-cyan-400",
  "bg-lime-400",
  "bg-violet-400",
];
const dotFor = (i: number) => WALLET_DOTS[i % WALLET_DOTS.length];

type Burner = { address: string; index: number };

type RowStatus =
  | "queued"
  | "sending"
  | "pending"
  | "confirmed"
  | "failed"
  | "unconfirmed"
  | "skipped";

interface PreviewRow {
  key: string;
  item: AggItem;
  to: string;
  precheck: "pending" | "ok" | "not_owned";
  gasEstimate?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function itemKey(it: { chain: string; contract: string; tokenId: string; owner: string }) {
  return `${it.chain}:${it.contract.toLowerCase()}:${it.tokenId}:${it.owner.toLowerCase()}`;
}

export function NftsTab() {
  const router = useRouter();

  const [chains, setChains] = useState<ChainInfo[] | null>(null);
  const [activeChainId, setActiveChainId] = useState<string | null>(null);
  const [funding, setFunding] = useState<string | null>(null);
  const [burners, setBurners] = useState<Burner[]>([]);
  const [walletsError, setWalletsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [gas, setGas] = useState<Record<string, string>>({});
  const [nftsByWallet, setNftsByWallet] = useState<Record<string, NftItem[]>>({});
  const [walletLoading, setWalletLoading] = useState<Record<string, boolean>>({});

  const [filterWallet, setFilterWallet] = useState<string>("all");
  const [filterCollection, setFilterCollection] = useState<string>("all");
  const [search, setSearch] = useState("");

  const [selection, setSelection] = useState<Set<string>>(new Set());

  const [mode, setMode] = useState<"consolidate" | "csv">("consolidate");
  const [destination, setDestination] = useState("");
  const [mappingText, setMappingText] = useState("");
  const [mappingErrors, setMappingErrors] = useState<
    { line: number; reason: string }[]
  >([]);

  const [stage, setStage] = useState<"browse" | "preview" | "confirm" | "run">(
    "browse",
  );
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [prechecking, setPrechecking] = useState(false);
  const [rowState, setRowState] = useState<
    Record<string, { status: RowStatus; hash?: string; error?: string }>
  >({});
  const [executing, setExecuting] = useState(false);

  const activeChain = useMemo(
    () => chains?.find((c) => c.id === activeChainId) ?? null,
    [chains, activeChainId],
  );

  const rowStateRef = useRef(rowState);
  rowStateRef.current = rowState;
  const patchRow = useCallback(
    (key: string, patch: Partial<{ status: RowStatus; hash: string; error: string }>) => {
      setRowState((prev) => {
        const next = { ...prev, [key]: { ...prev[key], ...patch } };
        rowStateRef.current = next;
        return next;
      });
    },
    [],
  );

  // --- Load chains + wallets ----------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wiRes, wRes] = await Promise.all([
          fetch("/api/wallet-info"),
          fetch("/api/wallets"),
        ]);
        if (wiRes.status === 401 || wRes.status === 401) {
          router.replace("/login");
          return;
        }
        if (!wiRes.ok) throw new Error("wallet-info failed");
        const wi = (await wiRes.json()) as { chains: ChainInfo[] };
        if (cancelled) return;
        const nftChains = wi.chains.filter((c) => c.nftSupport);
        setChains(nftChains);
        setActiveChainId(nftChains[0]?.id ?? null);

        if (wRes.ok) {
          const w = (await wRes.json()) as {
            funding: { address: string } | null;
            burners: Burner[];
          };
          setFunding(w.funding?.address ?? null);
          setBurners(w.burners);
        } else {
          const err = await wRes.json().catch(() => ({}));
          setWalletsError(err.error ?? "Failed to load wallets");
        }
      } catch {
        if (!cancelled) setLoadError("Failed to load NFT console");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // --- Gas balances --------------------------------------------------------
  const loadGas = useCallback(async () => {
    if (!activeChainId) return;
    try {
      const res = await fetch("/api/wallets/gas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChainId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { balances: Record<string, string> };
      setGas(data.balances);
    } catch {
      /* best-effort */
    }
  }, [activeChainId]);

  // --- NFT discovery (progressive, one request per wallet) -----------------
  const loadNfts = useCallback(
    async (refresh = false) => {
      if (!activeChainId || burners.length === 0) return;
      setWalletLoading(
        Object.fromEntries(burners.map((b) => [b.address, true])),
      );
      setNftsByWallet({});
      await Promise.all(
        burners.map(async (b) => {
          try {
            const res = await fetch("/api/nfts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chain: activeChainId,
                address: b.address,
                refresh,
              }),
            });
            if (res.ok) {
              const data = (await res.json()) as { items: NftItem[] };
              setNftsByWallet((prev) => ({ ...prev, [b.address]: data.items }));
            } else {
              setNftsByWallet((prev) => ({ ...prev, [b.address]: [] }));
            }
          } catch {
            setNftsByWallet((prev) => ({ ...prev, [b.address]: [] }));
          } finally {
            setWalletLoading((prev) => ({ ...prev, [b.address]: false }));
          }
        }),
      );
    },
    [activeChainId, burners],
  );

  // Reload gas + NFTs when chain or burner set changes.
  useEffect(() => {
    if (activeChainId && burners.length > 0) {
      void loadGas();
      void loadNfts(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChainId, burners]);

  // --- Aggregation + filters ----------------------------------------------
  const aggItems: AggItem[] = useMemo(() => {
    const out: AggItem[] = [];
    for (const b of burners) {
      for (const it of nftsByWallet[b.address] ?? []) {
        out.push({ ...it, owner: b.address });
      }
    }
    return out;
  }, [burners, nftsByWallet]);

  const collections = useMemo(() => {
    const set = new Map<string, string>();
    for (const it of aggItems) {
      const label = it.collectionName || it.contract;
      set.set(it.contract.toLowerCase(), label);
    }
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [aggItems]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return aggItems.filter((it) => {
      if (filterWallet !== "all" && it.owner.toLowerCase() !== filterWallet.toLowerCase())
        return false;
      if (
        filterCollection !== "all" &&
        it.contract.toLowerCase() !== filterCollection
      )
        return false;
      if (q) {
        const hay = `${it.name} ${it.collectionName} ${it.contract} ${it.tokenId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [aggItems, filterWallet, filterCollection, search]);

  const loadedCount = useMemo(
    () => burners.filter((b) => walletLoading[b.address] === false).length,
    [burners, walletLoading],
  );
  const allLoaded = burners.length > 0 && loadedCount === burners.length;

  const burnerIndexByAddress = useMemo(() => {
    const m = new Map<string, number>();
    burners.forEach((b) => m.set(b.address.toLowerCase(), b.index));
    return m;
  }, [burners]);

  // --- Selection -----------------------------------------------------------
  const toggle = useCallback((it: AggItem) => {
    const key = itemKey(it);
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelection((prev) => {
      const next = new Set(prev);
      filtered.forEach((it) => next.add(itemKey(it)));
      return next;
    });
  }, [filtered]);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const selectedItems = useMemo(
    () => aggItems.filter((it) => selection.has(itemKey(it))),
    [aggItems, selection],
  );

  // --- Draft autosave ------------------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as {
          mode?: "consolidate" | "csv";
          destination?: string;
          mappingText?: string;
          selection?: string[];
        };
        if (d.mode) setMode(d.mode);
        if (typeof d.destination === "string") setDestination(d.destination);
        if (typeof d.mappingText === "string") setMappingText(d.mappingText);
        if (Array.isArray(d.selection)) setSelection(new Set(d.selection));
      }
    } catch {
      /* ignore malformed draft */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          mode,
          destination,
          mappingText,
          selection: Array.from(selection),
        }),
      );
    } catch {
      /* storage may be unavailable */
    }
  }, [mode, destination, mappingText, selection]);

  // --- Build candidate rows (mode A / B) -----------------------------------
  const buildRows = useCallback((): {
    rows: { item: AggItem; to: string }[];
    errors: { line: number; reason: string }[];
  } => {
    if (mode === "consolidate") {
      const to = destination.trim();
      if (!isValidEvmAddress(to)) {
        return { rows: [], errors: [{ line: 0, reason: "Invalid destination address" }] };
      }
      return { rows: selectedItems.map((item) => ({ item, to })), errors: [] };
    }

    // CSV mapping: contract,tokenId,recipient
    const rows: { item: AggItem; to: string }[] = [];
    const errors: { line: number; reason: string }[] = [];
    const seen = new Set<string>();
    mappingText.split(/\r?\n/).forEach((raw, idx) => {
      const line = idx + 1;
      const t = raw.trim();
      if (!t) return;
      const parts = t.split(/[,\t\s]+/).filter(Boolean);
      if (parts.length !== 3) {
        errors.push({ line, reason: "Expected `contract,tokenId,recipient`" });
        return;
      }
      const [contract, tokenId, recipient] = parts;
      if (!isValidEvmAddress(recipient)) {
        errors.push({ line, reason: "Invalid recipient address" });
        return;
      }
      const match = aggItems.find(
        (it) =>
          it.contract.toLowerCase() === contract.toLowerCase() &&
          it.tokenId === tokenId,
      );
      if (!match) {
        errors.push({ line, reason: "No owned item matches this contract/tokenId" });
        return;
      }
      const dedupe = `${contract.toLowerCase()}:${tokenId}`;
      if (seen.has(dedupe)) {
        errors.push({ line, reason: "Duplicate contract/tokenId" });
        return;
      }
      seen.add(dedupe);
      rows.push({ item: match, to: recipient });
    });
    return { rows, errors };
  }, [mode, destination, selectedItems, mappingText, aggItems]);

  // --- Precheck -> preview -------------------------------------------------
  const runPrecheck = useCallback(async () => {
    if (!activeChain) return;
    const { rows, errors } = buildRows();
    setMappingErrors(errors);
    if (errors.length > 0 || rows.length === 0) return;

    setPrechecking(true);
    try {
      const payload = rows.map((r) => ({
        contract: r.item.contract,
        tokenId: r.item.tokenId,
        standard: r.item.standard,
        owner: r.item.owner,
        to: r.to,
        amount: r.item.standard === "erc1155" ? r.item.balance : undefined,
      }));
      const res = await fetch("/api/nft/precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChain.id, rows: payload }),
      });
      if (!res.ok) throw new Error("precheck failed");
      const data = (await res.json()) as { results: PrecheckResult[] };
      const pv: PreviewRow[] = rows.map((r, i) => ({
        key: itemKey(r.item),
        item: r.item,
        to: r.to,
        precheck: data.results[i]?.status ?? "not_owned",
        gasEstimate: data.results[i]?.gasEstimate,
      }));
      setPreview(pv);
      // Seed row state for the ok rows.
      const seed: Record<string, { status: RowStatus }> = {};
      pv.forEach((row) => {
        seed[row.key] = { status: row.precheck === "ok" ? "queued" : "skipped" };
      });
      setRowState(seed);
      rowStateRef.current = seed;
      setStage("preview");
    } catch {
      setMappingErrors([{ line: 0, reason: "Precheck failed — try again" }]);
    } finally {
      setPrechecking(false);
    }
  }, [activeChain, buildRows]);

  const okRows = useMemo(
    () => preview.filter((r) => r.precheck === "ok"),
    [preview],
  );

  const totalGas = useMemo(() => {
    return okRows.reduce((acc, r) => acc + BigInt(r.gasEstimate ?? "0"), 0n);
  }, [okRows]);

  const walletsInvolved = useMemo(
    () => new Set(okRows.map((r) => r.item.owner.toLowerCase())).size,
    [okRows],
  );

  // --- Execution -----------------------------------------------------------
  const pollReceipt = useCallback(
    async (hash: string): Promise<"success" | "reverted" | "timeout"> => {
      if (!activeChain) return "timeout";
      const deadline = Date.now() + activeChain.receiptTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        try {
          const r = await fetch(
            `/api/evm/receipt?chain=${encodeURIComponent(activeChain.id)}&hash=${hash}`,
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
    [activeChain],
  );

  // Transfer all rows for one wallet sequentially with an incrementing nonce.
  const runWallet = useCallback(
    async (owner: string, rows: PreviewRow[]) => {
      if (!activeChain) return;
      // Fresh nonce for this wallet's independent chain.
      const prep = await fetch("/api/evm/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChain.id, from: owner }),
      });
      if (!prep.ok) {
        const body = await prep.json().catch(() => ({}));
        rows.forEach((r) =>
          patchRow(r.key, { status: "failed", error: body.error ?? "prepare failed" }),
        );
        return;
      }
      let { nonce } = (await prep.json()) as { nonce: number };

      for (const row of rows) {
        if (rowStateRef.current[row.key]?.status === "confirmed") continue;
        patchRow(row.key, { status: "sending", error: undefined });
        let hash: string;
        try {
          const res = await fetch("/api/nft/transfer-one", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chain: activeChain.id,
              from: owner,
              contract: row.item.contract,
              tokenId: row.item.tokenId,
              standard: row.item.standard,
              to: row.to,
              amount:
                row.item.standard === "erc1155" ? row.item.balance : undefined,
              nonce,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? "transfer failed");
          }
          ({ hash } = (await res.json()) as { hash: string });
        } catch (e) {
          patchRow(row.key, {
            status: "failed",
            error: e instanceof Error ? e.message : "transfer failed",
          });
          return; // stop only THIS wallet's chain
        }
        nonce += 1;
        patchRow(row.key, { status: "pending", hash });
        const outcome = await pollReceipt(hash);
        if (outcome === "success") patchRow(row.key, { status: "confirmed" });
        else if (outcome === "reverted") {
          patchRow(row.key, { status: "failed", error: "reverted" });
          return;
        } else patchRow(row.key, { status: "unconfirmed" });
      }
    },
    [activeChain, patchRow, pollReceipt],
  );

  const execute = useCallback(async () => {
    setExecuting(true);
    setStage("run");
    try {
      // Group ok rows by owning wallet.
      const groups = new Map<string, PreviewRow[]>();
      for (const r of okRows) {
        const g = groups.get(r.item.owner) ?? [];
        g.push(r);
        groups.set(r.item.owner, g);
      }
      const entries = Array.from(groups.entries());
      // Up to WALLET_PARALLELISM wallets in parallel (independent nonce chains).
      let cursor = 0;
      async function worker() {
        while (cursor < entries.length) {
          const i = cursor++;
          const [owner, rows] = entries[i];
          await runWallet(owner, rows);
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(WALLET_PARALLELISM, entries.length) },
          () => worker(),
        ),
      );
    } finally {
      setExecuting(false);
      void loadGas();
      void loadNfts(true);
    }
  }, [okRows, runWallet, loadGas, loadNfts]);

  // Resume: re-run precheck first so already-transferred items auto-skip.
  const resume = useCallback(async () => {
    if (!activeChain) return;
    const pending = preview.filter(
      (r) => rowStateRef.current[r.key]?.status !== "confirmed",
    );
    if (pending.length === 0) return;
    setExecuting(true);
    try {
      const payload = pending.map((r) => ({
        contract: r.item.contract,
        tokenId: r.item.tokenId,
        standard: r.item.standard,
        owner: r.item.owner,
        to: r.to,
        amount: r.item.standard === "erc1155" ? r.item.balance : undefined,
      }));
      const res = await fetch("/api/nft/precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain: activeChain.id, rows: payload }),
      });
      if (!res.ok) throw new Error("precheck failed");
      const data = (await res.json()) as { results: PrecheckResult[] };

      const stillOwned: PreviewRow[] = [];
      pending.forEach((r, i) => {
        if (data.results[i]?.status === "ok") {
          patchRow(r.key, { status: "queued", error: undefined });
          stillOwned.push(r);
        } else {
          // Already transferred in a prior attempt -> skip, not an error.
          patchRow(r.key, { status: "skipped", error: undefined });
        }
      });

      const groups = new Map<string, PreviewRow[]>();
      for (const r of stillOwned) {
        const g = groups.get(r.item.owner) ?? [];
        g.push(r);
        groups.set(r.item.owner, g);
      }
      const entries = Array.from(groups.entries());
      let cursor = 0;
      async function worker() {
        while (cursor < entries.length) {
          const i = cursor++;
          const [owner, rows] = entries[i];
          await runWallet(owner, rows);
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(WALLET_PARALLELISM, entries.length) },
          () => worker(),
        ),
      );
    } catch {
      /* leave rows as-is; user can retry */
    } finally {
      setExecuting(false);
      void loadGas();
      void loadNfts(true);
    }
  }, [activeChain, preview, patchRow, runWallet, loadGas, loadNfts]);

  const hasFailure = useMemo(
    () =>
      preview.some(
        (r) => rowState[r.key]?.status === "failed" || rowState[r.key]?.status === "unconfirmed",
      ),
    [preview, rowState],
  );
  const allDone = useMemo(
    () =>
      stage === "run" &&
      !executing &&
      preview.every((r) => {
        const s = rowState[r.key]?.status;
        return s === "confirmed" || s === "skipped" || r.precheck === "not_owned";
      }),
    [stage, executing, preview, rowState],
  );

  const downloadCsv = useCallback(() => {
    const header = "contract,tokenId,from,to,status,txHash";
    const lines = preview.map((r) => {
      const st = rowState[r.key];
      const status = r.precheck === "not_owned" ? "not_owned" : st?.status ?? "queued";
      return [
        r.item.contract,
        r.item.tokenId,
        r.item.owner,
        r.to,
        status,
        st?.hash ?? "",
      ].join(",");
    });
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nft-transfer-results.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [preview, rowState]);

  // --- Render --------------------------------------------------------------
  if (loadError) {
    return (
      <div className="p-8 text-center text-sm text-red-400">{loadError}</div>
    );
  }
  if (!chains) {
    return <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>;
  }
  if (chains.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-zinc-400">
        NFTs are not available — enable a supported chain (Ethereum, Base,
        Arbitrum, Polygon).
      </div>
    );
  }

  return (
    <div>
      {/* Sub-header: chain selector for NFT chains + refresh */}
      <div className="sticky top-0 z-10 border-b border-edge bg-panel/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {chains.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setActiveChainId(c.id);
                  setStage("browse");
                  setPreview([]);
                }}
                disabled={executing}
                className={`rounded-full border px-3 py-1 text-xs transition disabled:opacity-50 ${
                  c.id === activeChainId
                    ? "border-zinc-400 bg-zinc-100 text-zinc-900"
                    : "border-edge text-zinc-300 hover:border-zinc-500"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
            {burners.length > 0 && (
              <span>
                {allLoaded
                  ? `${aggItems.length} NFTs across ${burners.length} wallets`
                  : `loaded ${loadedCount}/${burners.length} wallets…`}
              </span>
            )}
            <button
              onClick={() => {
                void loadGas();
                void loadNfts(true);
              }}
              disabled={burners.length === 0}
              className="rounded border border-edge px-2 py-1 text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[240px_1fr]">
        {/* Wallet rail */}
        <aside className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wide text-zinc-500">
            Burner wallets
          </h3>
          {walletsError && (
            <p className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300">
              {walletsError}
            </p>
          )}
          {burners.length === 0 && !walletsError && (
            <p className="rounded border border-edge bg-panel p-3 text-xs text-zinc-400">
              No burner wallets configured. Set <code>EVM_PRIVATE_KEYS</code> to
              add burners.
            </p>
          )}
          {burners.map((b) => {
            const raw = gas[b.address] ?? gas[b.address.toLowerCase()];
            const zeroGas = raw != null && BigInt(raw) === 0n;
            const count = nftsByWallet[b.address]?.length;
            return (
              <div
                key={b.address}
                className="rounded-lg border border-edge bg-panel p-2.5 text-xs"
              >
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dotFor(b.index)}`} />
                  <span className="num text-zinc-300" title={b.address}>
                    {truncateAddress(b.address, 6, 4)}
                  </span>
                  <CopyButton value={b.address} />
                  {walletLoading[b.address] && (
                    <span className="ml-auto h-3 w-3 animate-spin rounded-full border border-zinc-600 border-t-zinc-300" />
                  )}
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="num text-zinc-400">
                    {raw != null && activeChain
                      ? `${formatRaw(raw, activeChain.decimals)} ${activeChain.symbol}`
                      : "—"}
                  </span>
                  <span className="text-zinc-500">
                    {count != null ? `${count} NFT${count === 1 ? "" : "s"}` : "…"}
                  </span>
                </div>
                {zeroGas && (
                  <div
                    className="mt-1.5 rounded border border-amber-800 bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300"
                    title="Fund via Send tab from the funding wallet."
                  >
                    no gas — fund from Send tab
                  </div>
                )}
              </div>
            );
          })}
          {funding && (
            <p className="pt-1 text-[10px] text-zinc-600">
              Funding wallet {truncateAddress(funding, 6, 4)} — use the Send tab
              to fund burners.
            </p>
          )}
        </aside>

        {/* Grid + transfer */}
        <section className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={filterWallet}
              onChange={(e) => setFilterWallet(e.target.value)}
              className="rounded border border-edge bg-panelalt px-2 py-1 text-zinc-200"
            >
              <option value="all">All wallets</option>
              {burners.map((b) => (
                <option key={b.address} value={b.address}>
                  #{b.index} {truncateAddress(b.address, 5, 4)}
                </option>
              ))}
            </select>
            <select
              value={filterCollection}
              onChange={(e) => setFilterCollection(e.target.value)}
              className="max-w-[220px] rounded border border-edge bg-panelalt px-2 py-1 text-zinc-200"
            >
              <option value="all">All collections</option>
              {collections.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name / id / contract"
              className="min-w-[180px] flex-1 rounded border border-edge bg-panelalt px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
            />
            <button
              onClick={selectAllFiltered}
              className="rounded border border-edge px-2 py-1 text-zinc-300 hover:border-zinc-500"
            >
              Select all ({filtered.length})
            </button>
          </div>

          {/* Grid */}
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-edge bg-panel p-8 text-center text-sm text-zinc-500">
              {allLoaded ? "No NFTs match." : "Loading NFTs…"}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {filtered.map((it) => (
                <NftCard
                  key={itemKey(it)}
                  item={it}
                  selected={selection.has(itemKey(it))}
                  onToggle={() => toggle(it)}
                  colorClass={dotFor(burnerIndexByAddress.get(it.owner.toLowerCase()) ?? 0)}
                  ownerIndex={burnerIndexByAddress.get(it.owner.toLowerCase()) ?? 0}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Sticky selection / transfer bar */}
      {(selection.size > 0 || stage !== "browse") && (
        <div className="sticky bottom-0 z-20 border-t border-edge bg-panel/95 backdrop-blur">
          <div className="mx-auto max-w-7xl px-4 py-3">
            {stage === "browse" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-zinc-200">
                    {selection.size} selected
                  </span>
                  <button
                    onClick={clearSelection}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    clear
                  </button>
                  <div className="ml-auto flex items-center gap-1 rounded-full border border-edge bg-panelalt p-0.5 text-xs">
                    <button
                      onClick={() => setMode("consolidate")}
                      className={`rounded-full px-3 py-1 ${mode === "consolidate" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400"}`}
                    >
                      Consolidate
                    </button>
                    <button
                      onClick={() => setMode("csv")}
                      className={`rounded-full px-3 py-1 ${mode === "csv" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400"}`}
                    >
                      CSV mapping
                    </button>
                  </div>
                </div>

                {mode === "consolidate" ? (
                  <input
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="Destination address (0x…) for all selected"
                    className="num w-full rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  />
                ) : (
                  <textarea
                    value={mappingText}
                    onChange={(e) => setMappingText(e.target.value)}
                    rows={4}
                    placeholder="contract,tokenId,recipient (one per line)"
                    className="num w-full rounded border border-edge bg-panelalt px-3 py-2 text-sm outline-none focus:border-zinc-500"
                  />
                )}

                {mappingErrors.length > 0 && (
                  <ul className="space-y-1 text-xs text-red-300">
                    {mappingErrors.map((e, i) => (
                      <li key={i}>
                        {e.line > 0 ? `line ${e.line}: ` : ""}
                        {e.reason}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={runPrecheck}
                    disabled={
                      prechecking ||
                      (mode === "consolidate" && selection.size === 0) ||
                      (mode === "csv" && mappingText.trim().length === 0)
                    }
                    className="rounded bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
                  >
                    {prechecking ? "Prechecking…" : "Preview transfer"}
                  </button>
                </div>
              </div>
            )}

            {(stage === "preview" || stage === "confirm" || stage === "run") && (
              <PreviewPanel
                stage={stage}
                preview={preview}
                rowState={rowState}
                okCount={okRows.length}
                totalGas={totalGas}
                walletsInvolved={walletsInvolved}
                chain={activeChain}
                burnerIndexByAddress={burnerIndexByAddress}
                executing={executing}
                allDone={allDone}
                hasFailure={hasFailure}
                onBack={() => setStage("browse")}
                onConfirmStage={() => setStage("confirm")}
                onExecute={execute}
                onResume={resume}
                onDownload={downloadCsv}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Preview / confirm / run panel -----------------------------------------
const ROW_META: Record<RowStatus, { dot: string; text: string }> = {
  queued: { dot: "bg-zinc-600", text: "text-zinc-400" },
  sending: { dot: "bg-amber-400 animate-pulse", text: "text-amber-300" },
  pending: { dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  confirmed: { dot: "bg-emerald-500", text: "text-emerald-300" },
  failed: { dot: "bg-red-500", text: "text-red-300" },
  unconfirmed: { dot: "bg-yellow-500", text: "text-yellow-300" },
  skipped: { dot: "bg-zinc-700", text: "text-zinc-500" },
};

function PreviewPanel({
  stage,
  preview,
  rowState,
  okCount,
  totalGas,
  walletsInvolved,
  chain,
  burnerIndexByAddress,
  executing,
  allDone,
  hasFailure,
  onBack,
  onConfirmStage,
  onExecute,
  onResume,
  onDownload,
}: {
  stage: "preview" | "confirm" | "run";
  preview: PreviewRow[];
  rowState: Record<string, { status: RowStatus; hash?: string; error?: string }>;
  okCount: number;
  totalGas: bigint;
  walletsInvolved: number;
  chain: ChainInfo | null;
  burnerIndexByAddress: Map<string, number>;
  executing: boolean;
  allDone: boolean;
  hasFailure: boolean;
  onBack: () => void;
  onConfirmStage: () => void;
  onExecute: () => void;
  onResume: () => void;
  onDownload: () => void;
}) {
  const excluded = preview.length - okCount;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-zinc-200">
          {okCount} transfer{okCount === 1 ? "" : "s"} · {walletsInvolved} wallet
          {walletsInvolved === 1 ? "" : "s"}
        </span>
        {excluded > 0 && (
          <span className="text-red-300">{excluded} excluded (not owned)</span>
        )}
        {chain && (
          <span className="num text-zinc-500">
            est. gas {totalGas.toString()} units
          </span>
        )}
        {stage === "preview" && (
          <button
            onClick={onBack}
            disabled={executing}
            className="ml-auto text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← back
          </button>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-edge">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panelalt text-[10px] uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 text-left">Item</th>
              <th className="px-2 py-1.5 text-left">From</th>
              <th className="px-2 py-1.5 text-left">To</th>
              <th className="px-2 py-1.5 text-right">Gas</th>
              <th className="px-2 py-1.5 text-left">Status</th>
              <th className="px-2 py-1.5 text-left">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {preview.map((r) => {
              const st = rowState[r.key];
              const notOwned = r.precheck === "not_owned";
              const status: RowStatus = notOwned
                ? "skipped"
                : (st?.status ?? "queued");
              const meta = ROW_META[status];
              return (
                <tr
                  key={r.key}
                  className={notOwned ? "opacity-50" : ""}
                >
                  <td className={`px-2 py-1.5 ${notOwned ? "line-through" : ""}`}>
                    <span className="text-zinc-300">{r.item.name}</span>
                  </td>
                  <td className="px-2 py-1.5 num text-zinc-500">
                    #{burnerIndexByAddress.get(r.item.owner.toLowerCase()) ?? 0}{" "}
                    {truncateAddress(r.item.owner, 4, 4)}
                  </td>
                  <td className="px-2 py-1.5 num text-zinc-500">
                    {truncateAddress(r.to, 4, 4)}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-zinc-500">
                    {r.gasEstimate ?? "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`flex items-center gap-1.5 ${meta.text}`}>
                      <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
                      {notOwned ? "not owned" : status}
                    </span>
                    {st?.error && (
                      <span className="text-[10px] text-red-400">{st.error}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {st?.hash && chain ? (
                      <a
                        href={`${chain.explorerBaseUrl}${st.hash}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="num text-sky-400 hover:underline"
                      >
                        {truncateAddress(st.hash, 5, 5)}
                      </a>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {stage === "preview" && (
          <button
            onClick={onConfirmStage}
            disabled={okCount === 0}
            className="ml-auto rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            Continue ({okCount})
          </button>
        )}

        {stage === "confirm" && (
          <>
            <span className="text-sm text-amber-300">
              Confirm: send {okCount} NFT{okCount === 1 ? "" : "s"} from{" "}
              {walletsInvolved} wallet{walletsInvolved === 1 ? "" : "s"}?
            </span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={onBack}
                className="rounded border border-edge px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
              >
                Cancel
              </button>
              <button
                onClick={onExecute}
                className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400"
              >
                Confirm &amp; send
              </button>
            </div>
          </>
        )}

        {stage === "run" && (
          <>
            <span className="text-sm text-zinc-300">
              {executing ? "Sending…" : allDone ? "Done" : "Stopped"}
            </span>
            <div className="ml-auto flex gap-2">
              {!executing && hasFailure && (
                <button
                  onClick={onResume}
                  className="rounded border border-amber-600 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-950/40"
                >
                  Resume from failed
                </button>
              )}
              {!executing && (
                <button
                  onClick={onDownload}
                  className="rounded border border-edge px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
                >
                  Download results CSV
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
