// tools/site/templates/prometheus.mjs — prometheus/prometheus.yml
//
// The lab file (stack/prometheus/prometheus.yml) with the scrape and evaluation intervals at the
// environment's step, the Alertmanager target from the environment's endpoints and, on every
// environment, `external_labels.environment` (design §7.1): Prometheus attaches its external
// labels to the alerts it sends, so the per-environment Alertmanager routes match even for
// sum()-based rules that dropped every series label. The lab keeps its `lab: mq-obs` label; the
// asserted lab deviation is the one added line (tools/test-site.mjs T10).

import { hostPort, isHttps } from './lib.mjs';

/** A static scrape job of one platform component (its own /metrics), https when the endpoint says so. */
const selfJob = (name, url) => `  - job_name: ${name}
    static_configs:
      - targets: [ "${hostPort(url)}" ]${isHttps(url) ? '\n    scheme: https' : ''}
`;

export function render(ctx) {
  const t = ctx.timing, step = t.dur(t.step);
  const am = ctx.endpoints.alertmanager, grafana = ctx.endpoints.grafana || null;
  // The platform's own metrics: Prometheus, Alertmanager and Grafana wherever the environment
  // names one; the lab also scrapes Loki and Tempo. These are what Observogram's reference packs
  // (grafana, prometheus) read, so the lab validates them live (tools/reference-packs.mjs).
  const platform = [
    selfJob('alertmanager', am),
    ...(grafana ? [selfJob('grafana', grafana)] : []),
    ...(ctx.lab ? [selfJob('loki', 'http://loki:3100'), selfJob('tempo', 'http://tempo:3200')] : []),
  ].join('');
  return `# Prometheus for the MQ ${ctx.lab ? 'lab' : `${ctx.env} site`}. All application metrics arrive via remote-write
# from the OTel Collector; Prometheus scrapes only itself and the platform's own components
# (Alertmanager${grafana ? ', Grafana' : ''}${ctx.lab ? ', Loki, Tempo' : ''}).
global:
  scrape_interval: ${step}
  evaluation_interval: ${step}
  external_labels:
${ctx.lab ? '    lab: mq-obs\n' : ''}    environment: ${ctx.env}

rule_files:
  - /etc/prometheus/rules/*.yml
${ctx.lab ? `  # Observogram reference packs (grafana, prometheus), materialised by tools/reference-packs.mjs
  # for live validation of their rules and boards against this lab; not part of the MQ pack.
  - /etc/prometheus/rules-reference/*.yml
` : ''}
alerting:
  alertmanagers:
    - static_configs:
        - targets: [ "${hostPort(am)}" ]${isHttps(am) ? '\n      scheme: https' : ''}

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: [ "127.0.0.1:9090" ]
${platform}`;
}
