# @pipeworx/hyperliquid

Read-only data for Hyperliquid, the largest onchain perpetuals exchange (it
also runs a spot market) — mid prices, order books, candles, funding
rates/history, live open interest, and the public account state of any wallet
address (perp margin and positions, spot balances, account value history) —
proxied live, per request, from Hyperliquid's own public info API. No key, no
signing, no trading: the signed exchange endpoints are out of scope on purpose.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `hyperliquid_perp_meta(coin?)` — the perps universe (symbol, size decimals,
  max leverage, delisted flag). Pass `coin` for one symbol, omit for the
  whole list.
- `hyperliquid_spot_meta()` — every spot trading pair Hyperliquid lists, each
  with its pair name, pair index, and the token ids it is composed of.
- `hyperliquid_mids(coin?)` — current mid price for every perp/spot symbol in
  one call, or just one symbol's mid price.
- `hyperliquid_asset_context(coin)` — a perp's live funding rate, open
  interest, mark/oracle/mid price, premium, and 24h volume.
- `hyperliquid_l2_book(coin, depth?)` — the live bid/ask order book (price,
  aggregate size, order count per level).
- `hyperliquid_candles(coin, interval?, lookback_hours?, start_time?, end_time?)`
  — OHLCV candles for any window Hyperliquid retains.
- `hyperliquid_funding_history(coin, lookback_hours?, start_time?, end_time?)`
  — the realized funding-rate series (Hyperliquid pays funding hourly).

- `hyperliquid_account_state(address)` — one wallet's perp account: account
  value, notional, margin used, withdrawable, and every open position (signed
  size, entry, PnL, leverage, liquidation price, cumulative funding).
- `hyperliquid_spot_balances(address, limit?)` — one wallet's spot tokens:
  total, on hold in orders, available, and cost-basis notional.
- `hyperliquid_account_history(address, period?, scope?)` — account value and
  PnL over a day/week/month/all time, with start/end values and volume first.

Account tools read a public ledger: addresses are pseudonymous on-chain
identifiers, Hyperliquid serves their state to anyone without credentials, and
nothing here maps an address to a person. An unknown address returns an explicit
"no activity" answer, not a bare zero.

`hyperliquid_account_state` answers two different questions with two flags, so a
caller never has to infer one from the other: `account_has_balance` (the perp
account value is non-zero, idle dust included) and
`account_has_open_perp_positions` (a position is open, or notional or margin
used is non-zero). A dust-funded address with nothing open is `true` / `false`.

## Auth

Keyless. Hyperliquid's info endpoint (`POST api.hyperliquid.xyz/info`) takes
no API key, account, or signature for any read in this pack.

## Data sources

- <https://api.hyperliquid.xyz/info> — Hyperliquid's public info endpoint.
  Every tool above sends a different `type` in the POST body (`meta`,
  `spotMeta`, `allMids`, `metaAndAssetCtxs`, `l2Book`, `candleSnapshot`,
  `fundingHistory`) — there is one URL, not one per resource.

Things the next caller would otherwise rediscover the hard way:

- **No per-request rate-limit error observed in testing** — Hyperliquid's
  public docs describe IP-based weight limits on the info endpoint, but this
  pack does not special-case a 429; a caller hitting one gets Hyperliquid's
  own error body verbatim (via `httpError`), not a Pipeworx-specific message.
- **Perp vs spot coin IDs are DIFFERENT NAMESPACES, same `coin` argument
  shape.** A perp is addressed by its bare symbol (`"BTC"`, `"ETH"`). A spot
  pair is addressed by `"@<index>"` (e.g. `"@0"`) EXCEPT the one canonical
  pair per token, which also has a human name (`"PURR/USDC"`). Get the right
  id from `hyperliquid_spot_meta`'s `index` field — guessing a spot pair's
  `@N` id from its position elsewhere will be wrong, since indices are not
  contiguous by listing date.
- **`allMids` keys are a flat mix of perp symbols and spot `@N` ids** — there
  is no `type` field distinguishing them in the response; you have to already
  know which namespace a symbol belongs to (perp list from
  `hyperliquid_perp_meta`, spot list from `hyperliquid_spot_meta`).
- **`candleSnapshot` returns `[]` (not an error) for a startTime/endTime
  window that contains no interval boundary** — e.g. a 100ms window at 1h
  granularity. This is a legitimate empty answer, not a broken call; widen
  the window or use a coarser interval.
- **Open interest is reported in BASE ASSET UNITS, not USD** (e.g. a BTC
  figure like `"37751.7"` means 37,751.7 BTC of open interest, not dollars) —
  multiply by `markPx` for a USD figure if that's what's needed.
- **`metaAndAssetCtxs` returns a two-element array, `[meta, assetCtxs]`,
  where `assetCtxs[i]` corresponds to `meta.universe[i]`** — there is no
  per-asset key; you must look up the coin's index in `universe` first and
  use that same index into `assetCtxs`. This pack does that lookup for you in
  `hyperliquid_asset_context`.
- **Historical open-interest is not published separately** — only the
  CURRENT open interest is available (via `metaAndAssetCtxs`/
  `hyperliquid_asset_context`); there is no `openInterestHistory` endpoint
  analogous to `fundingHistory`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hyperliquid": {
      "url": "https://gateway.pipeworx.io/hyperliquid/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/hyperliquid/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/hyperliquid_perp_meta \
  -H 'Content-Type: application/json' \
  -d '{"coin":"BTC"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/hyperliquid_perp_meta`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-hyperliquid` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/hyperliquid/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "hyperliquid": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-hyperliquid"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Hyperliquid data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
