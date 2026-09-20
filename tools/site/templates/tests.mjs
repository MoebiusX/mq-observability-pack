// tools/site/templates/tests.mjs — prometheus/tests/ibmmq.alerts.test.yml
//
// The lab's promtool unit tests (stack/prometheus/tests/ibmmq.alerts.test.yml) are written for a
// 10 s scrape and the lab `for:` literals: their series and eval times encode that timing, so
// the file is rendered only for environments with the lab timing (step 10, no
// alerts.symptom.for override); a production environment gets none (site.json lists the skip)
// rather than cases whose expectations would be scaled guesses. A single-vantage environment
// swaps the differential cases (M10, M9) for the degraded set of design §8: (i) Unreachable
// fires without a native gate, (ii) a short status blip does not, (iii) the pipeline alert on
// the exporter job, (iv) Silent from the inventory join, (v) Restarted from uptime.
// String.raw: the descriptions carry backslash escapes.

import { exporterTarget } from './lib.mjs';

export function render(ctx) {
  const t = ctx.timing;
  if (t.step !== 10 || t.symptomForOverride != null) return null;
  const single = ctx.vantage === 'single';
  const qm = ctx.qmgrs[0];
  const exp = single ? exporterTarget(qm) : 'mq-exporter:9157';
  const name = single ? qm.name : 'QM1';
  const forSingle = t.durM(Math.max(3 * t.step, t.secs(t.symptomFor('20s'))));

  const head = String.raw`# promtool unit tests for the symptom alerts whose behaviour was found wrong on the live lab
# (docs/reviews/2026-09-16-adversarial-review.md M8, M9, M10, M22). Run:
#   promtool test rules stack/prometheus/tests/ibmmq.alerts.test.yml
# 10 s scrape, like the lab. Series are written at that interval.
rule_files:
  - ../rules/ibmmq.alerts.yml
${single ? '  - ../rules/ibmmq.inventory.yml\n' : ''}
evaluation_interval: 10s

tests:
  # M8 — the exporter answers one scrape in five while the queue manager is down. Without
  # keep_firing_for the alert fired for one evaluation, resolved, and re-pended every ~50 s.
  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-exporter", instance="${exp}", qmgr="${name}"}'
        values: '0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1'
${single ? '' : `      - series: 'up{job="ibmmq-native", instance="mq:9157", qmgr="QM1"}'
        values: '1x20'
`}    alert_rule_test:
      - eval_time: 30s
        alertname: IBMMQExporterDown
        exp_alerts:
          - exp_labels: { severity: SEV2, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "${exp}", qmgr: ${name} }
            exp_annotations:
              summary: "mq_prometheus exporter is not being scraped"
              description: "Queue/channel-level telemetry is blind. Everything below this line is unobservable until it recovers."
      # the single up=1 scrape at 40 s must not resolve it
      - eval_time: 40s
        alertname: IBMMQExporterDown
        exp_alerts:
          - exp_labels: { severity: SEV2, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "${exp}", qmgr: ${name} }
            exp_annotations:
              summary: "mq_prometheus exporter is not being scraped"
              description: "Queue/channel-level telemetry is blind. Everything below this line is unobservable until it recovers."
      - eval_time: 140s
        alertname: IBMMQExporterDown
        exp_alerts:
          - exp_labels: { severity: SEV2, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "${exp}", qmgr: ${name} }
            exp_annotations:
              summary: "mq_prometheus exporter is not being scraped"
              description: "Queue/channel-level telemetry is blind. Everything below this line is unobservable until it recovers."
`;

  const dual = String.raw`
  # M10 — two queue managers: QM2's process dies. Down must fire for QM2 and Unreachable
  # must NOT (with ` + '`and on ()`' + String.raw` QM1's live native endpoint vouched for QM2).
  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-native", instance="mq:9157", qmgr="QM1"}'
        values: '1x30'
      - series: 'up{job="ibmmq-native", instance="mq2:9157", qmgr="QM2"}'
        values: '1x6 0x24'
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="mq-exporter:9157", qmgr="QM1"}'
        values: '2x30'
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="mq-exporter:9157", qmgr="QM2"}'
        values: '2x6 0x24'
    alert_rule_test:
      - eval_time: 3m
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts: []
      - eval_time: 3m
        alertname: IBMMQQueueManagerDown
        exp_alerts:
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: qmgr_process_up, job: ibmmq-native, instance: "mq2:9157", qmgr: QM2 }
            exp_annotations:
              summary: "Queue manager process is down (QM2)"
              description: "The queue manager's native metrics endpoint (:9157) is not answering. The container or qmgr process is gone."
              runbook: runbooks/qmgr-down.md

  # M10 — a real listener fault (process alive, client status 0) still fires within the
  # listener-stopped budget: status drops at 60 s, alert firing by 100 s.
  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-native", instance="mq:9157", qmgr="QM1"}'
        values: '1x30'
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="mq-exporter:9157", qmgr="QM1"}'
        values: '2x6 0x24'
    alert_rule_test:
      - eval_time: 100s
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts:
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "mq-exporter:9157", qmgr: QM1 }
            exp_annotations:
              summary: "Queue manager QM1 is running but not reachable by clients"
              description: "Native metrics answer but the client-side exporter cannot connect (status=0). Listener, SVRCONN channel, CHLAUTH or CONNAUTH fault."
              runbook: runbooks/qmgr-unreachable.md

  # M10 — after a queue-manager restart the native endpoint is back 20 s before the exporter
  # has reconnected (status still 0). That window must not page "listener fault".
  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-native", instance="mq:9157", qmgr="QM1"}'
        values: '1x6 0x6 1x18'
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="mq-exporter:9157", qmgr="QM1"}'
        values: '2x6 0x9 2x15'
    alert_rule_test:
      - eval_time: 150s
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts: []
      - eval_time: 3m
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts: []

  # M9 — no MQ telemetry at all (collector dead): the pipeline alert fires; the differential
  # alerts cannot (their selectors are empty), which is exactly why it exists.
  - interval: 10s
    input_series: []
    alert_rule_test:
      - eval_time: 2m
        alertname: IBMMQTelemetryPipelineDown
        exp_alerts:
          # absent_over_time() carries the equality matchers of its selector as labels
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: qmgr_process_up, job: ibmmq-native }
            exp_annotations:
              summary: "No MQ telemetry has reached Prometheus for over a minute"
              description: "up{job=\"ibmmq-native\"} has no samples: the OTel Collector (or its scrape of the queue manager) is down. Every MQ alert is blind until it recovers."
              runbook: runbooks/telemetry-pipeline.md
      - eval_time: 2m
        alertname: IBMMQQueueManagerDown
        exp_alerts: []

  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-native", instance="mq:9157", qmgr="QM1"}'
        values: '1x20'
    alert_rule_test:
      - eval_time: 2m
        alertname: IBMMQTelemetryPipelineDown
        exp_alerts: []
`;

  const site = ctx.siteOf(qm) ?? qm.site ?? 'unknown';
  const degraded = String.raw`
  # (i) single vantage — a client that cannot connect is the whole signal: status drops at 60 s,
  # IBMMQQueueManagerUnreachable (for: ${forSingle}, no native gate) is firing by 100 s.
  - interval: 10s
    input_series:
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="${exp}", qmgr="${name}"}'
        values: '2x6 0x24'
    alert_rule_test:
      - eval_time: 100s
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts:
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "${exp}", qmgr: ${name} }
            exp_annotations:
              summary: "Queue manager ${name} is not reachable by clients (process state unknown from this vantage)"
              description: "The client-side exporter cannot connect (status=0): listener, SVRCONN channel, CHLAUTH or CONNAUTH fault, or the queue manager itself is down."
              runbook: runbooks/qmgr-unreachable.md

  # (ii) a status blip shorter than for: (three 0 samples, 20 s active: the exporter's reconnect
  # after a restart) does not page.
  - interval: 10s
    input_series:
      - series: 'ibmmq_qmgr_status{job="ibmmq-exporter", instance="${exp}", qmgr="${name}"}'
        values: '2x6 0x2 2x22'
    alert_rule_test:
      - eval_time: 100s
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts: []
      - eval_time: 3m
        alertname: IBMMQQueueManagerUnreachable
        exp_alerts: []

  # (iii) no MQ telemetry at all (collector dead): the pipeline alert on the exporter job fires.
  - interval: 10s
    input_series: []
    alert_rule_test:
      - eval_time: 2m
        alertname: IBMMQTelemetryPipelineDown
        exp_alerts:
          # absent_over_time() carries the equality matchers of its selector as labels
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter }
            exp_annotations:
              summary: "No MQ telemetry has reached Prometheus for over a minute"
              description: "up{job=\"ibmmq-exporter\"} has no samples: the OTel Collector (or its scrape of the exporter) is down. Every MQ alert is blind until it recovers."
              runbook: runbooks/telemetry-pipeline.md

  - interval: 10s
    input_series:
      - series: 'up{job="ibmmq-exporter", instance="${exp}", qmgr="${name}"}'
        values: '1x20'
    alert_rule_test:
      - eval_time: 2m
        alertname: IBMMQTelemetryPipelineDown
        exp_alerts: []

  # (iv) the inventory says ${name} exists; no exporter series joins it for 2 minutes → Silent.
  # With the exporter's up{} present (its target carries the qmgr label) nothing fires.
  - interval: 10s
    input_series: []
    alert_rule_test:
      - eval_time: 2m10s
        alertname: IBMMQQueueManagerSilent
        exp_alerts:
${ctx.qmgrs.map(q => String.raw`          - exp_labels: { severity: SEV2, pack: ibmmq, sli: qmgr_reachability, qmgr: ${q.name}, environment: ${ctx.env}, site: ${ctx.siteOf(q) ?? q.site ?? 'unknown'}, shape: ${q.shape}, vantage: single }
            exp_annotations:
              summary: "Queue manager ${q.name} is in the ${ctx.env} inventory but nothing reports it"
              description: "No exporter series for ${q.name} (${ctx.siteOf(q) ?? q.site ?? 'unknown'}, ${q.shape}) for 2 minutes: its client exporter is down or unscraped, or the inventory is stale."
              runbook: runbooks/qmgr-silent.md
`).join('')}
  - interval: 10s
    input_series:
${ctx.qmgrs.map(q => String.raw`      - series: 'up{job="ibmmq-exporter", instance="${exporterTarget(q)}", qmgr="${q.name}"}'
        values: '1x20'
`).join('')}    alert_rule_test:
      - eval_time: 2m10s
        alertname: IBMMQQueueManagerSilent
        exp_alerts: []

  # (v) uptime below four scrapes marks a (re)start; once past it the alert is gone.
  - interval: 10s
    input_series:
      - series: 'ibmmq_qmgr_uptime{job="ibmmq-exporter", instance="${exp}", qmgr="${name}"}'
        values: '10 20 30 40 50 60'
    alert_rule_test:
      - eval_time: 10s
        alertname: IBMMQQueueManagerRestarted
        exp_alerts:
          - exp_labels: { severity: SEV2, pack: ibmmq, sli: qmgr_reachability, job: ibmmq-exporter, instance: "${exp}", qmgr: ${name} }
            exp_annotations:
              summary: "Queue manager ${name} started less than ${4 * t.step} s ago"
              description: "Uptime 20s: the queue manager (re)started. Preceded by IBMMQQueueManagerUnreachable, the outage was the queue manager itself, not the listener."
              runbook: runbooks/qmgr-restarted.md
      - eval_time: 50s
        alertname: IBMMQQueueManagerRestarted
        exp_alerts: []
`;

  const canary = String.raw`
  # M22 — a canary hung inside an MQI call keeps exporting a FLAT counter: no ok increment,
  # no attempt increment, series present. The third branch must fire; a healthy canary
  # (counter increasing) must not.
  - interval: 10s
    input_series:
      - series: 'mq_canary_attempts_total{result="ok", job="mq-canary"}'
        values: '100x30'
    alert_rule_test:
      - eval_time: 3m
        alertname: MQCanaryFailing
        exp_alerts:
          - exp_labels: { severity: SEV1, pack: ibmmq, sli: canary_success }
            exp_annotations:
              summary: "Synthetic put/get canary is failing"
              description: "No canary round-trip has succeeded in the last ${t.canaryShort} s although probes continue, the canary is silent, or no probe has completed at all in ${t.canaryHung / 60} min (hung inside an MQI call)."
              runbook: runbooks/canary.md

  - interval: 10s
    input_series:
      - series: 'mq_canary_attempts_total{result="ok", job="mq-canary"}'
        values: '100+1x30'
    alert_rule_test:
      - eval_time: 3m
        alertname: MQCanaryFailing
        exp_alerts: []
`;
  void site;
  return head + (single ? degraded : dual) + canary;
}
