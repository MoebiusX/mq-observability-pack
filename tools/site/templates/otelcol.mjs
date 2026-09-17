// tools/site/templates/otelcol.mjs — otelcol/config.yaml (the environment's gateway collector)
//
// The lab file (stack/otelcol/config.yaml) with holes for the scrape step and timeout, the scrape
// targets (the lab keeps static_configs, one entry per queue manager, with the labels of design
// §7.1; a fleet environment reads prometheus/file_sd/*.json), the resource attributes
// (deployment.environment is the environment literal; mq.qmgr.name only when the environment
// has exactly one queue manager), the export endpoints and the remote-write external labels
// (service, environment). The docker filelog chain is rendered only when the environment's
// log_source is docker (the lab); host agents ship AMQERR01.json elsewhere (increment 2).
// String.raw: the filelog operators carry backslash escapes.
//
// Asserted lab deviations (tools/test-site.mjs T10): the static entries gain
// environment/site/shape labels, the two ${env:MQ_QMGR_NAME} become QM1, ${env:ENV} becomes
// lab, external_labels gains environment: lab.

import { flow, targetLabels, nativeTarget, exporterTarget, hostPort, isHttps } from './lib.mjs';

function staticEntries(ctx, source, target) {
  return ctx.qmgrs.map(qm => {
    const labels = targetLabels(ctx, qm, source);
    if (source === 'exporter' && ctx.lab) delete labels.qmgr;   // the lab exporter job has no target qmgr label: its series carry their own
    const rendered = { ...labels };
    if (rendered.qmgr) rendered.qmgr = `"${rendered.qmgr}"`;
    return `            - targets: [ "${target(qm)}" ]
              labels: ${flow(rendered)}`;
  }).join('\n');
}

function scrapeConfigs(ctx) {
  const t = ctx.timing;
  const cert = t.dur(Math.max(30, t.step));
  if (ctx.lab) {
    return String.raw`        - job_name: ibmmq-native            # qmgr process itself — survives listener faults
          honor_labels: true                # its series carry qmgr= already; without this they arrive as exported_qmgr
          static_configs:
${staticEntries(ctx, 'native', nativeTarget)}
        - job_name: ibmmq-exporter          # mq_prometheus as an MQ client — sees what apps see
          static_configs:
${staticEntries(ctx, 'exporter', exporterTarget)}
        - job_name: otel-collector
          static_configs:
            - targets: [ "127.0.0.1:8888" ]
        - job_name: certification            # harness results published to the alert-sink: MTTD/MTTR/verdict on the boards
          scrape_interval: ${cert}
          static_configs:
            - targets: [ "${hostPort(ctx.endpoints.alert_sink)}" ]
              labels: { environment: ${ctx.env} }`;
  }
  const native = ctx.vantage === 'dual' ? String.raw`        - job_name: ibmmq-native            # the MQ SERVICE local exporter on each queue manager — survives listener faults
          honor_labels: true                # its series carry qmgr= already; without this they arrive as exported_qmgr
          file_sd_configs:
            - files: [ /etc/otelcol/file_sd/ibmmq-native.json ]
              refresh_interval: 1m
` : '';
  return String.raw`${native}        - job_name: ibmmq-exporter          # mq_prometheus as an MQ client — sees what apps see
          honor_labels: true                # the target's qmgr label lands on up{} (the inventory join); the series keep their own
          file_sd_configs:
            - files: [ /etc/otelcol/file_sd/ibmmq-exporter.json ]
              refresh_interval: 1m
        - job_name: otel-collector
          static_configs:
            - targets: [ "127.0.0.1:8888" ]
        - job_name: certification            # harness results published to the alert-sink: MTTD/MTTR/verdict on the boards
          scrape_interval: ${cert}
          file_sd_configs:
            - files: [ /etc/otelcol/file_sd/certification.json ]
              refresh_interval: 1m`;
}

