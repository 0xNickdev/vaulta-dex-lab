// Property test for the vault: after any sequence of deposits and
// withdrawals by several users,
//   1. sum of all vault-table balances == the vault's balance in the token
//      contract (the vault is always fully backed);
//   2. for every user: wallet + vault balance == what the user started with
//      (nobody gains or loses tokens).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { newChain, deploy, tkn, tokenBalance, vaultBalance, vaultRows, SYMBOL } from './helpers/chain.mjs';

const USERS = ['alice', 'bob', 'carol'];
const START = 100_000n; // every user starts with 10.0000 TKN in the wallet

// Mostly valid amounts, plus zero/negative and larger-than-anything values.
const amount = fc.oneof(
  { weight: 8, arbitrary: fc.bigInt({ min: 1n, max: 20_000n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: -1000n, max: 0n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: START + 1n, max: START * 4n }) },
);
const user = fc.constantFrom(...USERS);

const operation = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant('deposit'), user, amount }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant('withdraw'), user, amount }) },
  // "withdrawAll" makes sure the row-deletion path is exercised often.
  { weight: 1, arbitrary: fc.record({ type: fc.constant('withdrawAll'), user }) },
  // One user trying to withdraw another user's balance; must always fail.
  { weight: 1, arbitrary: fc.record({ type: fc.constant('steal'), user, victim: user, amount }) },
);

function send({ token, vault }, op) {
  switch (op.type) {
    case 'deposit':
      return token.actions.transfer([op.user, 'vault', tkn(op.amount), '']).send(op.user);
    case 'withdraw':
      return vault.actions.withdraw([op.user, { quantity: tkn(op.amount), contract: 'token' }]).send(op.user);
    case 'withdrawAll':
      return vault.actions
        .withdraw([op.user, { quantity: tkn(vaultBalance(vault, op.user)), contract: 'token' }])
        .send(op.user);
    case 'steal':
      return vault.actions.withdraw([op.victim, { quantity: tkn(op.amount), contract: 'token' }]).send(op.user);
    default:
      throw new Error(`unknown operation ${op.type}`);
  }
}

function checkInvariant({ token, vault }) {
  let sum = 0n;
  for (const name of USERS) {
    const inVault = vaultBalance(vault, name);
    assert.ok(inVault >= 0n, `${name} must not have a negative vault balance`);
    assert.equal(tokenBalance(token, name) + inVault, START, `${name}: wallet + vault must stay constant`);
    // A row with zero balance must have been deleted.
    for (const row of vaultRows(vault, name)) {
      assert.notEqual(row.balance.quantity, tkn(0), `${name} has a zero-balance row`);
    }
    sum += inVault;
  }
  assert.equal(sum, tokenBalance(token, 'vault'), 'sum of vault balances must equal the tokens the vault holds');
}

describe('vault: invariant', () => {
  it('sum of vault balances == vault token balance after any sequence of operations', async () => {
    let accepted = 0;
    let rejected = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 10, maxLength: 40 }), async (ops) => {
        const chain = newChain();
        const token = deploy(chain, 'token', 'token');
        const vault = deploy(chain, 'vault', 'vault');
        chain.createAccounts('issuer', ...USERS);

        await token.actions.create(['issuer', tkn(10_000_000)]).send('token');
        await token.actions.issue(['issuer', tkn(START * BigInt(USERS.length)), '']).send('issuer');
        for (const name of USERS) {
          await token.actions.transfer(['issuer', name, tkn(START), '']).send('issuer');
        }
        await vault.actions.addtoken(['token', SYMBOL]).send('vault');

        const ctx = { token, vault };
        for (const op of ops) {
          try {
            await send(ctx, op);
            // A "steal" may only succeed when thief and victim are the same account.
            assert.ok(op.type !== 'steal' || op.user === op.victim, 'a user withdrew another user\'s balance');
            accepted++;
          } catch (err) {
            if (err instanceof assert.AssertionError) throw err;
            rejected++; // rejected by the contract; the state must be unchanged
          }
          checkInvariant(ctx);
        }
      }),
      // Fixed seed: the same sequences on every run, so a failure is reproducible.
      { numRuns: 100, seed: 20261118 },
    );

    console.log(`vault invariant: ${accepted} accepted, ${rejected} rejected operations`);
    // Guard against a vacuous test: both branches must really have happened.
    assert.ok(accepted > 100, `too few accepted operations: ${accepted}`);
    assert.ok(rejected > 100, `too few rejected operations: ${rejected}`);
  });
});
