import { trace, metrics, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import type { Counter, Histogram, ObservableResult } from '@opentelemetry/api';
import {
  ATTR_FAAS_TRIGGER,
  ATTR_FAAS_TRIGGER_VALUE_TIMER,
  ATTR_FAAS_CRON,
  ATTR_FAAS_TIME,
  ATTR_FAAS_NAME,
  ATTR_LAST9_FAAS_TIMEOUT,
  METRIC_FAAS_INVOCATIONS,
  METRIC_FAAS_ERRORS,
  METRIC_FAAS_TIMEOUTS,
  METRIC_FAAS_INVOKE_DURATION,
  METRIC_FAAS_LAST_SUCCESS_TIME,
} from './attributes';
import { CronJobOptions, FaaSTimeoutError } from './types';
import { VERSION } from './version';

const STATE_KEY = Symbol.for('@last9/otel-cron/state');

interface CronInstruments {
  invocations: Counter;
  errors: Counter;
  timeouts: Counter;
  duration: Histogram;
}

interface CronState {
  lastSuccessTime: Map<string, number>;
  registeredJobs: Set<string>;
  /** Provider for which instruments and gauge are registered; null means uninitialised */
  gaugeProvider: object | null;
  instruments: CronInstruments | null;
}

function getState(): CronState {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      lastSuccessTime: new Map(),
      registeredJobs: new Set(),
      gaugeProvider: null,
      instruments: null,
    };
  }
  return g[STATE_KEY] as CronState;
}

const SCOPE_NAME = '@last9/otel-cron';

function ensureInstrumented(state: CronState): CronInstruments {
  const currentProvider = metrics.getMeterProvider();
  if (state.gaugeProvider === currentProvider && state.instruments) {
    return state.instruments;
  }
  state.gaugeProvider = currentProvider;

  const meter = metrics.getMeter(SCOPE_NAME, VERSION);

  const gauge = meter.createObservableGauge(METRIC_FAAS_LAST_SUCCESS_TIME, {
    description:
      'Unix epoch seconds of the last successful cron job completion (Last9 extension)',
    unit: 's',
  });
  gauge.addCallback((result: ObservableResult) => {
    for (const [name, ts] of state.lastSuccessTime) {
      result.observe(ts, { [ATTR_FAAS_NAME]: name });
    }
  });

  state.instruments = {
    invocations: meter.createCounter(METRIC_FAAS_INVOCATIONS, {
      description: 'Number of cron job invocations',
      unit: '{invocation}',
    }),
    errors: meter.createCounter(METRIC_FAAS_ERRORS, {
      description: 'Number of failed cron job invocations',
      unit: '{error}',
    }),
    timeouts: meter.createCounter(METRIC_FAAS_TIMEOUTS, {
      description: 'Number of cron job timeout breaches',
      unit: '{timeout}',
    }),
    duration: meter.createHistogram(METRIC_FAAS_INVOKE_DURATION, {
      description: 'Cron job execution duration in seconds',
      unit: 's',
    }),
  };
  return state.instruments;
}

export async function withCronJob<T>(
  options: CronJobOptions,
  fn: () => Promise<T>
): Promise<T> {
  const { name, cron, timeout } = options;
  const state = getState();

  if (state.registeredJobs.has(name)) {
    console.warn(
      `[@last9/otel-cron] Job "${name}" is already registered. Wrapping the same job name twice may produce duplicate metrics.`
    );
  }
  state.registeredJobs.add(name);

  const { invocations, errors, timeouts, duration } = ensureInstrumented(state);
  const tracer = trace.getTracer(SCOPE_NAME, VERSION);

  const jobAttrs = { [ATTR_FAAS_NAME]: name };

  return tracer.startActiveSpan(
    name,
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_FAAS_TRIGGER]: ATTR_FAAS_TRIGGER_VALUE_TIMER,
        [ATTR_FAAS_NAME]: name,
        [ATTR_FAAS_CRON]: cron,
        [ATTR_FAAS_TIME]: new Date().toISOString(),
      },
    },
    async (span) => {
      invocations.add(1, jobAttrs); // inside span so the data point receives an exemplar
      const startS = Date.now() / 1000;
      let timedOut = false;

      try {
        let result: T;

        if (timeout !== undefined) {
          const fnPromise = fn();
          fnPromise.catch(() => {}); // suppress unhandled rejection if timeout wins the race
          let timerId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new FaaSTimeoutError(name, timeout)), timeout);
          });
          try {
            result = await Promise.race([fnPromise, timeoutPromise]);
          } finally {
            clearTimeout(timerId); // no-op if timeout fired; prevents event-loop hold on fast fn()
          }
        } else {
          result = await fn();
        }

        state.lastSuccessTime.set(name, Math.floor(Date.now() / 1000));
        return result;
      } catch (err) {
        if (err instanceof FaaSTimeoutError) {
          timedOut = true;
          timeouts.add(1, jobAttrs);
          span.setAttribute(ATTR_LAST9_FAAS_TIMEOUT, true);
        } else {
          errors.add(1, jobAttrs);
        }
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        const durationAttrs = timedOut
          ? { ...jobAttrs, [ATTR_LAST9_FAAS_TIMEOUT]: true }
          : jobAttrs;
        duration.record(Date.now() / 1000 - startS, durationAttrs);
        span.end();
        // clear so the next scheduled invocation doesn't trigger the double-wrap warning
        state.registeredJobs.delete(name);
      }
    }
  );
}
