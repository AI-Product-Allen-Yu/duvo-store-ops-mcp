# DEPLOYMENT.md — Shipping Store Ops MCP to Korral

**Constraints from Korral IT**

- StoreLink is **not reachable from the public internet**.
- **No customer data may leave Korral's GCP tenancy.**
- We will **ship updates frequently** after go-live.

**Runnable artifact:** the production image built from [`Dockerfile`](Dockerfile) — multi-stage,
non-root, runs the MCP server over stdio. That image is the unit of deployment.

```bash
# Build the artifact
docker build -t store-ops-mcp:1.0.0 .

# Run it — the agent attaches to its stdio; -i keeps stdin open
docker run --rm -i \
  -e STORE_KEY_47=… \
  -v store-ops-logs:/var/log/store-ops \
  store-ops-mcp:1.0.0
```

> Native (no Docker): `npm install && npm run build && npm start`. Because the transport is
> stdio, a bare `npm start` appears to "hang" — it's waiting for JSON-RPC on stdin; an MCP host
> drives it.

---

## Where it runs

Inside **Korral's own GCP project** (their tenancy), in their VPC — never exposed publicly.

- The server speaks MCP over **stdio** and is **colocated with the agent**: it ships as a
  container in the **same GKE Pod** the agent runs in (the agent spawns/attaches to its stdio).
  So there is **no inbound port, no load balancer, no public endpoint**.
- Runs on a **private GKE cluster** (private nodes, no public control-plane endpoint) in Korral's
  residency region. StoreLink is reached over **private VPC connectivity** (internal LB / Private
  Service Connect) — that traffic never leaves the VPC.
- **Egress denied by default** (Pod `NetworkPolicy` + a **VPC Service Controls** perimeter on the
  project). The server has **no runtime outbound dependencies**, so it runs unchanged under that
  lockdown — which is also the proof that no data can exit the tenancy.

> Alternative if Korral prefers serverless: the same image runs on **Cloud Run** with
> `ingress=internal` behind a Serverless VPC connector. Same residency story.

## How it gets there

1. **Duvo CI** builds the image from this repo (`npm ci` → `npm run build` → prune dev deps),
   runs tests + a vulnerability scan, and tags it `:<semver>-<gitSHA>` (**immutable**).
2. **Push to Korral's Artifact Registry** (regional, in-tenant) using a Duvo CI service account
   that Korral grants **push-only via Workload Identity Federation** — no long-lived JSON keys.
3. **Deploy** to the private GKE cluster via **GitOps (Config Sync)** or **Cloud Deploy**:
   staging namespace → smoke test → promote to prod. Korral owns the prod approval gate.

## How secrets are handled

- Per-store API keys live in **GCP Secret Manager** in Korral's project (source of truth);
  Korral IT rotates them weekly.
- They reach the container as `STORE_KEY_<STOREID>` env vars via **Workload Identity** (no key
  files on disk), synced by **External Secrets Operator** / the Secret Manager CSI driver.
- The app **re-reads keys on every request (never caches)** and **never logs raw keys** — only a
  SHA-256 fingerprint (see Step 4). A rotation propagated to a running container is therefore
  picked up immediately; if the mechanism swaps env at Pod scope, it's applied as a
  **zero-downtime rolling update**. The image itself contains **no secrets** (`.dockerignore`
  excludes `.env`).

## Observability

Every tool call writes to **two** append-only files — one per reader (see `src/logger.ts`):

| File | Audience | Format |
| --- | --- | --- |
| `buyer_audit.log` | Korral category buyer reading the trail the next morning | Plain-English, timestamped sentences — one per business decision (what the agent did, and why). |
| `fde_debug.log` | Forward Deployed Engineer debugging at 11pm | Structured JSONL — timestamp, `event`, store, tool inputs/outputs, and credential events. |

