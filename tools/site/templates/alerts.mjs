// tools/site/templates/alerts.mjs — prometheus/rules/ibmmq.alerts.yml
//
// The lab file (stack/prometheus/rules/ibmmq.alerts.yml) with holes for the group interval, the
// `for:` durations (timing.symptomFor: the lab literal, or the environment's alerts.symptom.for
// when larger), the native gate, keep_firing_for, the canary windows and the SLI window; vantage
// single renders the degraded differential block (design §8): no IBMMQQueueManagerDown, the
// Unreachable alert without the native gate, the pipeline alert on the exporter job, the
// filesystem alert on the reachability SLI, and IBMMQQueueManagerRestarted (uptime below four
// scrapes: the only retrospective process/listener discriminator a client has).
// String.raw: the file carries backslash escapes inside double-quoted YAML strings.

import { ruleLabels, humanSeconds } from './lib.mjs';

export function render(ctx) {
  const t = ctx.timing, single = ctx.vantage === 'single';
  // durM: whole minutes spelled as minutes (the lab literals are 1m / 1m / 40s / 2m; a 30 s step gives 3m / 3m / 2m / 6m)
  const iv = t.dur(t.interval), gate = t.durM(t.gate), keep = t.durM(t.keepFiring), short = t.durM(t.canaryShort), hung = t.durM(t.canaryHung), w = t.dur(t.window3);
  const f = (lit) => t.symptomFor(lit);
  const L = (sev, sli) => ruleLabels(ctx, sev, sli);
  const fsSli = single ? 'qmgr_reachability' : 'qmgr_process_up';

  const differential = single ? String.raw`
      # ---- reachability (client vantage only) --------------------------------------
      # No native endpoint from this vantage: a client that cannot connect is all we know, so a
      # stopped queue manager and a listener fault look the same here (IBMMQQueueManagerRestarted
      # below tells them apart after the fact). for: max(3 scrapes, alerts.symptom.for).
      - alert: IBMMQQueueManagerUnreachable
        expr: ibmmq_qmgr_status{job="ibmmq-exporter"} != 2
        for: ${t.durM(Math.max(3 * t.step, t.secs(f('20s'))))}
        labels: ${L('SEV1', 'qmgr_reachability')}
        annotations:
          summary: "Queue manager {{ $labels.qmgr }} is not reachable by clients (process state unknown from this vantage)"
          description: "The client-side exporter cannot connect (status={{ $value }}): listener, SVRCONN channel, CHLAUTH or CONNAUTH fault, or the queue manager itself is down."
          runbook: runbooks/qmgr-unreachable.md

      # keep_firing_for: during a queue-manager outage mq_prometheus (keepRunning) answers about
      # one scrape in five while it retries, so up{} toggles and this alert fired → resolved →
      # re-pended every ~50 s (6 false "resolved" webhooks over 3 qmgr-down runs, measured).
      - alert: IBMMQExporterDown
        expr: up{job="ibmmq-exporter"} == 0
        for: ${f('30s')}
        keep_firing_for: ${keep}
        labels: ${L('SEV2', 'qmgr_reachability')}
        annotations:
          summary: "mq_prometheus exporter is not being scraped"
          description: "Queue/channel-level telemetry is blind. Everything below this line is unobservable until it recovers."

      # Every selector above rests on up{} series that only exist while the OTel Collector
      # remote-writes them. If the collector dies, every selector is EMPTY, not 0, and nothing
      # fires; the first symptom would be MQCanaryFailing's absent() minutes later, blaming the
      # canary. This names the real fault (the exporter job: the only MQ scrape of this vantage).
      - alert: IBMMQTelemetryPipelineDown
        expr: absent_over_time(up{job="ibmmq-exporter"}[${gate}])
        for: ${f('30s')}
        labels: ${L('SEV1', 'qmgr_reachability')}
        annotations:
          summary: "No MQ telemetry has reached Prometheus for over ${humanSeconds(t.gate)}"
          description: "up{job=\"ibmmq-exporter\"} has no samples: the OTel Collector (or its scrape of the exporter) is down. Every MQ alert is blind until it recovers."
          runbook: runbooks/telemetry-pipeline.md

      # After an outage the queue manager's uptime restarts from zero: below four scrapes it was
      # started just now, which is what separates "the queue manager restarted" from "the
      # listener was down" once IBMMQQueueManagerUnreachable resolves.
      - alert: IBMMQQueueManagerRestarted
        expr: ibmmq_qmgr_uptime{job="ibmmq-exporter"} < ${4 * t.step}
        labels: ${L('SEV2', 'qmgr_reachability')}
        annotations:
          summary: "Queue manager {{ $labels.qmgr }} started less than ${4 * t.step} s ago"
          description: "Uptime {{ $value }}s: the queue manager (re)started. Preceded by IBMMQQueueManagerUnreachable, the outage was the queue manager itself, not the listener."
          runbook: runbooks/qmgr-restarted.md
` : String.raw`
      # ---- differential diagnosis: process vs reachability --------------------
      - alert: IBMMQQueueManagerDown
        expr: up{job="ibmmq-native"} == 0
        for: ${f('20s')}
        labels: ${L('SEV1', 'qmgr_process_up')}
        annotations:
          summary: "Queue manager process is down ({{ $labels.qmgr }})"
          description: "The queue manager's native metrics endpoint (:9157) is not answering. The container or qmgr process is gone."
          runbook: runbooks/qmgr-down.md

      # on (qmgr): both sides carry the qmgr label; ` + '`on ()`' + String.raw` would let QM1's native endpoint
      # vouch for a dead QM2. min_over_time(...[${gate}]) == 1: the native endpoint must have been
      # up for a full minute, so the 10-20 s the exporter needs to reconnect after a qmgr
      # restart (status 0 while native is already 1) does not page "listener fault".
      - alert: IBMMQQueueManagerUnreachable
        expr: |
          (ibmmq_qmgr_status{job="ibmmq-exporter"} != 2)
            and on (qmgr) (min_over_time(up{job="ibmmq-native"}[${gate}]) == 1)
        for: ${f('20s')}
        labels: ${L('SEV1', 'qmgr_reachability')}
        annotations:
          summary: "Queue manager {{ $labels.qmgr }} is running but not reachable by clients"
          description: "Native metrics answer but the client-side exporter cannot connect (status={{ $value }}). Listener, SVRCONN channel, CHLAUTH or CONNAUTH fault."
          runbook: runbooks/qmgr-unreachable.md

      # keep_firing_for: during a queue-manager outage mq_prometheus (keepRunning) answers about
      # one scrape in five while it retries, so up{} toggles and this alert fired → resolved →
      # re-pended every ~50 s (6 false "resolved" webhooks over 3 qmgr-down runs, measured).
      - alert: IBMMQExporterDown
        expr: up{job="ibmmq-exporter"} == 0
        for: ${f('30s')}
        keep_firing_for: ${keep}
        labels: ${L('SEV2', 'qmgr_reachability')}
        annotations:
          summary: "mq_prometheus exporter is not being scraped"
          description: "Queue/channel-level telemetry is blind. Everything below this line is unobservable until it recovers."

      # The whole differential diagnosis rests on up{} series that only exist while the OTel
      # Collector remote-writes them. If the collector dies, every selector above is EMPTY, not
      # 0, and nothing fires; the first symptom would be MQCanaryFailing's absent() five minutes
      # later, blaming the canary. This names the real fault.
      - alert: IBMMQTelemetryPipelineDown
        expr: absent_over_time(up{job="ibmmq-native"}[${gate}])
        for: ${f('30s')}
        labels: ${L('SEV1', 'qmgr_process_up')}
        annotations:
          summary: "No MQ telemetry has reached Prometheus for over ${humanSeconds(t.gate)}"
          description: "up{job=\"ibmmq-native\"} has no samples: the OTel Collector (or its scrape of the queue manager) is down. Every MQ alert is blind until it recovers."
          runbook: runbooks/telemetry-pipeline.md
`;

  return String.raw`# Alert rules for the IBM MQ pack. Every alert carries:
#   severity  SEV1..SEV3 (pack vocabulary, routed by Alertmanager)
#   pack      ibmmq
#   sli       the SLI id it protects (packs/ibmmq.pack.yaml)
# ` + '`for`' + String.raw` durations are lab-tuned (10s scrape, 10s exporter poll) so that MTTD is
# dominated by the pipeline, not by alert damping. Production packs raise these.
groups:
  - name: ibmmq.symptoms
    interval: ${iv}
    rules:
${differential}
      # ---- queues ---------------------------------------------------------------
      - alert: IBMMQQueueDepthHigh
        expr: ibmmq:queue_depth_headroom:ratio > 0.8
        for: ${f('20s')}
        labels: ${L('SEV2', 'queue_depth_headroom')}
        annotations:
          summary: "{{ $labels.queue }} on {{ $labels.qmgr }} at {{ $value | humanizePercentage }} of MAXDEPTH"
          runbook: runbooks/queue-depth.md

      - alert: IBMMQQueueFull
        expr: ibmmq:queue_depth_headroom:ratio >= 1
        for: ${f('10s')}
        labels: ${L('SEV1', 'queue_depth_headroom')}
        annotations:
          summary: "{{ $labels.queue }} on {{ $labels.qmgr }} is FULL — producers get MQRC_Q_FULL (2053)"
          runbook: runbooks/queue-depth.md

      - alert: IBMMQOldestMessageAgeHigh
        expr: ibmmq:oldest_message_age:seconds_max > 60
        for: ${f('20s')}
        labels: ${L('SEV2', 'oldest_message_age')}
        annotations:
          summary: "Oldest message on {{ $labels.queue }} is {{ $value }}s old — consumer stalled or too slow"
          runbook: runbooks/consumer-stalled.md

      - alert: IBMMQDeadLetterQueueNotEmpty
        expr: ibmmq:dlq_depth:max > 0
        for: ${f('20s')}
        labels: ${L('SEV2', 'dlq_depth')}
        annotations:
          summary: "{{ $value }} message(s) on the dead-letter queue of {{ $labels.qmgr }}"
          runbook: runbooks/dlq.md

      # ---- synthetic canary -----------------------------------------------------
      # "No successful probe for 40 s (4 probes at 10 s) while probes continue, or the canary
      # is silent." Formulated on increase() of the ok counter being exactly 0 rather than on
      # a success ratio: under Prometheus rule evaluation the rate()-based ratio only became
      # true ~69 s after the fault and fired at 105-109 s (measured live, ALERTS_FOR_STATE),
      # whereas a flat counter is unambiguous the moment the window has no ok increment.
      # Detection ≈ 40 s + ingest lag (~4 s) + ` + '`for`' + String.raw` 10 s + eval + group_wait ≈ 60-70 s.
      # ` + '`or vector(0)`' + String.raw` covers the case where no result="ok" series exists at all. Experiments
      # that expect this alert budget 90 s (pack expected_mttd).
      # Third branch: a canary blocked inside MQCONN/MQPUT keeps exporting a FLAT counter every
      # 5 s, so neither "ok == 0 while attempts > 0" nor absent() is true; "no attempt of any
      # kind completed in 2 min" catches the hung probe (a fresh single-sample series yields an
      # empty increase(), so a restart cannot false-fire it).
      - alert: MQCanaryFailing
        expr: |
          (
            (sum(increase(mq_canary_attempts_total{result="ok"}[${short}])) or vector(0)) == 0
              and sum(increase(mq_canary_attempts_total[${short}])) > 0
          )
            or absent(mq_canary_attempts_total)
            or (sum(increase(mq_canary_attempts_total[${hung}])) == 0)
        for: ${f('10s')}
        labels: ${L('SEV1', 'canary_success')}
        annotations:
          summary: "Synthetic put/get canary is failing"
          description: "No canary round-trip has succeeded in the last ${t.canaryShort} s although probes continue, the canary is silent, or no probe has completed at all in ${t.canaryHung / 60} min (hung inside an MQI call)."
          runbook: runbooks/canary.md

      - alert: MQCanaryLatencyHigh
        expr: ibmmq:canary_roundtrip:p99_5m > 0.5
        for: ${f('1m')}
        labels: ${L('SEV3', 'canary_roundtrip_p99')}
        annotations:
          summary: "Canary p99 round-trip is {{ $value }}s (> 500ms)"

      # ---- queue manager internals ---------------------------------------------
      - alert: IBMMQLogWriteLatencyHigh
        expr: ibmmq:log_write_latency:seconds > 0.02
        for: ${f('1m')}
        labels: ${L('SEV3', 'log_write_latency')}
        annotations:
          summary: "Recovery-log write latency {{ $value }}s on {{ $labels.qmgr }} — persistent-message throughput at risk"

      - alert: IBMMQFileSystemLow
        expr: min by (qmgr) (last_over_time(ibmmq_qmgr_queue_manager_file_system_free_space_percentage{job="ibmmq-exporter"}[${w}])) < 15
        for: ${f('1m')}
        labels: ${L('SEV2', fsSli)}
        annotations:
          summary: "Queue manager filesystem below 15% free on {{ $labels.qmgr }}"

  # Burn-rate and forecast alerts (spec.policy) live in ibmmq.burn.yml, GENERATED from the
  # pack by tools/gen-burn-rules.mjs — one alert per declared window, for every SLO.
`;
}
