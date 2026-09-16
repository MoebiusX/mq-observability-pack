# STATUS

## 2026-09-16 — v0.1.0 scaffold (Claude, Cowork session)

**State:** repo scaffolded end-to-end; statically validated; NOT yet run against a
live queue manager (no Docker daemon in the authoring environment).

Validated in this session:
- `packs/ibmmq.pack.yaml` passes the vendored spec v1.2 validator
- `tools/check-rules.mjs` green (13 recording, 13 alert rules, 3 dashboards ↔ pack)
- `docker compose config` OK
- `promtool check rules` OK (28 rules), `promtool check config` OK
- `otelcol-contrib 0.161.0 validate` OK
- `loki 3.7.7 -verify-config` OK, `amtool check-config` OK
- canary: `npm install` OK (ibmmq 2.1.9 pulls the MQ redist client), runs, classifies
  connect failures, emits OTel spans/metrics (tested against a dead endpoint)

## Next (in order)
1. `docker compose up -d --build --wait` on nitro5 — first build compiles mq_prometheus
   from IBM source (Go toolchain download) and the canary image.
2. `node harness/run.mjs --skip-chaos` → fix whatever C1-C10 / S1-S5 says. Most likely
   surprises: (a) exact `ibmmq_*` names from mq_prometheus v6 (`overrideCType` may
   suffix counters), (b) `chkmqhealthy` availability in the 10.0 image healthcheck,
   (c) filelog path on Docker Desktop/WSL2 (`/var/lib/docker/containers` bind).
3. `npm run certify` → full chaos run → `reports/cert-report.html` is the investor
   artefact.
4. Then: 2-QM uniform cluster variant, Observogram JSON export of the pack, KrystalineX
   integration (orders bridge RabbitMQ ↔ MQ) as a separate repo/phase.

## Open decisions
- MQ 10.0 chosen as default (current GA since 2026-06); 9.4.5.1 LTS is one env var away.
- Passwords via compose secrets AND deprecated env vars, so both 9.4 and 10.0 images work.
