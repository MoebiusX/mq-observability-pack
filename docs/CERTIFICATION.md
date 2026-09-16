# What "certified" means here

A run of `npm run certify` produces `reports/cert-report.{html,md,json}`. The verdict is:

* **PASS** — every conformance check, every synthetic check and every chaos experiment passed: the stack implements the pack, the canary is healthy, every expected alert fired within its target MTTD and resolved after recovery.
* **WARN** — everything fired and resolved, but at least one alert was late against its `expected_mttd`, or an informational check (collector counters, trace linkage, log coverage) could not be fully confirmed.
* **FAIL** — a component is down, an SLI/rule/alert/dashboard the pack declares is missing, the canary is unhealthy, or an expected alert never fired / never resolved.

The JSON contains every query result, every webhook event and every timestamp used to reach the verdict, so a third party can recompute it.

## Reading the chaos section
Bar = measured MTTD (webhook receipt − injection). Tick = pack target. A late alert is amber. "Resolved after recovery" is the time from the recovery action to the *resolved* webhook — the observability system's own MTTR contribution (it excludes the human/automation fix time).

## Reproducibility
Every image is pinned; the exporter is built from a tagged IBM source revision; the harness is dependency-free. Run twice on the same machine and the conformance/synthetic sections are deterministic; chaos MTTDs vary by ±10 s (scrape/poll/evaluation phase alignment).

## Scope boundaries (v0.1)
Single queue manager, no TLS, dev credentials, docker-level faults only. Not covered yet: Native HA / uniform cluster failover, channel-level chaos between queue managers, disk-latency injection for `log_write_latency`, JMS clients. Each is a pack `chaos_experiments` entry away and the harness `faults` map is the only code to extend.
