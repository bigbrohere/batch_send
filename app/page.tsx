"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { SendTab } from "@/components/SendTab";
import { NftsTab } from "@/components/NftsTab";

type Tab = "send" | "nfts";

export default function Home() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("send");
  // Mount the NFTs tab lazily on first open, then keep it mounted so its state
  // (loaded NFTs, selection, draft) survives switching back and forth.
  const [nftsVisited, setNftsVisited] = useState(false);

  const onLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
    router.refresh();
  }, [router]);

  return (
    <main className="min-h-screen">
      {/* Global top bar: app + tab switcher + logout */}
      <div className="border-b border-edge bg-panel">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2">
          <span className="text-sm font-semibold tracking-tight">Batch Send</span>
          <nav className="flex items-center gap-1 rounded-full border border-edge bg-panelalt p-0.5 text-xs">
            <button
              onClick={() => setTab("send")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "send"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Send
            </button>
            <button
              onClick={() => {
                setTab("nfts");
                setNftsVisited(true);
              }}
              className={`rounded-full px-3 py-1 transition ${
                tab === "nfts"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              NFTs
            </button>
          </nav>
          <button
            onClick={onLogout}
            className="ml-auto rounded border border-edge px-2 py-1 text-xs text-zinc-400 transition hover:border-red-500 hover:text-red-300"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Keep both tabs mounted (once visited) so their state persists. */}
      <div hidden={tab !== "send"}>
        <SendTab />
      </div>
      {nftsVisited && (
        <div hidden={tab !== "nfts"}>
          <NftsTab />
        </div>
      )}
    </main>
  );
}
