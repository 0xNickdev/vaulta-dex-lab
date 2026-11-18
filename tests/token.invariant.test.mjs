// Property test for the token: whatever sequence of actions is sent
// (valid or not), the sum of all balances always equals the supply and the
// supply never exceeds the cap.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { newChain, deploy, tkn, tokenBalance, tokenStat, units, SYMBOL } from './helpers/chain.mjs';

const USERS = ['alice', 'bob', 'carol', 'dave'];
const ISSUER = 'alice';
const MAX_SUPPLY = 1_000_000n;

// Amounts are mostly small and valid, but zero, negative and too-large
// values are generated too: a rejected action must not break the invariant.
const amount = fc.oneof(
  { weight: 8, arbitrary: fc.bigInt({ min: 1n, max: 60_000n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -1000n, max: 0n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: MAX_SUPPLY, max: MAX_SUPPLY * 3n }) },
);
const user = fc.constantFrom(...USERS);

const operation = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant('transfer'), from: user, to: user, amount }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('issue'), amount }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('retire'), amount }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('open'), owner: user }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('close'), owner: user }) },
);

function send(token, op) {
  switch (op.type) {
    case 'transfer':
      return token.actions.transfer([op.from, op.to, tkn(op.amount), '']).send(op.from);
    case 'issue':
      return token.actions.issue([ISSUER, tkn(op.amount), '']).send(ISSUER);
    case 'retire':
      return token.actions.retire([tkn(op.amount), '']).send(ISSUER);
    case 'open':
      return token.actions.open([op.owner, SYMBOL, op.owner]).send(op.owner);
    case 'close':
      return token.actions.close([op.owner, SYMBOL]).send(op.owner);
    default:
      throw new Error(`unknown operation ${op.type}`);
  }
}

function checkInvariant(token) {
  const supply = units(tokenStat(token).supply);
  const sum = USERS.reduce((acc, name) => acc + tokenBalance(token, name), 0n);
  assert.equal(sum, supply, 'sum of balances must equal supply');
  assert.ok(supply >= 0n && supply <= MAX_SUPPLY, 'supply must stay within [0, max_supply]');
  for (const name of USERS) {
    assert.ok(tokenBalance(token, name) >= 0n, `${name} must not have a negative balance`);
  }
}

describe('token: invariant', () => {
  it('sum of balances == supply after any sequence of operations', async () => {
    let accepted = 0;
    let rejected = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 10, maxLength: 40 }), async (ops) => {
        const chain = newChain();
        const token = deploy(chain, 'token', 'token');
        chain.createAccounts(...USERS);
        await token.actions.create([ISSUER, tkn(MAX_SUPPLY)]).send('token');
        // Start with some tokens everywhere, otherwise most transfers would
        // fail and the test would mostly exercise the error paths.
        await token.actions.issue([ISSUER, tkn(400_000), '']).send(ISSUER);
        for (const name of USERS.filter((u) => u !== ISSUER)) {
          await token.actions.transfer([ISSUER, name, tkn(100_000), '']).send(ISSUER);
        }
        checkInvariant(token);

        for (const op of ops) {
          try {
            await send(token, op);
            accepted++;
          } catch {
            rejected++; // e.g. overdrawn balance; the state must be unchanged
          }
          checkInvariant(token);
        }
      }),
      // Fixed seed: the same sequences on every run, so a failure is reproducible.
      { numRuns: 100, seed: 20261118 },
    );

    // Guard against a vacuous test: both branches must really have happened.
    console.log(`token invariant: ${accepted} accepted, ${rejected} rejected operations`);
    assert.ok(accepted > 100, `too few accepted operations: ${accepted}`);
    assert.ok(rejected > 100, `too few rejected operations: ${rejected}`);
  });
});
