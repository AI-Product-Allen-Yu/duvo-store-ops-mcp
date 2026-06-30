# Sample traces

Example output from a real run, so you can see the observability design without
building and running. The **live** logs (`buyer_audit.log`, `fde_debug.log`) are
gitignored — they're generated artifacts and, in production, contain business data
that must stay inside Korral's tenancy.

- [`buyer_audit.sample.log`](buyer_audit.sample.log) — plain English, one line per
  business event. For the Korral category buyer reviewing what the agent did.
- [`fde_debug.sample.log`](fde_debug.sample.log) — structured JSONL, one event per
  line. For the FDE debugging at 11pm.

Both samples cover one session: an inventory review, the SKU 8847291 replenishment
task across stores 47/102, a multi-supplier order, and credential load / rotation /
missing-key events. Regenerate with `npm run build` then the scripts in `../scripts/`.
