# @last9/otel-cron

Cron jobs have an observability problem. They miss their window, throw unhandled exceptions, or silently stop running — and you find out from users, not alerts. This library fixes that.

Wrap your job function with `withCronJob` and get OTel FaaS-compliant spans and metrics. No changes to your job logic required.

```typescript
import { withCronJob } from '@last9/otel-cron';

await withCronJob(
  { name: 'send-digest', cron: '0 8 * * *' },
  async () => {
    await sendDigestEmails();
  }
);
```

Uses the global OTel API — configure your providers as you normally would and `withCronJob` picks them up.

## Installation

```bash
npm install @last9/otel-cron
```

Peer dependency: `@opentelemetry/api ^1.9.0`.

## Missed-run alerting

The `faas.last_success_time` gauge records a Unix timestamp after every successful run. Wire it to a dead-man alert:

```promql
time() - faas_last_success_time{faas_name="send-digest"} > 90000
```

That fires if the daily digest hasn't succeeded in 25 hours — no scheduler integration, no sidecar, no external ping service.

## Timeouts

```typescript
await withCronJob(
  { name: 'generate-report', cron: '0 6 * * *', timeout: 30_000 },
  async () => {
    await generateReport();
  }
);
```

Exceeding the timeout throws `FaaSTimeoutError` and increments `faas.timeouts` rather than `faas.errors`. Timeouts are a distinct failure mode worth tracking separately. The underlying function keeps running after the error is thrown; use an `AbortController` if you need hard cancellation.

## Signals

| Signal | Type | Description |
|--------|------|-------------|
| `faas.invocations` | Counter | Every invocation |
| `faas.errors` | Counter | Non-timeout failures |
| `faas.timeouts` | Counter | Timeout breaches |
| `faas.invoke_duration` | Histogram (seconds) | Wall-clock duration |
| `faas.last_success_time` | ObservableGauge (Unix s) | Timestamp of last success |
| Span | SERVER · `faas.trigger=timer` | FaaS semantic convention |

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Job identifier. Becomes `faas.name` on every signal. |
| `cron` | `string` | Yes | Cron expression, emitted as `faas.cron` on the span. |
| `timeout` | `number` | No | Deadline in milliseconds. |

## Notes

State is keyed on `globalThis` under `Symbol.for('@last9/otel-cron/state')`. Two copies of this package in the same process share state — the right behavior in monorepos. Run `npm dedupe` if you see duplicate metric registrations.

OTel API v1 only (`^1.9.0`). v2 compatibility requires a new major.
