// Demo: sends real OTel data to a local collector via OTLP/HTTP
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { metrics, trace } from '@opentelemetry/api';
import { withCronJob } from './dist/index.js';

const COLLECTOR = 'http://localhost:4318';

// ── Tracer → collector ──────────────────────────────────────────────────────
const tracerProvider = new BasicTracerProvider();
tracerProvider.addSpanProcessor(
  new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${COLLECTOR}/v1/traces` }))
);
trace.setGlobalTracerProvider(tracerProvider);

// ── Meter → collector ───────────────────────────────────────────────────────
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${COLLECTOR}/v1/metrics` }),
    exportIntervalMillis: 500,
  })],
});
metrics.setGlobalMeterProvider(meterProvider);

console.log('Sending to OTel collector at', COLLECTOR, '...\n');

console.log('[1] send-digest — success');
await withCronJob({ name: 'send-digest', cron: '0 8 * * *' }, async () => {
  await new Promise(r => setTimeout(r, 30));
});

console.log('[2] sync-inventory — throws error');
try {
  await withCronJob({ name: 'sync-inventory', cron: '*/5 * * * *' }, async () => {
    throw new Error('upstream API returned 503');
  });
} catch { /* expected */ }

console.log('[3] generate-report — timeout (50ms limit, 300ms job)');
try {
  await withCronJob({ name: 'generate-report', cron: '0 6 * * *', timeout: 50 }, async () => {
    await new Promise(r => setTimeout(r, 300));
  });
} catch { /* expected */ }

console.log('\nFlushing to collector...');
await meterProvider.forceFlush();
await tracerProvider.forceFlush();
await tracerProvider.shutdown();
await meterProvider.shutdown();
console.log('Done. Check collector output above.\n');