- Both files **append** (never truncated on start). Example traces live in [`samples/`](samples/).
- Log writes are **best-effort and error-swallowing by design** — a failed write can never crash a
  tool call or leak a byte onto stdout (stdout is protocol-only).
- **Secrets are never logged** — only SHA-256 fingerprints — so the trail is safe to retain.
- In GCP, route container stdout/stderr to **Cloud Logging in-tenant**, or ship the log volume to a
  **GCS bucket** in the residency region. Confirm the destination + retention with IT (checklist).

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STORE_KEY_<STOREID>` | yes (per store) | — | Per-store API key. Name = storeId upper-cased, non-alphanumerics → `_` (store `47` → `STORE_KEY_47`). Re-read every request; missing/blank fails safely. |
| `STORE_OPS_LOG_DIR` | no | `/var/log/store-ops` (image), CWD (native) | Directory for the two log files. |
| `NODE_ENV` | no | `production` (image) | Standard Node runtime flag. |

## Who owns the pipeline

- **Duvo owns:** source, Dockerfile, CI (build/test/scan), the image, and the release process
  (versioning, CHANGELOG, rollback runbook).
- **Korral owns:** the GCP project, VPC/firewall, GKE, Secret Manager, IAM, the Artifact Registry
  repo, and the **prod deploy approval**.
- **Boundary:** Korral grants Duvo a **least-privilege** service account (push to Artifact
  Registry; deploy to one namespace) via WIF, revocable anytime. The **GitOps repo of record
  lives in Korral's org**, so Korral always controls what actually runs in their tenancy.

## Shipping a fix at 11pm

1. Hotfix branch → CI builds a **new immutable image tag** → automated tests + scan.
2. Auto-deploy to **staging**, run the lockdown + task smoke tests (`npm run demo:lockdown`,
   `node scripts/task-scenario.mjs`).
3. Promote to prod through the pipeline, or a **Korral-approved break-glass** on-call deploy.

- **Rollback is the first move if unsure** and is instant: redeploy the previous image tag
  (`kubectl rollout undo` / Cloud Deploy rollback). Tags are immutable + versioned, so a rollback
  can't pull a surprise.
- **No state migration** — the server keeps no durable state beyond append-only logs, so both
  fix-forward and rollback are safe.
- **On-call:** confirm with IT whether after-hours deploys are **Duvo-driven** (via the granted
  deploy SA) or **Korral-run** from the runbook (see below).

## Verify the artifact

```bash
npm ci && npm run build                                     # compiles cleanly
docker build -t store-ops-mcp:1.0.0 .                       # image builds
docker run --rm --entrypoint sh store-ops-mcp:1.0.0 -c id   # runs non-root (uid=1000 node)
npm run demo:lockdown                                       # key rotation + fail-safe (Step 4)
node scripts/task-scenario.mjs                              # the real buyer task end-to-end (Step 2)
```

## Confirm with Korral IT before day 1

- [ ] GCP **project ID + residency region**; VPC/subnet; who provisions GKE (or Cloud Run).
- [ ] **Artifact Registry** repo path + the **WIF** bindings for Duvo's CI (push) and deploy
      (namespace-scoped) service accounts.
- [ ] **How the agent invokes the server** (same Pod? exact command?) — confirms the stdio model.
- [ ] **StoreLink** private endpoint + connectivity (PSC/internal LB), and the per-store key
      **provisioning + weekly rotation** mechanism (Secret Manager naming, who rotates, does it
      restart Pods).
- [ ] **Egress posture:** confirm deny-egress + **VPC Service Controls** perimeter on the project.
- [ ] **Logging:** destination (**Cloud Logging in-tenant** vs a GCS bucket), region, retention,
      and PII policy for `buyer_audit.log` / `fde_debug.log`.
- [ ] **Deploy ownership + 11pm break-glass:** who approves/executes prod after hours; escalation
      contacts.
- [ ] **Image policy:** Binary Authorization / required scan gates / signed attestations?
