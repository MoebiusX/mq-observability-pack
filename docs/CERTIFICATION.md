# What "certified" means here

A run of `npm run certify` produces `reports/cert-report.{html,md,json}`. The verdict is:

* **PASS** — every conformance check, every synthetic check and every chaos experiment passed: the stack implements the pack, the canary is healthy, every expected alert fired within its target MTTD and resolved after recovery.
* **WARN** — everything fired and resolved, but at least one alert was late against its `expected_mttd`, or an informational check (collector counters, trace linkage, log coverage) could not be fully confirmed.
* **FAIL** — a component is down, an SLI/rule/alert/dashboard the pack declares is missing, the canary is unhealthy, an expected alert never fired / never resolved, the lab was not clean before the chaos suite (pre-flight), or a requested suite produced no checks at all (a mistyped `--only`/`--scenario` must not certify).
* **ERROR** (exit code 3) — the harness itself failed (bad flags, unreadable pack, crash). A partial report is written; there is no verdict.

The JSON holds what the verdict was computed from: every check's `evidence`, and per chaos experiment the injection and recovery instants (alert-sink clock), each expected alert's `firedAt` / `resolvedAt` / `fingerprint` / `startsAt`, the hypothesis SLI's worst value and every series before, during and after, and `events`: the alert-sink ledger from injection to the end of the experiment. MTTD and MTTR in the report can be recomputed from those fields. Prometheus query results themselves are not archived beyond the values shown.

## Reading the chaos section
Bar = measured MTTD (webhook receipt − injection). Tick = pack target. A late alert is amber. "Resolved after recovery" is the time from the recovery action to the *resolved* webhook — the observability system's own MTTR contribution (it excludes the human/automation fix time).

## Reproducibility
Every image is pinned; the exporter is built from a tagged IBM source revision; the harness is dependency-free. Run twice on the same machine and the conformance/synthetic sections are deterministic; chaos MTTDs vary by ±10 s (scrape/poll/evaluation phase alignment).

## Scope boundaries (v0.2)
Single queue manager, no TLS, dev credentials, docker-level faults only. Not covered yet: Native HA / uniform cluster failover, channel-level chaos between queue managers, disk-latency injection for `log_write_latency`, JMS clients. Each is a pack `chaos_experiments` entry away and the harness `faults` map is the only code to extend.
