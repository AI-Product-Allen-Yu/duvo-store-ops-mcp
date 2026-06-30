# store-ops-mcp

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server built on the
official SDK (`@modelcontextprotocol/sdk`). It exposes two store-operations tools backed by
in-memory **mock data** (no database required):

| Tool | Purpose |
| --- | --- |
| `get_store_inventory_and_sales` | **Consolidated read** — inventory levels *and* sales velocity for a store in one call, plus days-of-supply, low-stock flags, and reorder suggestions. |
| `create_replenishment_order` | Places a mock restock order for one or more SKUs, groups lines into purchase orders by supplier, and returns a costed confirmation. |
| `evaluate_replenishment` | **Check-and-replenish workflow** — for one SKU across N stores, compares on-hand vs. last 24h POS, computes the shortfall gap, and auto-raises an order at every store whose gap exceeds a threshold (default 6). |

## Setup

```bash
npm install
npm run build      # compiles src/ -> dist/
```

## Run

```bash
npm start          # node dist/index.js  (speaks MCP over stdio)
```

## Docker / deployment

A production multi-stage [`Dockerfile`](Dockerfile) builds a minimal, non-root image:

```bash
docker build -t store-ops-mcp:1.0.0 .
docker run -i --rm \
  -e STORE_KEY_47=sk_live_xxx \
  -v store-ops-logs:/var/log/store-ops \
  store-ops-mcp:1.0.0
```

`-i` is required — the server speaks MCP over stdio. See [DEPLOYMENT.md](DEPLOYMENT.md) for running
**entirely inside Korral's private cloud with full data residency** (air-gap posture, secrets,
log volumes, Kubernetes manifest).

The server communicates over **stdio**, the standard transport for local MCP servers. It
prints a banner to **stderr** (stdout is reserved for the JSON-RPC protocol stream).

## Smoke test

A tiny MCP client is included that spawns the server, lists the tools, and calls both:

```bash
node scripts/smoke-test.mjs
```

## Use it from an MCP client

Add it to a client's MCP config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "store-ops": {
      "command": "node",
      "args": ["E:\\temp\\duvo\\dist\\index.js"]
    }
  }
}
```

## Tool reference

### `get_store_inventory_and_sales`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `storeId` | string | yes | `STORE-001` or `STORE-002` |
| `category` | string | no | Filter, e.g. `Dairy`, `Beverages`, `Household` |
| `lowStockOnly` | boolean | no | Return only items at/below their reorder point |

Returns store totals plus a per-SKU breakdown with `inventory`, `sales`
(incl. `revenue30d`, `daysOfSupply`), and `replenishment` (suggested qty + supplier/lead time).

### `create_replenishment_order`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `storeId` | string | yes | Target store |
| `lines` | array | yes | `[{ "sku": "SKU-1001", "quantity": 60 }, ...]` |
| `notes` | string | no | Free-text note on the order |

The order is validated all-or-nothing (unknown SKUs reject the whole order), grouped into one
purchase order per supplier, costed at wholesale `unitCost`, and the affected products'
`onOrder` quantities are updated so subsequent inventory reads reflect the pending order.

### `evaluate_replenishment`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `sku` | string | yes | Product to evaluate, e.g. `8847291` |
| `storeIds` | string[] | yes | Stores to check, e.g. `["47", "102"]` |
| `gapThreshold` | number | no | Order only when `(last24h sales - on-hand) > threshold`. Default `6` |
| `dryRun` | boolean | no | Evaluate/recommend without placing orders |

**Decision rule:** `gap = unitsSoldLast24h - onHand`. When `gap > gapThreshold` the store
is _breached_ and an order for `max(reorderQuantity, gap)` units is raised; otherwise no action.
This is the logic behind the worked example:

> _SKU 8847291 (Madeta butter 250g) is running empty at stores 47 and 102. Check on-hand vs.
> last 24h of POS for both, and raise a replenishment order for any store where the gap exceeds
> 6 units._

```bash
node scripts/task-scenario.mjs
```

Result: **Store 47** (on-hand 4, sold 18 → gap **14 > 6**) → order `RO-47-0001` for 48 units;
**Store 102** (on-hand 5, sold 9 → gap **4 ≤ 6**) → no action.

## Credentials

Every store is gated by a per-store API key read from the environment. The variable name is
`STORE_KEY_<STOREID>` — the storeId upper-cased with non-alphanumerics collapsed to `_`:

| Store | Env var |
| --- | --- |
| `47` | `STORE_KEY_47` |
| `102` | `STORE_KEY_102` |
| `STORE-001` | `STORE_KEY_STORE_001` |

Behaviour (implemented in [`src/index.ts`](src/index.ts) → `validateStoreCredential`):

- **Fail safe** — a missing or blank key never throws or crashes the server. Single-store tools
  return an `isError` result (`Access denied. Missing credential …`); the multi-store
  `evaluate_replenishment` marks just that store `credential_invalid` and continues with the rest.
  The raw key is never logged or returned — only a short SHA-256 fingerprint is used internally.
- **Mid-flight changes** — the variable is re-read on **every** call (never cached at startup), so
  rotating or removing a key takes effect on the next request with no restart. A changed key is
  detected via fingerprint and logged as `credential_rotated` (audit + debug).

```bash
# example
export STORE_KEY_47=sk_live_xxx
export STORE_KEY_102=sk_live_yyy
node dist/index.js
```

Demonstrate the full lifecycle (missing → present → rotated → removed → blank):

```bash
node scripts/credential-test.mjs
```

## Dual logging

Every tool call writes to two append-only logs (see [`src/logger.ts`](src/logger.ts)). The
location defaults to the process working directory; override with `STORE_OPS_LOG_DIR`.

- **`buyer_audit.log`** — plain, simple English. One readable line per business event for a
  buyer/ops reader:
  ```
  [2026-06-30T19:09:55.382Z] Store 47 (Praha Vinohrady): Madeta butter 250g running low — 4 on hand vs 18 sold in last 24h (gap 14 over 6). Raised order RO-47-0001 for 48 unit(s).
  [2026-06-30T19:09:55.414Z] Store 102 (Brno Kralovo Pole): Madeta butter 250g stock OK — 5 on hand vs 9 sold in last 24h (gap 4 within threshold 6). No order needed.
  ```
- **`fde_debug.log`** — structured JSONL (one JSON object per line) with full technical detail
  for a Forward Deployed Engineer:
  ```json
  {"ts":"2026-06-30T19:09:55.365Z","event":"replenishment_evaluation","storeId":"47","sku":"8847291","onHand":4,"unitsSoldLast24h":18,"gap":14,"gapThreshold":6,"breached":true,"action":"order_placed","orderId":"RO-47-0001","quantity":48}
  ```

stdout is never used for logging — it carries the MCP JSON-RPC stream.

Example traces are committed under [`samples/`](samples/) (the live `*.log` files are
gitignored — they're generated artifacts and hold business data in production).

## Mock data

Defined in [`src/data.ts`](src/data.ts): two stores, several SKUs each, three suppliers with
lead times. Edit that file to change the catalog.

## Project layout

```
src/index.ts          MCP server + tool definitions
src/data.ts           mock stores / products / suppliers
scripts/smoke-test.mjs end-to-end client test
dist/                 compiled output (after npm run build)
```
