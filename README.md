# Batch Send

One-to-many bulk transfers of **native tokens** across six EVM chains and
Solana. Single admin user, server-side signing only — **private keys never
reach the browser**. Built with Next.js (App Router) + TypeScript, deployable on
Vercel with no database or external services.

## Supported chains

| Chain | chainId | Native | Explorer | Default RPC |
|---|---|---|---|---|
| Ethereum | 1 | ETH | etherscan.io | *(env required)* |
| Base | 8453 | ETH | basescan.org | https://mainnet.base.org |
| Arbitrum One | 42161 | ETH | arbiscan.io | https://arb1.arbitrum.io/rpc |
| Polygon PoS | 137 | POL | polygonscan.com | https://polygon-rpc.com |
| HyperEVM | 999 | HYPE | hyperevmscan.io | https://rpc.hyperliquid.xyz/evm |
| Robinhood Chain | 4663 | ETH | robinhoodchain.blockscout.com | https://rpc.mainnet.chain.robinhood.com |
| Solana | — | SOL | solscan.io | *(env required)* |

One EVM private key produces the same address on all six EVM chains. Solana has
its own key/address.

## Stack

- Next.js 14 (App Router), TypeScript, Tailwind
- `viem` for all EVM chains (`mainnet`/`base`/`arbitrum`/`polygon` built-ins;
  HyperEVM and Robinhood Chain via `defineChain`)
- `@solana/web3.js` + `bs58` for Solana
- `zod` for server-side request validation

## Environment variables

All server-only — **never** prefixed `NEXT_PUBLIC_`. See `.env.example`.

```
EVM_PRIVATE_KEY=0x...      # same key/address on all EVM chains
ETHEREUM_RPC_URL=https://...   # required to enable Ethereum
BASE_RPC_URL=              # optional — falls back to default public RPC
ARBITRUM_RPC_URL=          # optional
POLYGON_RPC_URL=           # optional
HYPEREVM_RPC_URL=          # optional
ROBINHOOD_RPC_URL=         # optional
SOLANA_PRIVATE_KEY=        # base58 secret key (Phantom export format)
SOLANA_RPC_URL=https://... # required to enable Solana
ADMIN_PASSWORD=...
SESSION_SECRET=...         # random 32+ chars, cookie signing
```

**Enablement rules** (`lib/env.ts`): all EVM chains require `EVM_PRIVATE_KEY`;
Ethereum additionally requires its RPC var (public L1 endpoints are unreliable);
the other five EVM chains fall back to a default public RPC. Solana requires both
of its vars. Disabled chains are simply hidden — the app never crashes.

## Security model

- Single admin password → SHA-256 + `timingSafeEqual` comparison, 500ms fixed
  delay on failure.
- Session cookie = `HMAC-SHA256(SESSION_SECRET, "admin")`, httpOnly + Secure +
  SameSite=Lax, 12h max age.
- `middleware.ts` (Edge) guards every page and every `/api/*` except `/login` and
  `/api/auth/login`; each route handler re-checks the cookie as defense in depth.
- On `prepare` **and** on each send, `eth_chainId` is verified against the
  registry — a mis-set RPC hard-fails and nothing is signed.
- `robots.txt` `Disallow: /` and `noindex` meta on every page.
- No private keys or env contents are ever logged or returned to the client.

## Execution model (Vercel-timeout safe)

Recipient loops run in the **client**, not inside a single API call:

- **EVM:** `POST /api/evm/prepare` returns `{ from, nonce }`; the client loops
  recipients sequentially calling `POST /api/evm/send-one` (incrementing the
  nonce locally), then polls `GET /api/evm/receipt` up to 60s per tx. The server
  re-parses the decimal to wei and re-validates on every send.
- **Solana:** recipients are chunked into groups of 15; each chunk is one
  transaction of 15 `SystemProgram.transfer` instructions via
  `POST /api/solana/send-batch` (`maxDuration = 60`), confirmed at `'confirmed'`.

On failure the loop stops, confirmed rows are kept, and **Resume from failed**
re-prepares a fresh nonce and continues from the first non-confirmed row.
Already-broadcast rows are never re-sent.

## Balances (exact)

`POST /api/balances` returns raw units (wei/lamports) as **strings** — never JS
numbers. EVM uses Multicall3 when deployed (probed once per chain via `getCode`
for HyperEVM / Robinhood Chain, cached in module scope), otherwise parallel
`getBalance` at concurrency 10. Solana uses `getMultipleAccountsInfo` in chunks
of 100 (missing account = 0 lamports). The UI shows full precision with trailing
zeros trimmed and the raw value in a tooltip.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev
```

`npm run build` / `npm run typecheck` for CI checks.

## Deploy (Vercel)

Import the repo, set the environment variables above in the Vercel project
settings, and deploy. No database or other services required.

---

*Hot wallet tool — keep only operational funds in the configured wallets.*
