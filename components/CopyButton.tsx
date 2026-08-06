"use client";

import { useState } from "react";
import { copyToClipboard } from "@/lib/ui";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }}
      className="rounded border border-edge px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
      title="Copy"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