const FILELOG = String.raw`
  filelog:
    include: [ /var/lib/docker/containers/*/*-json.log ]
    # beginning, not end: the collector deliberately starts after the queue manager is healthy,
    # so with start_at=end every container's startup lines (strmqm, the MQSC autoconfig verdict,
    # the apps' first "connected") were never ingested on a fresh stack. file_storage remembers
    # offsets, so a collector restart does not re-read anything.
    start_at: beginning
    storage: file_storage
    include_file_path: true
    operators:
      # docker json-file driver envelope. With the compose logging options every line carries
      # attrs.{com.docker.compose.project, com.docker.compose.service}.
      - type: json_parser
        id: docker_envelope
        timestamp:
          parse_from: attributes.time
          layout: '%Y-%m-%dT%H:%M:%S.%LZ'
      # The include glob is host-wide (/var/lib/docker/containers is every container on the
      # daemon). Keep this project's lines only: anything else on the host stays out of the lab's
      # Loki, and lines without the labels (containers created before the logging options) too.
      - type: filter
        id: only_this_project
        expr: 'attributes.attrs == nil || attributes.attrs["com.docker.compose.project"] != "mq-obs"'
      - type: regex_parser
        id: container_id
        parse_from: attributes["log.file.path"]
        regex: '^/var/lib/docker/containers/(?P<container_id>[0-9a-f]+)/'
      - type: move
        from: attributes.log
        to: body
      - type: remove
        field: attributes.time
      # IBM MQ console JSON (MQ_LOGGING_CONSOLE_FORMAT=json): AMQ log records and web-server
      # records carry ibm_messageId, the auth-service and mqweb records ibm_datetime, the
      # container runtime's own lines type=mq_containerlog.
      - type: json_parser
        id: mq_json
        if: 'body matches "^\\{.*(\"ibm_messageId\"|\"ibm_datetime\"|\"type\":\"mq_containerlog\")"'
        parse_from: body
        parse_to: attributes.mq
        severity:
          parse_from: attributes.mq.loglevel
          mapping:
            info: INFO
            warn: WARNING
            error: ERROR
            fatal: FATAL
      # Application JSON logs from canary / producer / consumer
      # ({"ts","level","service","msg","trace_id","span_id",...} — canary/src/otel.mjs log()).
      - type: json_parser
        id: app_json
        if: 'body matches "^\\{.*\"service\":\"[^\"]+\".*\"msg\""'
        parse_from: body
        parse_to: attributes.app
      # Service identity goes on the ENTRY's resource here, in stanza. The adapter groups
      # entries into ResourceLogs by resource, so each container's lines form their own
      # stream. An OTTL set(resource.attributes[...]) in log context would instead mutate one
      # resource shared by every record in the batch and mislabel other containers' lines.
      - type: move
        id: app_service
        if: 'attributes.app != nil and attributes.app.service != nil'
        from: attributes.app.service
        to: resource["service.name"]
      - type: add
        id: mq_service
        if: 'attributes.mq != nil'
        field: resource["service.name"]
        value: ibmmq
      # Lines that are neither MQ JSON nor app JSON (the ibmmq module's own "[ibmmq] (E) …"
      # stderr lines during incidents, MQ auth-service lines, Grafana/Loki/Prometheus output)
      # are named after the container that wrote them, never lumped under a synthetic "docker".
      - type: add
        id: service_from_compose_mq
        if: 'resource["service.name"] == nil and attributes.attrs["com.docker.compose.service"] == "mq"'
        field: resource["service.name"]
        value: ibmmq
      - type: add
        id: service_from_compose_canary
        if: 'resource["service.name"] == nil and attributes.attrs["com.docker.compose.service"] == "canary"'
        field: resource["service.name"]
        value: mq-canary
      - type: add
        id: service_from_compose_producer
        if: 'resource["service.name"] == nil and attributes.attrs["com.docker.compose.service"] == "producer"'
        field: resource["service.name"]
        value: orders-producer
      - type: add
        id: service_from_compose_consumer
        if: 'resource["service.name"] == nil and attributes.attrs["com.docker.compose.service"] == "consumer"'
        field: resource["service.name"]
        value: orders-consumer
      - type: move
        id: service_from_compose
        if: 'resource["service.name"] == nil and attributes.attrs["com.docker.compose.service"] != nil'
        from: attributes.attrs["com.docker.compose.service"]
        to: resource["service.name"]
      - type: add
        id: default_service
        if: 'resource["service.name"] == nil'
        field: resource["service.name"]
        value: docker
      - type: remove
        id: drop_envelope_attrs
        if: 'attributes.attrs != nil'
        field: attributes.attrs
      - type: add
        id: service_namespace
        field: resource["service.namespace"]
        value: ibmmq
`;

