// Reproduces the exact operational task:
// "SKU 8847291 is running empty at stores 47 and 102. Check on-hand vs. last 24h
//  of POS for both, and raise a replenishment order for any store where the gap
//  exceeds 6 units."
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  // Supply the per-store credentials the server now requires.
  env: {
    ...getDefaultEnvironment(),
    STORE_KEY_47: "sk_live_store47_demo",
    STORE_KEY_102: "sk_live_store102_demo",
  },
});
const client = new Client({ name: "task-scenario", version: "1.0.0" });
await client.connect(transport);

const res = await client.callTool({
  name: "evaluate_replenishment",
  arguments: { sku: "8847291", storeIds: ["47", "102"], gapThreshold: 6 },
});
console.log(res.content[0].text);

await client.close();
