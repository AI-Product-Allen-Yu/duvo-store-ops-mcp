#!/usr/bin/env node
//
// STEP 4 — "Locking it down" demo.
//
// Demonstrates the two credential failure stories Korral IT will judge:
//   (a) a per-store API key rotates WHILE the server is running (weekly rotation)
//   (b) the agent asks for a store we hold NO credential for
//
// Both fail safely (no crash) and informatively (clear, actionable message),
// and everything is captured in an audit trail with NO secrets in the logs.
//
// Run locally:   node scripts/lockdown-demo.mjs
// Run in image:  docker run --rm -v "${PWD}/scripts:/app/scripts:ro" \
//                  store-ops-mcp:1.0.0 node scripts/lockdown-demo.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { validateStoreCredential } from "../dist/index.js";
import { AUDIT_LOG_PATH, DEBUG_LOG_PATH } from "../dist/logger.js";

// Start each recording from clean logs.
for (const p of [AUDIT_LOG_PATH, DEBUG_LOG_PATH]) {
  try { writeFileSync(p, ""); } catch { /* created on first write */ }
}

const rule = (c = "─") => console.log(c.repeat(66));
function banner(title) {
  console.log("");
  rule("═");
  console.log("  " + title);
  rule("═");
}
const step = (m) => console.log("\n• " + m);
const show = (label, obj) => console.log("    " + label + " " + JSON.stringify(obj));

banner("STEP 4 — LOCKING IT DOWN   (StoreLink per-store API keys)");
console.log("Keys load from the environment as STORE_KEY_<STOREID> and are");
console.log("re-read on EVERY request — never cached — so Korral's weekly");
console.log("rotation needs no restart.");

// ---------------------------------------------------------------------------
banner("(a) KEY ROTATES WHILE A REQUEST IS IN FLIGHT");

step("Korral IT provisions this week's key for store 47");
process.env.STORE_KEY_47 = "sk_week01_AAAAAAAAAAAA";

step("Agent request #1 arrives → server validates against the current key");
show("→", validateStoreCredential("47"));

step("MID-FLIGHT: Korral IT rotates store 47's weekly key (secret updated)");
process.env.STORE_KEY_47 = "sk_week02_BBBBBBBBBBBB";

step("Agent request #2 lands during the rotation → server re-reads the env");
const rotated = validateStoreCredential("47");
show("→", rotated);
console.log(
  rotated.ok && rotated.rotated
    ? "    ✔ Rotation detected and adopted. No stale key, no restart, no error."
    : "    ✗ unexpected",
);

step("Request #3 → steady state on the new key (rotated:false again)");
show("→", validateStoreCredential("47"));

// ---------------------------------------------------------------------------
banner("(b) AGENT ASKS FOR A STORE WE HAVE NO CREDENTIAL FOR");

step("Agent requests store 999 — Korral never provisioned a key for it");
const denied = validateStoreCredential("999");
show("→", denied);
console.log("\n    What the agent receives back from the tool:");
console.log("    ┌────────────────────────────────────────────────────────────┐");
console.log("    │ Access denied. " + denied.reason);
console.log("    └────────────────────────────────────────────────────────────┘");
console.log("    ✔ Failed safely (server keeps running) and informatively");
console.log("      (names the exact env var IT must set).");

step("Edge case: a blank/whitespace key is treated as missing, not valid");
process.env.STORE_KEY_102 = "   ";
show("→", validateStoreCredential("102"));

// ---------------------------------------------------------------------------
banner("AUDIT TRAIL   (written in-environment — secrets never logged)");
console.log("buyer_audit.log (plain English):");
process.stdout.write(tail(AUDIT_LOG_PATH, 4));
console.log("\nfde_debug.log (credential events, structured):");
process.stdout.write(grep(DEBUG_LOG_PATH, "credential"));

console.log("\nProof: the raw keys (sk_week01.., sk_week02..) appear NOWHERE above —");
console.log("only short SHA-256 fingerprints. Verify with:");
console.log("    grep sk_week buyer_audit.log fde_debug.log    # → no matches");

function tail(path, n) {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.slice(-n).map((l) => "  " + l).join("\n") + "\n";
  } catch {
    return "  (none)\n";
  }
}
function grep(path, term) {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter((l) => l.includes(term));
    return (lines.length ? lines.map((l) => "  " + l).join("\n") : "  (none)") + "\n";
  } catch {
    return "  (none)\n";
  }
}
