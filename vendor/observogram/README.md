# vendor/observogram

Lifted verbatim from `MoebiusX/Observogram` (MIT) so this repo validates its pack
without a dependency on the Observogram checkout:

| file | source |
|---|---|
| `lib/validator.mjs` | `tools/lib/validator.mjs` |
| `lib/mini-yaml.mjs` | `tools/lib/mini-yaml.mjs` |
| `observability-pack.schema.json` | `vendor/observability-pack-spec/v1.2/observability-pack.schema.json` (upstream `MoebiusX/otel-observability-pack@d13532b`, spec v1.2) |
| `lib/dashboards/lib.mjs` | `tools/lib/dashboards/lib.mjs` (the dashboard visual system, panel factories, flow layout and pack-derived blocks; `tools/gen-dashboards.mjs` and `tools/dashboards/ibmmq.mjs` build the four boards with it) |
| `lib/dashboards/generic.mjs` | `tools/lib/dashboards/generic.mjs` (boards for any pack from its `dashboards[]`; this repo uses its binding check) |
| `lib/burn-rules.mjs` | `tools/lib/burn-rules.mjs` (spec.policy → burn-rate, forecast and error-budget rules; `tools/gen-burn-rules.mjs` wraps it with the lab step and runbooks) |

The three dashboard and burn-rule files come from Observogram branch `codex/pack-dashboards`
(PR #87 into `develop`, commit c42ced3, 2026-09-17). Refresh by copying the six files again; do not edit here.
