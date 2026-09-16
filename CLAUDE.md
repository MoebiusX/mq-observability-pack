# CLAUDE.md — standing instructions for this repo

Read this before touching anything. STATUS.md is the cross-session handoff; update it
at the end of every session that changes state.

## What this repo is
A self-contained IBM MQ observability lab + certification harness. The contract is
`packs/ibmmq.pack.yaml` (ObservabilityPack spec v1.2, same shape as Observogram's
reference packs). `stack/` is its executable form; `harness/` proves it against a
real queue manager and writes `reports/cert-report.*`.

## Rules
1. **Pack and stack must not drift.** Any change to an SLI, recording rule, alert or
   dashboard binding is a change in BOTH `packs/ibmmq.pack.yaml` and the matching
   file under `stack/`. `node tools/check-rules.mjs` must stay green.
2. **Dashboards are generated.** Edit `tools/gen-dashboards.mjs`, run `npm run
   dashboards`; never hand-edit `stack/grafana/dashboards/*.json`.
3. **No new npm dependencies in `harness/`** (Node ≥ 20 built-ins only). `canary/`
   may depend on `ibmmq` and `@opentelemetry/*` only.
4. **Vendored code is read-only**: `vendor/observogram/` is refreshed by copying
   from Observogram, never edited.
5. **Pinned versions everywhere** (`docker-compose.yaml`, `.env.example`,
   `canary/package.json`). Bumps are their own commit with the validation output
   (`promtool check rules`, `otelcol-contrib validate`, `docker compose config`) in
   the message.
6. **Metric names are IBM's, not ours.** `ibmmq_*` names come from
   mq-metric-samples / the container's native endpoint; if a query needs a name
   that is not in `docs/catalogue-evidence/ibmmq.md`, add the evidence first.
7. **Lab timings are lab timings.** `for:` durations, `group_wait`, poll intervals
   are tuned for a 10 s scrape so chaos MTTD reflects the pipeline. Production
   values live in the pack's prod environment overrides, not here.
8. Surgical single-concern commits; halt and ask before anything irreversible
   (deleting volumes with data someone cares about, force-pushes, rewriting reports
   that were already shared).

## Validation before every push
```
npm test && node tools/check-rules.mjs && docker compose config --quiet
promtool check rules stack/prometheus/rules/*.yml
otelcol-contrib validate --config stack/otelcol/config.yaml
```

## Where things are
See README.md "Layout". Ports are all 127.0.0.1:2xxxx (never collide with
Observogram's 1xxxx validation stacks).
