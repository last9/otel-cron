// Checks that this Node.js rejects certificate chains through the compromised
// eMudhra intermediates (nodejs/node#66871) while still trusting a normal host.
// Uses default TLS verification; exits non-zero if either expectation fails.
import https from 'node:https';

const BLOCKED = 'https://dv-g3b-emudhra.we-have-a-problem.com/';
const TRUSTED = 'https://nodejs.org/';

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      })
      .on('error', (err) => resolve({ code: err.code, message: err.message }));
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
