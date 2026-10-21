import { readFileSync } from 'fs';
import { join } from 'path';

// First release on each supported line that rejects the compromised eMudhra
// intermediates (SPKI blocklist, nodejs/node#66871). Odd lines 23/25 are
// end-of-life and never got the fix, so they stay excluded.
const PATCHED_NODE = ['22.23.4', '24.22.1', '26.12.1'];
const ENGINES = '^22.23.4 || ^24.22.1 || >=26.12.1';

const root = join(__dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('supported Node.js versions', () => {
  it('floors engines.node at the patched release of each line', () => {
    expect(JSON.parse(read('package.json')).engines.node).toBe(ENGINES);
    expect(ENGINES.match(/\d+\.\d+\.\d+/g)).toEqual(PATCHED_NODE);
  });

  it('keeps package-lock.json in step with package.json', () => {
    expect(JSON.parse(read('package-lock.json')).packages[''].engines.node).toBe(ENGINES);
  });

  it('documents every patched floor in the README', () => {
    const readme = read('README.md');
    for (const version of PATCHED_NODE) {
      expect(readme).toContain(`v${version}`);
    }
  });
});
