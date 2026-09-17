// tools/site/templates/exporter-client.mjs — qmgrs/<QM>/mq_prometheus.yaml
//
// The lab file (stack/mq-exporter/mq_prometheus.yaml) per queue manager: the client exporter's
// connection (CONNAME + channel, or the CCDT URL when the queue manager has TLS), the monitoring
// user and its password file, the poll interval, the environment in metadataMap, the monitored
// queue and channel patterns and the port the collector scrapes (client_port). The constants
// (overrideCType false, keepRunning, showInactiveChannels, hideSvrConnJobname) are not holes:
// each one was measured live (CLAUDE.md, exporter metric semantics).

import { connName, exporterQueues, exporterChannels, objectItem } from './lib.mjs';

export function render(ctx, qm) {
  const t = ctx.timing, p = ctx.p;
  const tls = qm.params.tls || null;
  const connection = tls
    ? `  # TLS: the channel, CONNAME and cipher come from the CCDT; the key repository is the exporter
  # process's MQSSLKEYR=${tls.key_repository} (the .kdb stem, no extension)${tls.cipher ? `, cipher ${tls.cipher}` : ''}.
  ccdtUrl: ${tls.ccdt_url}`
    : `  connName: ${connName(qm)}
  channel: ${qm.params.channels.monitoring}`;
  return `# mq_prometheus (ibm-messaging/mq-metric-samples v6.0.0) — ${ctx.env} configuration${ctx.lab ? '' : ` for ${qm.name}`}.
# Reference: config.common.yaml + cmd/mq_prometheus/config.collector.yaml in that repo.
# Env overrides follow IBMMQ_<SECTION>_<KEY> (uppercase); compose sets queueManager/user/passwordFile.

global:
  useObjectStatus: true        # DIS QSTATUS / CHSTATUS → depth, oldest_message_age, qtime_*, channel_status
  useResetQStats: false
  usePublications: true        # $SYS/MQ resource publications → mqput/mqget counts, qmgr CPU/log/fs
  useStatistics: false
  logLevel: INFO
  metaprefix: ""
  pollInterval: ${t.dur(t.poll)}${ctx.lab ? '            # lab: tight, so chaos MTTD is measured by the pipeline, not the exporter' : ''}
  rediscoverInterval: 1m             # queue attributes (MAXDEPTH, USAGE) are only re-read at rediscovery
  tzOffset: 0h

connection:
  queueManager: ${qm.name}
  clientConnection: true
${connection}
  user: ${p.users.monitor}
  passwordFile: ${qm.params.credentials.monitor_secret}
  replyQueue: SYSTEM.DEFAULT.MODEL.QUEUE
  waitInterval: 3
  metadataMap:
    ENV: ${ctx.env}

objects:
  queues:
${exporterQueues(p).map(q => `    - ${objectItem(q)}\n`).join('')}  channels:
${exporterChannels(qm).map(c => `    - ${objectItem(c)}\n`).join('')}  topics:
  subscriptions:

filters:
  hideSvrConnJobname: true     # one series per SVRCONN channel, not per connection
  showInactiveChannels: true   # a stopped channel must still be a series (status 0) or we cannot alert on it
  hideAMQPClientId: true
  hideMQTTClientId: true
  queueSubscriptionSelector:
    - PUT
    - GET
    - GENERAL
  showCustomAttribute: false
  metricInclude:
    qmgr:
    queues:
    channels:
    topics:
    subscriptions:
    amqpChannels:
    mqttChannels:
  metricExclude:
    qmgr:
    queues:
    channels:
    topics:
    subscriptions:
    amqpChannels:
    mqttChannels:

prometheus:
  port: ${qm.params.client_port}
  metricsPath: "/metrics"
  namespace: ibmmq
  keepRunning: true            # on qmgr loss keep serving ibmmq_qmgr_status{}=0 instead of dying
  reconnectInterval: 5s
  # The $SYS "count" elements (MQPUT/MQGET counts etc.) are PER-INTERVAL DELTAS: one value
  # per 10 s publication, not an accumulating total (seen live: a steady 5 msg/s producer
  # shows a flat ~50). v6 defaults overrideCType to true, which stamps them TYPE counter and
  # makes rate()/increase() nonsense. Keep them as gauges and derive rates with
  # sum_over_time(...[window]) / window_seconds (see docs/catalogue-evidence/ibmmq.md §4).
  overrideCType: false
`;
}