export function render(ctx) {
  const t = ctx.timing, e = ctx.endpoints;
  const docker = ctx.p.log_source === 'docker';
  const one = ctx.qmgrs.length === 1;
  const tlsInsecure = (url) => (isHttps(url) ? 'false' : 'true');
  return String.raw`# OpenTelemetry Collector (contrib 0.161.x) — ${ctx.lab ? 'single collector for the MQ lab' : `gateway collector of the ${ctx.env} MQ site, GENERATED by gen-site`}.
#
#  metrics : prometheus receiver scrapes (a) the queue manager's native /metrics,
#            (b) mq_prometheus, (c) itself  → remote-write into Prometheus
#  logs    : ${docker ? `filelog tails docker json logs; MQ's JSON console log is parsed into
#            attributes (ibm_messageId, ibm_serverName, loglevel) → Loki via OTLP` : `OTLP from the per-host agents (AMQERR01.json, increment 2) → Loki via OTLP`}
#  traces  : OTLP from canary/producer/consumer → Tempo via OTLP gRPC
#  metrics : OTLP from the canary (round-trip histogram, attempt counters) → Prometheus

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  file_storage:
    directory: /var/lib/otelcol
    create_directory: true

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  prometheus:
    config:
      global:
        scrape_interval: ${t.dur(t.step)}
        scrape_timeout: ${t.dur(t.scrapeTimeout)}
      scrape_configs:
${scrapeConfigs(ctx)}
${docker ? FILELOG : ''}
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 400
    spike_limit_mib: 100

  batch:
    timeout: 2s
    send_batch_size: 512

  resource:
    attributes:
      - { key: deployment.environment, value: "${ctx.env}", action: upsert }
${one ? `      - { key: mq.qmgr.name,           value: "${ctx.qmgrs[0].name}", action: upsert }\n` : ''}
  # Record-level promotions only (service identity is set per entry in the filelog receiver):
  # W3C trace context onto app records, MQ fields onto qmgr records, body = MQ message text.
  transform/mqlogs:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(trace_id.string, attributes["app"]["trace_id"]) where attributes["app"]["trace_id"] != nil
          - set(span_id.string, attributes["app"]["span_id"]) where attributes["app"]["span_id"] != nil
          - set(severity_text, attributes["app"]["level"]) where attributes["app"]["level"] != nil
          - delete_key(attributes, "app")
          - set(attributes["mq.qmgr.name"], attributes["mq"]["ibm_serverName"]) where attributes["mq"]["ibm_serverName"] != nil
          - set(attributes["mq.message_id"], attributes["mq"]["ibm_messageId"]) where attributes["mq"]["ibm_messageId"] != nil
          - set(attributes["mq.process"], attributes["mq"]["ibm_processName"]) where attributes["mq"]["ibm_processName"] != nil
          - set(body, attributes["mq"]["message"]) where attributes["mq"]["message"] != nil
          - delete_key(attributes, "mq")

exporters:
  debug:
    verbosity: basic

  prometheusremotewrite:
    endpoint: ${e.remote_write}
    tls:
      insecure: ${tlsInsecure(e.remote_write)}
    resource_to_telemetry_conversion:
      enabled: false
    add_metric_suffixes: true
    # The pack's pipeline contract (spec.pipelines exporters.metrics.external_labels) promises
    # service="ibmmq" on every series the stack writes; without this only the generated
    # recording rules carried it.
    external_labels:
      service: ibmmq
      environment: ${ctx.env}

  otlphttp/loki:
    endpoint: ${e.loki}
    tls:
      insecure: ${tlsInsecure(e.loki)}

  otlp/tempo:
    endpoint: ${e.tempo}
    tls:
      insecure: ${tlsInsecure(e.tempo)}

service:
  extensions: [ health_check, file_storage ]
  telemetry:
    logs:
      level: info
    metrics:
      level: detailed
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 8888
  pipelines:
    metrics:
      receivers: [ prometheus, otlp ]
      processors: [ memory_limiter, resource, batch ]
      exporters: [ prometheusremotewrite ]
    logs:
      receivers: [ ${docker ? 'filelog, otlp' : 'otlp'} ]
      processors: [ memory_limiter, resource, transform/mqlogs, batch ]
      exporters: [ otlphttp/loki ]
    traces:
      receivers: [ otlp ]
      processors: [ memory_limiter, resource, batch ]
      exporters: [ otlp/tempo ]
`;
}
