import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
const env = { ...getDefaultEnvironment() };
delete env.STORE_KEY_47; delete env.STORE_KEY_102; // ensure absent
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env });
const client = new Client({ name: "missing-key", version: "1.0.0" });
await client.connect(transport);
const evalRes = await client.callTool({ name: "evaluate_replenishment", arguments: { sku: "8847291", storeIds: ["47","102"] } });
const parsed = JSON.parse(evalRes.content[0].text);
console.log("evaluate_replenishment (no keys):", parsed.evaluations.map(e=>`${e.storeId}:${e.status||e.action}`).join(", "));
const invRes = await client.callTool({ name: "get_store_inventory_and_sales", arguments: { storeId: "47" } });
console.log("get_store_inventory_and_sales (no key): isError =", invRes.isError, "|", invRes.content[0].text);
await client.close();
