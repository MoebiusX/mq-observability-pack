# vendor/observogram

Lifted verbatim from `MoebiusX/Observogram` (MIT) so this repo validates its pack
without a dependency on the Observogram checkout:

| file | source |
|---|---|
| `lib/validator.mjs` | `tools/lib/validator.mjs` |
| `lib/mini-yaml.mjs` | `tools/lib/mini-yaml.mjs` |
| `observability-pack.schema.json` | `vendor/observability-pack-spec/v1.3/observability-pack.schema.json` (upstream `MoebiusX/otel-observability-pack@98be4ae`, spec v1.3: `good_when` on threshold SLIs) |
| `lib/dashboards/lib.mjs` | `tools/lib/dashboards/lib.mjs` (the dashboard visual system, panel factories, flow layout and pack-derived blocks; `tools/gen-dashboards.mjs` and `tools/dashboards/ibmmq.mjs` build the four boards with it) |
| `lib/dashboards/generic.mjs` | `tools/lib/dashboards/generic.mjs` (boards for any pack from its `dashboards[]`; this repo uses its binding check) |
| `lib/good-when.mjs` | `tools/lib/good-when.mjs` (spec 1.3: a threshold SLI's direction — `goodWhen`, absent → below; `badComparator`, `boundText`; imported by `burn-rules.mjs` and `dashboards/lib.mjs`) |
| `lib/burn-rules.mjs` | `tools/lib/burn-rules.mjs` (spec.policy → burn-rate, forecast and error-budget rules; `tools/gen-burn-rules.mjs` wraps it with the lab step and runbooks) |
| `lib/site/inventory.schema.json` | `tools/lib/site/inventory.schema.json` (site inventory v1; the MQ module's `paramsSchema` is spliced in as `$defs/siteParams|hostParams|instanceParams`) |
| `lib/site/inventory.mjs` | `tools/lib/site/inventory.mjs` (gen-site core: load, merge, environment inheritance and validation of inventories) |
| `lib/site/timing.mjs` | `tools/lib/site/timing.mjs` (gen-site core: the per-environment timing model over the pack's closed override vocabulary) |
| `lib/site/derive.mjs` | `tools/lib/site/derive.mjs` (gen-site core: exact-count text anchors, `dropItem`, the generated-block splice of the site pack) |
| `lib/site/run.mjs` | `tools/lib/site/run.mjs` (gen-site core: orchestration and the module contract; `tools/gen-site.mjs` wraps it with the MQ module `tools/site/ibmmq.mjs`) |

`SOURCES.json` records, for every file, the upstream path, the commit it was copied from and its
content hash; `tools/check-pins.mjs` fails when a copy no longer matches that commit and warns
when Observogram's `develop` has moved past it. Refresh: copy the file from Observogram, then
`node vendor/observogram/gen-sources.mjs <local>=<commit>` to record the new commit and hash.
Do not edit the copies here.
