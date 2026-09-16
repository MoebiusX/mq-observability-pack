// OpenTelemetry bootstrap. MUST be imported before ibmmq: the ibmmq module detects
// @opentelemetry/api in the module cache at first use and only then propagates
// W3C traceparent/tracestate through MQ message properties.
import * as api from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { hostname } from 'node:os';

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/$/, '');
const serviceName = process.env.OTEL_SERVICE_NAME || 'mq-canary';

export const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
    'service.instance.id': `${hostname()}:${process.pid}`,
    'messaging.system': 'ibmmq',
    'mq.qmgr.name': process.env.MQ_QMGR || 'QM1',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 5000),
  }),
});
sdk.start();

export const tracer = api.trace.getTracer(serviceName, '0.1.0');
export const meter = api.metrics.getMeter(serviceName, '0.1.0');
export { api };

// Structured log line with trace correlation — collector's filelog picks this up from
// docker's json log, Loki's derived field turns trace_id into a Jaeger link.
export function log(level, msg, extra = {}) {
  const span = api.trace.getSpan(api.context.active());
  const sc = span?.spanContext();
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), level, service: serviceName, msg,
    ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}),
    ...extra,
  }) + '\n');
}

export async function shutdown() {
  try { await sdk.shutdown(); } catch { /* best effort */ }
}
