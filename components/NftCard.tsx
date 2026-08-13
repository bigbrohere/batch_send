"use client";

import { useState } from "react";
import type { NftItem } from "@/lib/nft-types";
import { truncateAddress } from "@/lib/ui";
import { isIpfsUrl } from "@/lib/ipfs";

/** Route flaky IPFS gateways through our multi-gateway proxy; leave CDN URLs alone. */
function displaySrc(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  return isIpfsUrl(imageUrl)
    ? `/api/nft/image?u=${encodeURIComponent(imageUrl)}`
    : imageUrl;
}

export interface AggItem extends NftItem {
  /** Owning burner wallet address. */
  owner: string;
}

export function NftCard({
  item,
  selected,
  onToggle,
  colorClass,
  ownerIndex,
}: {
  item: AggItem;
  selected: boolean;
  onToggle: () => void;
  colorClass: string;
  ownerIndex: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = displaySrc(item.imageUrl);
  const showImg = src && !imgFailed;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`group relative flex flex-col overflow-hidden rounded-lg border text-left transition ${
        selected
          ? "border-emerald-500 ring-1 ring-emerald-500/40"
          : "border-edge hover:border-zinc-500"
      } bg-panel`}
    >
      <span className="absolute left-2 top-2 z-10">
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border ${
            selected
              ? "border-emerald-400 bg-emerald-500 text-emerald-950"
              : "border-zinc-500 bg-black/40"
          }`}
        >
          {selected && (
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
              <path
                d="M2.5 6.5l2 2 5-5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </span>

      {/* 1155 balance badge */}
      {item.standard === "erc1155" && (
        <span className="absolute right-2 top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
          ×{item.balance}
        </span>
      )}

      <div className="aspect-square w-full bg-panelalt">
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src as string}
            alt={item.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <span className="text-3xl">◈</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-[11px] text-zinc-500">
          {item.collectionName || truncateAddress(item.contract, 6, 4)}
        </span>
        <span className="truncate text-xs text-zinc-200">{item.name}</span>
        <span className="mt-1 flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${colorClass}`} />
          <span className="num text-[10px] text-zinc-500">
            #{ownerIndex} {truncateAddress(item.owner, 4, 4)}
          </span>
        </span>
      </div>
    </button>
  );
}
