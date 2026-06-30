// Minimal MCP client smoke test: spawns the server over stdio, lists tools,
// calls both tools, and prints results. Run with: node scripts/smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  // STORE-001 -> STORE_KEY_STORE_001
  env: {
    ...getDefaultEnvironment(),
    STORE_KEY_STORE_001: "sk_live_store001_demo",
  },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

const inv = await client.callTool({
  name: "get_store_inventory_and_sales",
  arguments: { storeId: "STORE-001", lowStockOnly: true },
});
console.log("\n--- get_store_inventory_and_sales (STORE-001, lowStockOnly) ---");
console.log(inv.content[0].text);

const order = await client.callTool({
  name: "create_replenishment_order",
  arguments: {
    storeId: "STORE-001",
    lines: [
      { sku: "SKU-1001", quantity: 60 },
      { sku: "SKU-1003", quantity: 36 },
      { sku: "SKU-1004", quantity: 24 },
    ],
    notes: "Weekly low-stock top-up",
  },
});
console.log("\n--- create_replenishment_order ---");
console.log(order.content[0].text);

await client.close();
