// Runs before the tests. `npm test` never compiles anything; it only checks
// that the compiled contracts exist and tells you what to do if they do not.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED = [
  'token',
  'vault',
  'pool',
  'vault_no_first_receiver',
  'vault_no_to_check',
  'vault_no_auth',
  'forwarder',
  'pool_no_min_out',
  'pool_round_up',
  'pool_no_min_liquidity',
  'pool_balance_reserves',
];

const missing = [];
for (const name of REQUIRED) {
  for (const ext of ['wasm', 'abi']) {
    const file = path.join('build', name, `${name}.${ext}`);
    if (!existsSync(path.join(root, file))) missing.push(file);
  }
}

if (missing.length > 0) {
  console.error('Compiled contracts are missing:');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('\nRun `npm run build` first (needs Docker), then `npm test` again.');
  process.exit(1);
}
