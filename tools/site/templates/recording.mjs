// tools/site/templates/recording.mjs — prometheus/rules/ibmmq.recording.yml
//
// The lab file (stack/prometheus/rules/ibmmq.recording.yml) with holes for the group interval,
// the SLI window, the subquery step, the application-queue pattern and the DEADQ; vantage single
// drops the two process records (no native endpoint from that vantage). Design rule R1: the lab
// renders byte-identically (tools/test-site.mjs T10).

import { promqlString } from './lib.mjs';

export function render(ctx) {
  const t = ctx.timing, p = ctx.p;
  const w = t.dur(t.window3), iv = t.dur(t.interval), subq = t.dur(t.subq);
  const appq = `queue=~"${promqlString(p.app_queue_pattern)}"`;
  const deadq = promqlString(p.deadq);
  const process = ctx.vantage === 'single'
    ? `      # --- availability: reachability only (client exporter; no native endpoint from this vantage) ---
`
    : `      # --- availability: process (native endpoint) vs reachability (client exporter) ---
      - record: ibmmq:qmgr_process_up:ratio_5m
        expr: |
          sum(avg_over_time(up{job="ibmmq-native"}[5m]))
            / count(up{job="ibmmq-native"})
      - record: ibmmq:qmgr_process_up:error_ratio_5m
        expr: 1 - ibmmq:qmgr_process_up:ratio_5m

`;
  return `# Recording rules — one per SLI in packs/ibmmq.pack.yaml (spec.queries.recording_rules).
# Names follow <service>:<sli>:<agg>_<window>. The certification harness asserts every
# rule here is loaded by Prometheus AND currently yields at least one sample.
groups:
  - name: ibmmq.sli
    interval: ${iv}
    rules:
${process}      - record: ibmmq:qmgr_reachability:ratio_5m
        expr: |
          sum(avg_over_time((ibmmq_qmgr_status{job="ibmmq-exporter"} == bool 2)[5m:${subq}]))
            / count(ibmmq_qmgr_status{job="ibmmq-exporter"})
      - record: ibmmq:qmgr_reachability:error_ratio_5m
        expr: 1 - ibmmq:qmgr_reachability:ratio_5m

      # --- queue health ---
      # last_over_time(...[${w}]): mq_prometheus only exposes publication-derived gauges on
      # scrapes where a $SYS publication arrived (10 s publish vs 10 s scrape → ~1 in 12
      # scrapes has none, measured live). The window bridges that gap instead of letting a
      # staleness marker empty the SLI. Same expressions as packs/ibmmq.pack.yaml spec.slis.
      - record: ibmmq:queue_depth_headroom:ratio
        expr: |
          max by (qmgr, queue) (
            last_over_time(ibmmq_queue_depth{job="ibmmq-exporter", ${appq}}[${w}])
              / last_over_time(ibmmq_queue_attribute_max_depth{job="ibmmq-exporter", ${appq}}[${w}])
          )
      - record: ibmmq:oldest_message_age:seconds_max
        expr: |
          max by (qmgr, queue) (
            last_over_time(ibmmq_queue_oldest_message_age{job="ibmmq-exporter", ${appq}, queue!="${deadq}"}[${w}])
          )
      - record: ibmmq:dlq_depth:max
        expr: max by (qmgr) (last_over_time(ibmmq_queue_depth{job="ibmmq-exporter", queue="${deadq}"}[${w}]))

      # --- synthetic canary (OTel SDK → collector → remote-write) ---
      # \`or vector(0)\`: with 100 % failures there is no result="ok" series, so a bare sum()
      # is empty rather than 0 and every consumer of this ratio goes blind (seen live).
      - record: ibmmq:canary_success:ratio_5m
        expr: |
          (sum(rate(mq_canary_attempts_total{result="ok"}[5m])) or vector(0))
            / sum(rate(mq_canary_attempts_total[5m]))
      - record: ibmmq:canary_success:error_ratio_5m
        expr: 1 - ibmmq:canary_success:ratio_5m
      # result="ok": a failed probe (5 s get_timeout, a reconnect) is an availability failure
      # already counted by canary_success; letting it into the latency histogram double-counts
      # the same event as a latency breach.
      - record: ibmmq:canary_roundtrip:p99_5m
        expr: |
          histogram_quantile(0.99,
            sum by (le) (rate(mq_canary_roundtrip_duration_seconds_bucket{result="ok"}[5m])))

      # --- queue manager internals ---
      - record: ibmmq:log_write_latency:seconds
        expr: max by (qmgr) (last_over_time(ibmmq_qmgr_log_write_latency_seconds{job="ibmmq-exporter"}[${w}]))

  # Error-budget recording rules (ibmmq:errorbudget:burn_5m / burn_1h per SLO and
  # ibmmq:<sli>:error_ratio_5m for threshold SLIs) are GENERATED into ibmmq.burn.yml by
  # tools/gen-burn-rules.mjs from spec.policy, together with the burn-rate alerts.
`;
}
