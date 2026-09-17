// tools/site/templates/file-sd.mjs — prometheus/file_sd/{ibmmq-native,ibmmq-exporter,certification}.json
//
// Prometheus file-based service discovery for the collector's scrape jobs (otelcol.mjs mounts
// the directory at /etc/otelcol/file_sd): one target per queue manager with the labels of design
// §7.1 ({ qmgr, environment, site, shape, source }). The native file is only rendered for a dual
// vantage; the certification file names the alert-sink of the environment.

import { hostPort, targetLabels, nativeTarget, exporterTarget } from './lib.mjs';

const json = (entries) => JSON.stringify(entries, null, 2) + '\n';

export function native(ctx) {
  if (ctx.vantage !== 'dual') return null;
  return json(ctx.qmgrs.map(qm => ({ targets: [nativeTarget(qm)], labels: targetLabels(ctx, qm, 'native') })));
}

export function exporter(ctx) {
  return json(ctx.qmgrs.map(qm => ({ targets: [exporterTarget(qm)], labels: targetLabels(ctx, qm, 'exporter') })));
}

export function certification(ctx) {
  return json([{ targets: [hostPort(ctx.endpoints.alert_sink)], labels: { environment: ctx.env } }]);
}
