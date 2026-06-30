/**
 * Dual-logging for the Store Ops MCP server.
 *
 *   buyer_audit.log — plain, simple English. One readable line per business
 *                     event, aimed at a buyer/ops reader. No JSON, no jargon.
 *
 *   fde_debug.log   — structured JSONL (one JSON object per line). Full
 *                     technical detail aimed at a Forward Deployed Engineer
 *                     debugging the server. Machine-parseable.
 *
 * Both files are append-only. Log location defaults to the process working
 * directory and can be overridden with STORE_OPS_LOG_DIR. Writing to stdout is
 * deliberately avoided — stdout carries the MCP JSON-RPC stream.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const LOG_DIR = process.env.STORE_OPS_LOG_DIR ?? process.cwd();
export const AUDIT_LOG_PATH = resolve(LOG_DIR, "buyer_audit.log");
export const DEBUG_LOG_PATH = resolve(LOG_DIR, "fde_debug.log");

function timestamp(): string {
  return new Date().toISOString();
}

/** Plain-English, buyer-facing summary -> buyer_audit.log */
export function auditLog(summary: string): void {
  const line = `[${timestamp()}] ${summary}\n`;
  try {
    appendFileSync(AUDIT_LOG_PATH, line, "utf8");
  } catch (err) {
    console.error("Failed to write buyer_audit.log:", err);
  }
}

/** Structured technical record -> fde_debug.log (JSONL) */
export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ ts: timestamp(), event, ...data });
  try {
    appendFileSync(DEBUG_LOG_PATH, entry + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write fde_debug.log:", err);
  }
}
