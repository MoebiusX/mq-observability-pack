// tools/site/templates/prometheus.mjs — prometheus/prometheus.yml
//
// The lab file (stack/prometheus/prometheus.yml) with the scrape and evaluation intervals at the
// environment's step, the Alertmanager target from the environment's endpoints and, on every
// environment, `external_labels.environment` (design §7.1): Prometheus attaches its external
// labels to the alerts it sends, so the per-environment Alertmanager routes match even for
// sum()-based rules that dropped every series label. The lab keeps its `lab: mq-obs` label; the
// asserted lab deviation is the one added line (tools/test-site.mjs T10).

import { hostPort, isHttps } from './lib.mjs';

export function render(ctx) {
  const t = ctx.timing, step = t.dur(t.step);
  const am = ctx.endpoints.alertmanager;
  return `# Prometheus for the MQ ${ctx.lab ? 'lab' : `${ctx.env} site`}. All application metrics arrive via remote-write
# from the OTel Collector; Prometheus only scrapes itself and Alertmanager.
global:
  scrape_interval: ${step}
  evaluation_interval: ${step}
  external_labels:
${ctx.lab ? '    lab: mq-obs\n' : ''}    environment: ${ctx.env}

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: [ "${hostPort(am)}" ]${isHttps(am) ? '\n      scheme: https' : ''}

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: [ "127.0.0.1:9090" ]
  - job_name: alertmanager
    static_configs:
      - targets: [ "${hostPort(am)}" ]${isHttps(am) ? '\n    scheme: https' : ''}
`;
}
