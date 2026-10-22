import { spawnSync } from 'child_process';
import { join } from 'path';

type Outcome = number | string | 'stall';

const PROBE = join(__dirname, '..', 'scripts', 'tls-probe.mjs');

// Runs the real probe with https.get replaced: each request in turn answers
// with a status code, fails with an error code, or ('stall') never settles
// while holding the event loop open like a live socket. Timers are capped at
// 20 ms so the probe's own deadline fires well inside the 2 s watchdog.
function runProbe(blocked: Outcome, trusted: Outcome) {
  const preload = `
    import https from 'node:https';
    import { EventEmitter } from 'node:events';
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(ms, 20), ...args);
    const outcomes = ${JSON.stringify([blocked, trusted])};
    https.get = (_url, options, callback) => {
      if (typeof options === 'function') callback = options;
      const outcome = outcomes.shift();
      const req = new EventEmitter();
      const liveSocket = setInterval(() => {}, 1000);
      req.destroy = (error) => {
        clearInterval(liveSocket);
        queueMicrotask(() => req.emit('error', error ?? new Error('aborted')));
        return req;
      };
      queueMicrotask(() => {
        if (outcome === 'stall') return;
        clearInterval(liveSocket);
        if (typeof outcome === 'number') callback({ statusCode: outcome, resume() {} });
        else req.emit('error', Object.assign(new Error(outcome), { code: outcome }));
      });
      return req;
    };
  `;
  return spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), PROBE],
    { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' },
  );
}

describe('scripts/tls-probe.mjs', () => {
  it.each<[string, Outcome, Outcome, number]>([
    ['passes when the eMudhra host is revoked and the trusted host answers', 'CERT_REVOKED', 307, 0],
    ['fails on a Node that still trusts the eMudhra chain', 200, 200, 1],
    ['fails when the eMudhra host fails for another reason', 'ENOTFOUND', 200, 1],
    ['fails when the trusted host does not connect', 'CERT_REVOKED', 'CERT_HAS_EXPIRED', 1],
  ])('%s', (_name, blocked, trusted, status) => {
    const result = runProbe(blocked, trusted);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
  });

  it.each<[string, Outcome, Outcome]>([
    ['eMudhra host', 'stall', 200],
    ['trusted host', 'CERT_REVOKED', 'stall'],
  ])('fails within its deadline when the %s stalls', (_name, blocked, trusted) => {
    const result = runProbe(blocked, trusted);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"code":"ETIMEDOUT"');
  });
});
