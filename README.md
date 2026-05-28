# @last9/otel-cron

OpenTelemetry FaaS-compliant instrumentation for cron job observability. Wraps any async function and emits spans and metrics following [OTel FaaS semantic conventions](https://opentelemetry.io/docs/specs/semconv/faas/).

## Installation

```bash
npm install @last9/otel-cron
```

Peer dependency: `@opentelemetry/api ^1.9.0` (v1.x only).

## Usage

```typescript
import { withCronJob } from '@last9/otel-cron';

await withCronJob(
  { name: 'send-digest', cron: '0 8 * * *', timeout: 30_000 },
  async () => {
    await sendDigestEmails();
  }
);
```

Set up OTel providers as normal before calling `withCronJob` — this library uses the global API and emits to whatever provider you have registered.

## Signals emitted

| Signal | Type | Description |
|--------|------|-------------|
| `faas.invocations` | Counter | Every invocation |
| `faas.errors` | Counter | Non-timeout failures |
| `faas.timeouts` | Counter | Timeout breaches |
| `faas.invoke_duration` | Histogram (s) | Execution duration |
| `faas.last_success_time` | ObservableGauge (Unix epoch s) | Last9 extension — use for missed-job alerting |
| Span (`faas.trigger=timer`) | SERVER span | FaaS semconv attributes |

## Missed-job alerting

Use `faas.last_success_time` as a dead-man signal:

```promql
time() - faas_last_success_time{faas_name="send-digest"} > 90000
```

Fires when the job has not succeeded in more than 25 hours (for a daily job).

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique job name. Used as `faas.name` attribute and metric label. |
| `cron` | `string` | Yes | Cron expression (informational — emitted as `faas.cron` span attribute). |
| `timeout` | `number` | No | Timeout in milliseconds. Throws `FaaSTimeoutError` on breach. The underlying function continues running (use `AbortController` for hard cancellation). |

## Error handling

On timeout, `FaaSTimeoutError` is thrown and `faas.timeouts` is incremented (not `faas.errors`). The underlying function is **not** cancelled.

On any other error, `faas.errors` is incremented and the error is re-thrown.

## Dual-install safety

Global state (`faas.last_success_time` map, job registry) is stored on `globalThis` under `Symbol.for('@last9/otel-cron/state')`, so two copies of this library in the same process share the same state. Run `npm dedupe` if you see duplicate metric registrations.

## Known limitations

- OTel API v1 only (`^1.9.0` peer dep). v2 compatibility requires a new major release.
- Timeout abandons the function — the underlying fn() keeps running after `FaaSTimeoutError` is thrown.
