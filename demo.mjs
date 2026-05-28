// Demo: proves @last9/otel-cron emits real OTel spans and metrics
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from '@opentelemetry/sdk-metrics';
import { metrics, trace } from '@opentelemetry/api';
import { withCronJob } from './dist/index.js';

// ── Tracer setup ────────────────────────────────────────────────────────────
const tracerProvider = new BasicTracerProvider();
tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
trace.setGlobalTracerProvider(tracerProvider);

// ── Meter setup ─────────────────────────────────────────────────────────────
const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({
    exporter: new ConsoleMetricExporter(),
    exportIntervalMillis: 500,
  })],
});
metrics.setGlobalMeterProvider(meterProvider);

console.log('\n━━━ Job 1: success ━━━\n');
await withCronJob({ name: 'send-digest', cron: '0 8 * * *' }, async () => {
  await new Promise(r => setTimeout(r, 30));
  console.log('  → job body ran');
});

console.log('\n━━━ Job 2: error ━━━\n');
try {
  await withCronJob({ name: 'sync-inventory', cron: '*/5 * * * *' }, async () => {
    throw new Error('upstream API returned 503');
  });
} catch { /* expected */ }

console.log('\n━━━ Job 3: timeout ━━━\n');
try {
  await withCronJob({ name: 'generate-report', cron: '0 6 * * *', timeout: 50 }, async () => {
    await new Promise(r => setTimeout(r, 500)); // slower than timeout
  });
} catch { /* expected */ }

// flush metrics before exit
await meterProvider.forceFlush();
await tracerProvider.shutdown();
await meterProvider.shutdown();
