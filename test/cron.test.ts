import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';

import { withCronJob, FaaSTimeoutError } from '../src';

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider();
tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));

const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 3_600_000, // never fires during tests; tests use forceFlush()
});
const meterProvider = new MeterProvider({ readers: [reader] });

// Set global providers once — OTel API only accepts the first registration.
trace.setGlobalTracerProvider(tracerProvider);
metrics.setGlobalMeterProvider(meterProvider);

beforeEach(() => {
  spanExporter.reset();
  metricExporter.reset();
  // Reset cron state so registeredJobs and lastSuccessTime start fresh each test.
  // gaugeProvider is kept so the callback isn't re-registered on a new provider
  // (there is only one provider for the whole suite).
  const stateKey = Symbol.for('@last9/otel-cron/state');
  const g = globalThis as Record<symbol, unknown>;
  if (g[stateKey]) {
    const state = g[stateKey] as {
      lastSuccessTime: Map<string, number>;
      registeredJobs: Set<string>;
      gaugeProvider: object | null;
      instruments: unknown;
    };
    state.lastSuccessTime.clear();
    state.registeredJobs.clear();
    // Keep gaugeProvider and instruments so they aren't re-registered per test
  }
});

afterAll(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
});

async function collectMetrics() {
  await meterProvider.forceFlush();
  return metricExporter.getMetrics();
}

function findDataPoint(allMetrics: ReturnType<typeof metricExporter.getMetrics>, metricName: string, jobName: string) {
  return allMetrics
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .find((m) => m.descriptor.name === metricName)
    ?.dataPoints.find((p) => p.attributes['faas.name'] === jobName);
}

describe('withCronJob — happy path', () => {
  it('returns the fn result', async () => {
    const result = await withCronJob({ name: 'test-job', cron: '* * * * *' }, async () => 42);
    expect(result).toBe(42);
  });

  it('emits a SERVER span with FaaS attributes', async () => {
    await withCronJob({ name: 'digest', cron: '0 8 * * *' }, async () => {});
    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('digest');
    expect(span.attributes['faas.trigger']).toBe('timer');
    expect(span.attributes['faas.name']).toBe('digest');
    expect(span.attributes['faas.cron']).toBe('0 8 * * *');
    expect(typeof span.attributes['faas.time']).toBe('string');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records faas.invocations counter', async () => {
    await withCronJob({ name: 'inv-job', cron: '* * * * *' }, async () => {});
    const m = await collectMetrics();
    const dp = findDataPoint(m, 'faas.invocations', 'inv-job');
    expect(dp).toBeDefined();
    expect(dp!.value).toBe(1);
  });

  it('records faas.invoke_duration histogram', async () => {
    await withCronJob({ name: 'dur-job', cron: '* * * * *' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const m = await collectMetrics();
    const dp = findDataPoint(m, 'faas.invoke_duration', 'dur-job') as unknown as
      | { value: { sum: number } }
      | undefined;
    expect(dp).toBeDefined();
    expect(dp!.value.sum).toBeGreaterThan(0);
  });

  it('sets faas.last_success_time gauge after success', async () => {
    const before = Math.floor(Date.now() / 1000);
    await withCronJob({ name: 'gauge-job', cron: '* * * * *' }, async () => {});
    const m = await collectMetrics();
    const dp = findDataPoint(m, 'faas.last_success_time', 'gauge-job');
    expect(dp).toBeDefined();
    expect(Number(dp!.value)).toBeGreaterThanOrEqual(before);
  });
});

describe('withCronJob — error path', () => {
  it('re-throws errors and sets span status to ERROR', async () => {
    await expect(
      withCronJob({ name: 'err-job', cron: '* * * * *' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const span = spanExporter.getFinishedSpans()[0];
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events[0].name).toBe('exception');
  });

  it('increments faas.errors counter on error', async () => {
    await expect(
      withCronJob({ name: 'err-cnt', cron: '* * * * *' }, async () => {
        throw new Error('fail');
      })
    ).rejects.toThrow();

    const m = await collectMetrics();
    const dp = findDataPoint(m, 'faas.errors', 'err-cnt');
    expect(dp).toBeDefined();
    expect(dp!.value).toBe(1);
  });

  it('does not update faas.last_success_time on error', async () => {
    await expect(
      withCronJob({ name: 'no-success', cron: '* * * * *' }, async () => {
        throw new Error('fail');
      })
    ).rejects.toThrow();

    const m = await collectMetrics();
    expect(findDataPoint(m, 'faas.last_success_time', 'no-success')).toBeUndefined();
  });
});

describe('withCronJob — timeout', () => {
  it('throws FaaSTimeoutError when fn exceeds timeout', async () => {
    await expect(
      withCronJob({ name: 'slow-job', cron: '* * * * *', timeout: 50 }, async () => {
        await new Promise((r) => setTimeout(r, 200));
      })
    ).rejects.toBeInstanceOf(FaaSTimeoutError);
  });

  it('sets last9.faas.timeout=true on the span', async () => {
    await expect(
      withCronJob({ name: 'to-span', cron: '* * * * *', timeout: 50 }, async () => {
        await new Promise((r) => setTimeout(r, 200));
      })
    ).rejects.toBeInstanceOf(FaaSTimeoutError);

    const span = spanExporter.getFinishedSpans()[0];
    expect(span.attributes['last9.faas.timeout']).toBe(true);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('increments faas.timeouts counter (not faas.errors)', async () => {
    await expect(
      withCronJob({ name: 'to-cnt', cron: '* * * * *', timeout: 50 }, async () => {
        await new Promise((r) => setTimeout(r, 200));
      })
    ).rejects.toBeInstanceOf(FaaSTimeoutError);

    const m = await collectMetrics();
    expect(findDataPoint(m, 'faas.timeouts', 'to-cnt')?.value).toBe(1);
    expect(findDataPoint(m, 'faas.errors', 'to-cnt')).toBeUndefined();
  });
});

describe('withCronJob — double-wrap guard', () => {
  it('warns when the same job name runs concurrently (overlapping invocations)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Both calls start synchronously before either awaits fn() — the second sees the first in registeredJobs
    await Promise.all([
      withCronJob({ name: 'dupe', cron: '* * * * *' }, async () => {}),
      withCronJob({ name: 'dupe', cron: '* * * * *' }, async () => {}),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"dupe"'));
    warnSpy.mockRestore();
  });
});
