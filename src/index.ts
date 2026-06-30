#!/usr/bin/env node
/**
 * Store Ops MCP server.
 *
 * Exposes two tools over the official Model Context Protocol TypeScript SDK:
 *
 *   1. get_store_inventory_and_sales — a consolidated read tool that returns
 *      inventory levels AND sales velocity for a store in a single call, plus
 *      derived signals (days of supply, low-stock flags, reorder suggestions).
 *
 *   2. create_replenishment_order — places a mock replenishment order for one
 *      or more SKUs, grouping lines by supplier and returning an order summary.
 *
 * Transport: stdio (the standard for local MCP servers / desktop clients).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  STORES,
  SUPPLIERS,
  findStore,
  knownStoreIds,
  type Product,
} from "./data.js";
import { auditLog, debugLog, AUDIT_LOG_PATH, DEBUG_LOG_PATH } from "./logger.js";

const server = new McpServer({
  name: "store-ops-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Credential validation
//
// Each store is gated by a per-store API key supplied via an environment
// variable named STORE_KEY_<STOREID> (storeId upper-cased, non-alphanumerics
// collapsed to "_"). For example:
//   store "47"        -> STORE_KEY_47
//   store "STORE-001" -> STORE_KEY_STORE_001
//
// Design goals:
//   * Fail safe — a missing/blank key never throws or crashes the server; the
//     caller gets a clear, non-leaking error and the operation is refused.
//   * Mid-flight changes — the env var is re-read on EVERY call (never cached at
//     startup), so rotating or removing a key takes effect on the next request
//     with no restart. Rotations are detected and logged via a fingerprint.
// ---------------------------------------------------------------------------

const STORE_KEY_PREFIX = "STORE_KEY_";

/** Map a storeId to the env var name that should hold its API key. */
function storeKeyEnvName(storeId: string): string {
  return STORE_KEY_PREFIX + storeId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Short, non-reversible fingerprint — lets us detect rotation without logging secrets. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

// Last-seen credential fingerprint per store, so a mid-flight rotation is
// noticed and adopted rather than silently used or rejected.
const credentialState = new Map<string, string>();

export type CredentialResult =
  | { ok: true; envName: string; fingerprint: string; rotated: boolean }
  | { ok: false; envName: string; reason: string };

/**
 * Validate a store's credential from the environment at call time. Returns a
 * result object (never throws) and never includes the raw key in its output.
 */
export function validateStoreCredential(storeId: string): CredentialResult {
  const envName = storeKeyEnvName(storeId);
  const raw = process.env[envName];

  if (raw === undefined || raw.trim() === "") {
    // Missing or blank -> fail safe. Forget any stale fingerprint for this store
    // so that re-adding the key later is treated as a fresh load, not a rotation.
    credentialState.delete(storeId);
    debugLog("credential_missing", { storeId, envName });
    return {
      ok: false,
      envName,
      reason: `Missing credential for store ${storeId}: set environment variable ${envName}.`,
    };
  }

  const fp = fingerprint(raw);
  const previous = credentialState.get(storeId);
  const rotated = previous !== undefined && previous !== fp;
  credentialState.set(storeId, fp);

  if (rotated) {
    auditLog(`Credential for store ${storeId} was rotated; continuing with the updated key.`);
    debugLog("credential_rotated", { storeId, envName, fingerprint: fp, previousFingerprint: previous });
  } else if (previous === undefined) {
    debugLog("credential_loaded", { storeId, envName, fingerprint: fp });
  }

  return { ok: true, envName, fingerprint: fp, rotated };
}

/** Build the standard MCP error result for a failed credential check. */
function credentialErrorResult(result: { reason: string }) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Access denied. ${result.reason}` }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Build the enriched per-product view used by the inventory tool. */
function summarizeProduct(p: Product) {
  const available = p.onHand + p.onOrder;
  const daysOfSupply = p.avgDailySales > 0 ? round(p.onHand / p.avgDailySales, 1) : null;
  const lowStock = p.onHand <= p.reorderPoint;
  const suggestedOrderQty = lowStock && available <= p.reorderPoint ? p.reorderQuantity : 0;
  const supplier = SUPPLIERS[p.supplierId];

  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    inventory: {
      onHand: p.onHand,
      onOrder: p.onOrder,
      available,
      reorderPoint: p.reorderPoint,
      lowStock,
    },
    sales: {
      avgDailySales: p.avgDailySales,
      unitsSold30d: p.unitsSold30d,
      unitsSoldLast24h: p.unitsSoldLast24h,
      retailPrice: p.retailPrice,
      revenue30d: round(p.unitsSold30d * p.retailPrice),
      daysOfSupply,
    },
    replenishment: {
      suggestedOrderQty,
      reorderQuantity: p.reorderQuantity,
      supplierId: p.supplierId,
      supplierName: supplier?.name ?? "Unknown",
      leadTimeDays: supplier?.leadTimeDays ?? null,
    },
  };
}

interface OrderLine {
  sku: string;
  quantity: number;
}

/**
 * Core replenishment-order builder shared by the manual order tool and the
 * automated check-and-replenish workflow. Validates lines all-or-nothing,
 * groups them into one purchase order per supplier, costs them, and mutates
 * each product's `onOrder` so later inventory reads reflect the pending order.
 */
function placeReplenishmentOrder(
  store: ReturnType<typeof findStore> & {},
  lines: OrderLine[],
  notes?: string,
): { ok: true; confirmation: any } | { ok: false; error: string } {
  const errors: string[] = [];
  const resolved = lines.map((line) => {
    const product = store.products.find(
      (p) => p.sku.toLowerCase() === line.sku.toLowerCase(),
    );
    if (!product) errors.push(`SKU "${line.sku}" not stocked at ${store.storeId}.`);
    return { line, product };
  });

  if (errors.length > 0) {
    return {
      ok: false,
      error:
        `${errors.join(" ")} ` +
        `Valid SKUs at ${store.storeId}: ${store.products.map((p) => p.sku).join(", ")}.`,
    };
  }

  const poBySupplier = new Map<
    string,
    { supplierId: string; supplierName: string; leadTimeDays: number; lines: any[]; subtotal: number }
  >();

  for (const { line, product } of resolved) {
    const p = product!;
    const supplier = SUPPLIERS[p.supplierId];
    const lineTotal = round(line.quantity * p.unitCost);

    p.onOrder += line.quantity; // mutate mock state

    if (!poBySupplier.has(p.supplierId)) {
      poBySupplier.set(p.supplierId, {
        supplierId: p.supplierId,
        supplierName: supplier?.name ?? "Unknown",
        leadTimeDays: supplier?.leadTimeDays ?? 0,
        lines: [],
        subtotal: 0,
      });
    }
    const po = poBySupplier.get(p.supplierId)!;
    po.lines.push({
      sku: p.sku,
      name: p.name,
      quantity: line.quantity,
      unitCost: p.unitCost,
      lineTotal,
    });
    po.subtotal = round(po.subtotal + lineTotal);
  }

  const orderSeq = ((globalThis as any).__orderSeq = ((globalThis as any).__orderSeq ?? 0) + 1);
  const orderId = `RO-${store.storeId}-${String(orderSeq).padStart(4, "0")}`;

  const purchaseOrders = [...poBySupplier.values()].map((po, i) => ({
    poNumber: `${orderId}-PO${i + 1}`,
    supplierId: po.supplierId,
    supplierName: po.supplierName,
    expectedLeadTimeDays: po.leadTimeDays,
    lines: po.lines,
    subtotal: po.subtotal,
  }));

  const orderTotal = round(purchaseOrders.reduce((sum, po) => sum + po.subtotal, 0));
  const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);

  const confirmation = {
    status: "created",
    orderId,
    storeId: store.storeId,
    storeName: store.name,
    totalUnits,
    orderTotal,
    purchaseOrderCount: purchaseOrders.length,
    purchaseOrders,
    notes: notes ?? null,
  };

  // Structured technical record for every order, regardless of caller.
  debugLog("replenishment_order_created", { confirmation });

  return { ok: true, confirmation };
}

// ---------------------------------------------------------------------------
// Tool 1: get_store_inventory_and_sales  (consolidated read)
// ---------------------------------------------------------------------------

server.registerTool(
  "get_store_inventory_and_sales",
  {
    title: "Get Store Inventory & Sales",
    description:
      "Consolidated view of inventory levels and sales performance for a store. " +
      "Returns per-SKU on-hand/on-order stock, 30-day sales velocity and revenue, " +
      "days-of-supply, low-stock flags, and suggested reorder quantities. " +
      "Optionally filter by category or show only low-stock items.",
    inputSchema: {
      storeId: z
        .string()
        .describe(`Store identifier, e.g. one of: ${knownStoreIds().join(", ")}`),
      category: z
        .string()
        .optional()
        .describe("Optional category filter, e.g. 'Dairy', 'Beverages', 'Household'."),
      lowStockOnly: z
        .boolean()
        .optional()
        .describe("If true, return only items at or below their reorder point."),
    },
  },
  async ({ storeId, category, lowStockOnly }) => {
    const store = findStore(storeId);
    if (!store) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown storeId "${storeId}". Known stores: ${knownStoreIds().join(", ")}.`,
          },
        ],
      };
    }

    const cred = validateStoreCredential(store.storeId);
    if (!cred.ok) return credentialErrorResult(cred);

    let products = store.products.map(summarizeProduct);
    if (category) {
      const c = category.toLowerCase();
      products = products.filter((p) => p.category.toLowerCase() === c);
    }
    if (lowStockOnly) {
      products = products.filter((p) => p.inventory.lowStock);
    }

    const result = {
      storeId: store.storeId,
      storeName: store.name,
      region: store.region,
      itemCount: products.length,
      lowStockCount: products.filter((p) => p.inventory.lowStock).length,
      totalRevenue30d: round(products.reduce((sum, p) => sum + p.sales.revenue30d, 0)),
      products,
    };

    const filterNote = [
      category ? `category ${category}` : null,
      lowStockOnly ? "low-stock only" : null,
    ]
      .filter(Boolean)
      .join(", ");
    auditLog(
      `Reviewed inventory and sales for ${store.name} (store ${store.storeId})` +
        `${filterNote ? ` [${filterNote}]` : ""}: ${result.itemCount} item(s), ` +
        `${result.lowStockCount} low on stock, $${result.totalRevenue30d} in 30-day sales.`,
    );
    debugLog("inventory_query", {
      storeId: store.storeId,
      filters: { category: category ?? null, lowStockOnly: Boolean(lowStockOnly) },
      itemCount: result.itemCount,
      lowStockCount: result.lowStockCount,
      totalRevenue30d: result.totalRevenue30d,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool 2: create_replenishment_order
// ---------------------------------------------------------------------------

server.registerTool(
  "create_replenishment_order",
  {
    title: "Create Replenishment Order",
    description:
      "Place a replenishment (restock) order for one or more SKUs at a store. " +
      "Validates each SKU against the store, groups lines by supplier into " +
      "purchase orders, computes line/PO/order totals, and updates on-order " +
      "quantities. Returns a confirmation with per-PO detail.",
    inputSchema: {
      storeId: z
        .string()
        .describe(`Store identifier, e.g. one of: ${knownStoreIds().join(", ")}`),
      lines: z
        .array(
          z.object({
            sku: z.string().describe("Product SKU to reorder."),
            quantity: z
              .number()
              .int()
              .positive()
              .describe("Number of units to order."),
          }),
        )
        .min(1)
        .describe("One or more order lines (SKU + quantity)."),
      notes: z.string().optional().describe("Optional note attached to the order."),
    },
  },
  async ({ storeId, lines, notes }) => {
    const store = findStore(storeId);
    if (!store) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown storeId "${storeId}". Known stores: ${knownStoreIds().join(", ")}.`,
          },
        ],
      };
    }

    const cred = validateStoreCredential(store.storeId);
    if (!cred.ok) return credentialErrorResult(cred);

    const result = placeReplenishmentOrder(store, lines, notes);
    if (!result.ok) {
      auditLog(`Replenishment order for ${store.name} (store ${store.storeId}) was rejected.`);
      debugLog("replenishment_order_rejected", { storeId: store.storeId, lines, reason: result.error });
      return {
        isError: true,
        content: [{ type: "text", text: `Order rejected. ${result.error}` }],
      };
    }

    const c = result.confirmation;
    auditLog(
      `Placed replenishment order ${c.orderId} for ${store.name} (store ${store.storeId}): ` +
        `${c.totalUnits} unit(s) across ${c.purchaseOrderCount} purchase order(s), ` +
        `total $${c.orderTotal}.`,
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result.confirmation, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool 3: evaluate_replenishment  (check-and-replenish workflow)
// ---------------------------------------------------------------------------

server.registerTool(
  "evaluate_replenishment",
  {
    title: "Evaluate & Replenish Low Stock",
    description:
      "For a single SKU across one or more stores, compare on-hand stock against " +
      "the last 24 hours of POS sales, compute the shortfall gap " +
      "(units sold in last 24h minus units on hand), and automatically raise a " +
      "replenishment order at every store whose gap exceeds a threshold " +
      "(default 6 units). Returns the per-store evaluation plus any orders created. " +
      "Set dryRun=true to evaluate without placing orders.",
    inputSchema: {
      sku: z.string().describe("Product SKU to evaluate, e.g. '8847291'."),
      storeIds: z
        .array(z.string())
        .min(1)
        .describe("Stores to check, e.g. ['47', '102']."),
      gapThreshold: z
        .number()
        .nonnegative()
        .optional()
        .describe("Raise an order only when (last24h sales - on-hand) exceeds this. Default 6."),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, evaluate and recommend but do not place orders."),
    },
  },
  async ({ sku, storeIds, gapThreshold, dryRun }) => {
    const threshold = gapThreshold ?? 6;
    const evaluations: any[] = [];
    const ordersCreated: any[] = [];

    for (const storeId of storeIds) {
      const store = findStore(storeId);
      if (!store) {
        debugLog("replenishment_evaluation_skipped", { storeId, reason: "store_not_found" });
        auditLog(`Could not check store ${storeId}: store not found.`);
        evaluations.push({
          storeId,
          status: "store_not_found",
          message: `Unknown storeId. Known stores: ${knownStoreIds().join(", ")}.`,
        });
        continue;
      }

      // Per-store credential gate. A bad key for one store must not abort the
      // whole batch — record it and move on (fail safe + smooth partial result).
      const cred = validateStoreCredential(store.storeId);
      if (!cred.ok) {
        auditLog(`Skipped store ${store.storeId} (${store.name}): ${cred.reason}`);
        evaluations.push({
          storeId: store.storeId,
          storeName: store.name,
          status: "credential_invalid",
          message: cred.reason,
        });
        continue;
      }

      const product = store.products.find(
        (p) => p.sku.toLowerCase() === sku.toLowerCase(),
      );
      if (!product) {
        debugLog("replenishment_evaluation_skipped", {
          storeId: store.storeId,
          sku,
          reason: "sku_not_stocked",
        });
        auditLog(`Store ${store.storeId} (${store.name}): SKU ${sku} is not stocked here — skipped.`);
        evaluations.push({
          storeId: store.storeId,
          storeName: store.name,
          status: "sku_not_stocked",
          message: `SKU "${sku}" not stocked here.`,
        });
        continue;
      }

      const onHand = product.onHand;
      const sold24h = product.unitsSoldLast24h;
      const gap = sold24h - onHand; // positive => demand outran stock
      const breached = gap > threshold;

      const evaluation: any = {
        storeId: store.storeId,
        storeName: store.name,
        sku: product.sku,
        name: product.name,
        onHand,
        unitsSoldLast24h: sold24h,
        gap,
        gapThreshold: threshold,
        breached,
      };

      if (breached && !dryRun) {
        // Order enough to clear the shortfall, at least one standard reorder lot.
        const orderQty = Math.max(product.reorderQuantity, gap);
        evaluation.action = "order_placed";
        evaluation.orderedQuantity = orderQty;

        const result = placeReplenishmentOrder(
          store,
          [{ sku: product.sku, quantity: orderQty }],
          `Auto-replenishment: 24h gap ${gap} > threshold ${threshold}`,
        );
        if (result.ok) {
          evaluation.orderId = result.confirmation.orderId;
          ordersCreated.push(result.confirmation);
        } else {
          evaluation.action = "order_failed";
          evaluation.error = result.error;
        }
      } else if (breached && dryRun) {
        evaluation.action = "order_recommended";
        evaluation.recommendedQuantity = Math.max(product.reorderQuantity, gap);
      } else {
        evaluation.action = "no_action";
      }

      debugLog("replenishment_evaluation", {
        storeId: store.storeId,
        sku: product.sku,
        onHand,
        unitsSoldLast24h: sold24h,
        gap,
        gapThreshold: threshold,
        breached,
        action: evaluation.action,
        orderId: evaluation.orderId ?? null,
        quantity: evaluation.orderedQuantity ?? evaluation.recommendedQuantity ?? null,
      });

      if (evaluation.action === "order_placed") {
        auditLog(
          `Store ${store.storeId} (${store.name}): ${product.name} running low — ` +
            `${onHand} on hand vs ${sold24h} sold in last 24h (gap ${gap} over ${threshold}). ` +
            `Raised order ${evaluation.orderId} for ${evaluation.orderedQuantity} unit(s).`,
        );
      } else if (evaluation.action === "order_recommended") {
        auditLog(
          `Store ${store.storeId} (${store.name}): ${product.name} running low — ` +
            `${onHand} on hand vs ${sold24h} sold in last 24h (gap ${gap} over ${threshold}). ` +
            `Recommend ordering ${evaluation.recommendedQuantity} unit(s) (dry run — no order placed).`,
        );
      } else if (evaluation.action === "order_failed") {
        auditLog(
          `Store ${store.storeId} (${store.name}): ${product.name} flagged low but the order could not be placed.`,
        );
      } else {
        auditLog(
          `Store ${store.storeId} (${store.name}): ${product.name} stock OK — ` +
            `${onHand} on hand vs ${sold24h} sold in last 24h (gap ${gap} within threshold ${threshold}). No order needed.`,
        );
      }

      evaluations.push(evaluation);
    }

    const summary = {
      sku,
      gapThreshold: threshold,
      dryRun: Boolean(dryRun),
      storesChecked: storeIds.length,
      storesBreached: evaluations.filter((e) => e.breached).length,
      ordersPlaced: ordersCreated.length,
      evaluations,
      ordersCreated,
    };

    auditLog(
      `Replenishment check for SKU ${sku} across ${summary.storesChecked} store(s): ` +
        `${summary.storesBreached} below threshold, ${summary.ordersPlaced} order(s) placed` +
        `${dryRun ? " (dry run)" : ""}.`,
    );
    debugLog("replenishment_run_summary", {
      sku,
      gapThreshold: threshold,
      dryRun: Boolean(dryRun),
      storesChecked: summary.storesChecked,
      storesBreached: summary.storesBreached,
      ordersPlaced: summary.ordersPlaced,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the JSON-RPC protocol stream.
  console.error(
    `store-ops-mcp running on stdio | stores: ${STORES.map((s) => s.storeId).join(", ")}`,
  );
  console.error(`  audit log: ${AUDIT_LOG_PATH}`);
  console.error(`  debug log: ${DEBUG_LOG_PATH}`);
  debugLog("server_started", { stores: STORES.map((s) => s.storeId) });
}

// Start the stdio server only when run directly — importing the module (e.g.
// from a credential unit test) must not begin reading stdin.
const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((err) => {
    console.error("Fatal error starting store-ops-mcp:", err);
    process.exit(1);
  });
}
