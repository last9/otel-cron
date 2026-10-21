// Checks that this Node.js rejects certificate chains through the compromised
// eMudhra intermediates (nodejs/node#66871) while still trusting a normal host.
// Uses default TLS verification; exits non-zero if either expectation fails.
import https from 'node:https';

const BLOCKED = 'https://dv-g3b-emudhra.we-have-a-problem.com/';
const TRUSTED = 'https://nodejs.org/';
// Overall per-request deadline, so a host that accepts the connection and then
// goes silent fails the probe instead of holding the CI/release job open.
const DEADLINE_MS = 15_000;

function get(url) {
  return new Promise((resolve) => {
    const req = https
      .get(url, (res) => {
        clearTimeout(deadline);
        res.resume();
        resolve({ status: res.statusCode });
      })
      .on('error', (err) => {
        clearTimeout(deadline);
        resolve({ code: err.code, message: err.message });
      });
    const deadline = setTimeout(() => {
      req.destroy(
        Object.assign(new Error(`no response within ${DEADLINE_MS} ms`), { code: 'ETIMEDOUT' }),
      );
    }, DEADLINE_MS);
  });
}

console.log(`process.version ${process.version}`);

const blocked = await get(BLOCKED);
const trusted = await get(TRUSTED);
console.log(BLOCKED, JSON.stringify(blocked));
console.log(TRUSTED, JSON.stringify(trusted));

let failed = false;
if (blocked.code !== 'CERT_REVOKED') {
  console.error(`expected ${BLOCKED} to fail with CERT_REVOKED`);
  failed = true;
}
if (trusted.status === undefined) {
  console.error(`expected ${TRUSTED} to connect`);
  failed = true;
}
process.exit(failed ? 1 : 0);
