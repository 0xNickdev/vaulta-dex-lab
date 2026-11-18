// Property test for the pool: random sequences of deposit / addliquidity /
// swap (both ways) / remliquidity / withdrawdep by several users, including
// invalid and hostile operations. After EVERY step:
//   (a) a swap never decreases reserve_a * reserve_b;
//   (b) table reserves + all pending deposits == the pool's real balance,
//       for each token (the pool is always exactly backed);
//   (c) total_shares == sum of users' shares + the locked MIN_LIQUIDITY;
//   (d) the value of one share never decreases:
//         reserve_a * reserve_b / total_shares^2 only goes up,
//       so no operation can take value from the liquidity providers;
//   (e) no tokens appear or vanish: wallets + pool balance stay constant;
//   (f) a rejected operation changes nothing at all.
// At the end everybody leaves (withdrawdep + remliquidity of all shares):
// every exit must succeed, and the pool must be left with exactly the
// reserves that belong to the locked MIN_LIQUIDITY.
//
// (d) + the solvent exit replace a per-user "nobody leaves with more than a
// fair share" check: computing a fair share per user needs the price at
// every moment a user traded, which makes the test harder to trust than the
// contract. "Share value never decreases" is the same guarantee seen from
// the pool's side, and it is exact.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { tkn } from './helpers/chain.mjs';
import {
  setupPool, deposit, swap, poolState, depositOf, sharesOf, wallet, refAmountOut,
  A, B, MIN_LIQUIDITY,
} from './helpers/pool.mjs';

const USERS = ['alice', 'bob', 'carol'];
const START = 10_000_000n; // every user starts with 1000.0000 of each token

const user = fc.constantFrom(...USERS);
const code = fc.constantFrom(A, B);
// Mostly valid amounts, plus dust and larger-than-the-wallet values.
const amount = fc.oneof(
  { weight: 6, arbitrary: fc.bigInt({ min: 1000n, max: 2_000_000n }) },
  { weight: 2, arbitrary: fc.bigInt({ min: 1n, max: 999n }) },
  { weight: 1, arbitrary: fc.bigInt({ min: START + 1n, max: START * 4n }) },
);
// How the trader picks min_out: 'any' = 1 unit, 'exact' = the true output
// (must pass), 'greedy' = one unit more than the true output (must fail).
const limit = fc.constantFrom('any', 'any', 'exact', 'greedy');

// Three operations in a row by one user: deposit A, deposit B, addliquidity.
// Purely random single operations seldom line up like this, and without
// liquidity nothing else in the pool can be exercised.
const provide = fc.record({ user, a: amount, b: amount }).map(({ user: who, a, b }) => [
  { type: 'deposit', user: who, code: A, amount: a },
  { type: 'deposit', user: who, code: B, amount: b },
  { type: 'addliquidity', user: who },
]);

const single = fc.oneof(
  { weight: 4, arbitrary: fc.record({ type: fc.constant('deposit'), user, code, amount }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('addliquidity'), user }) },
  { weight: 6, arbitrary: fc.record({ type: fc.constant('swap'), user, code, amount, limit }) },
  // `percent` of the user's shares; above 100 is more than he owns.
  { weight: 3, arbitrary: fc.record({ type: fc.constant('remliquidity'), user, percent: fc.integer({ min: 1, max: 120 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('withdrawdep'), user }) },
  // One user signing for another user's shares or deposits; must always fail.
  { weight: 1, arbitrary: fc.record({ type: fc.constant('steal'), user, victim: user, what: fc.constantFrom('shares', 'deposit') }) },
);

// A sequence of steps; each step is one operation or one `provide` triple.
const operations = fc
  .array(fc.oneof({ weight: 5, arbitrary: single.map((op) => [op]) }, { weight: 1, arbitrary: provide }),
    { minLength: 15, maxLength: 40 })
  .map((steps) => steps.flat());

const zero = (c) => tkn(0, c);

function send(ctx, op) {
  const { pool } = ctx;
  switch (op.type) {
    case 'deposit':
      return deposit(ctx, op.user, op.code, op.amount);
    case 'addliquidity':
      return pool.actions.addliquidity([op.user, 1]).send(op.user);
    case 'swap': {
      const s = poolState(pool);
      const [x, y] = op.code === A ? [s.ra, s.rb] : [s.rb, s.ra];
      const out = x > 0n ? refAmountOut(op.amount, x, y, s.fee) : 0n;
      const minOut = op.limit === 'any' ? 1n : op.limit === 'exact' ? out : out + 1n;
      return swap(ctx, op.user, op.code, op.amount, minOut);
    }
    case 'remliquidity': {
      const shares = (sharesOf(pool, op.user) * BigInt(op.percent)) / 100n;
      return pool.actions.remliquidity([op.user, shares.toString(), zero(A), zero(B)]).send(op.user);
    }
    case 'withdrawdep':
      return pool.actions.withdrawdep([op.user]).send(op.user);
    case 'steal':
      return op.what === 'shares'
        ? pool.actions.remliquidity([op.victim, '1', zero(A), zero(B)]).send(op.user)
        : pool.actions.withdrawdep([op.victim]).send(op.user);
    default:
      throw new Error(`unknown operation ${op.type}`);
  }
}

// Everything observable, as one comparable object.
function snapshot({ token, pool }) {
  return {
    pool: poolState(pool),
    balance: wallet(token, 'pool'),
    users: USERS.map((name) => ({
      wallet: wallet(token, name),
      deposit: depositOf(pool, name),
      shares: sharesOf(pool, name),
    })),
  };
}

function checkInvariants(before, after, op, accepted) {
  const p = after.pool;

  // (f) a rejected operation changes nothing.
  if (!accepted) {
    assert.deepEqual(after, before, `rejected ${op.type} changed the state`);
  }

  // (a) product across a swap.
  if (accepted && op.type === 'swap') {
    assert.ok(p.ra * p.rb >= before.pool.ra * before.pool.rb, 'a swap decreased the product');
    assert.equal(p.total, before.pool.total, 'a swap changed total_shares');
  }

  // (b) reserves + pending deposits == real balance.
  let depA = 0n, depB = 0n, shareSum = 0n, walletA = 0n, walletB = 0n;
  for (const u of after.users) {
    assert.ok(u.deposit.a >= 0n && u.deposit.b >= 0n && u.shares >= 0n, 'negative deposit or shares');
    depA += u.deposit.a;
    depB += u.deposit.b;
    shareSum += u.shares;
    walletA += u.wallet.a;
    walletB += u.wallet.b;
  }
  assert.equal(p.ra + depA, after.balance.a, 'TKA: reserve + deposits != pool balance');
  assert.equal(p.rb + depB, after.balance.b, 'TKB: reserve + deposits != pool balance');

  // (c) shares.
  assert.equal(p.total, shareSum + (p.total > 0n ? MIN_LIQUIDITY : 0n), 'total_shares != user shares + locked minimum');
  if (p.total > 0n) {
    assert.ok(p.ra > 0n && p.rb > 0n, 'a reserve was emptied');
    // The locked shares are backed too: shares never outgrow sqrt(product).
    assert.ok(p.total * p.total <= p.ra * p.rb, 'more shares than sqrt(product)');
  }

  // (d) value per share: ra * rb / total^2 never decreases
  //     (cross-multiplied, so there is no division and no rounding).
  if (before.pool.total > 0n) {
    assert.ok(
      p.ra * p.rb * before.pool.total ** 2n >= before.pool.ra * before.pool.rb * p.total ** 2n,
      `${op.type} decreased the value of a share`,
    );
  }

  // (e) conservation.
  assert.equal(walletA + after.balance.a, START * BigInt(USERS.length), 'TKA appeared or vanished');
  assert.equal(walletB + after.balance.b, START * BigInt(USERS.length), 'TKB appeared or vanished');
}

describe('pool: invariants', () => {
  it('hold after every step of any sequence of operations, and everybody can exit', async () => {
    const accepted = {};
    const rejected = {};

    await fc.assert(
      fc.asyncProperty(operations, async (ops) => {
        const ctx = await setupPool({ users: USERS, start: START });
        const { token, pool } = ctx;

        let before = snapshot(ctx);
        for (const op of ops) {
          let ok;
          try {
            await send(ctx, op);
            ok = true;
          } catch (err) {
            if (err instanceof assert.AssertionError) throw err;
            ok = false; // rejected by the contract
          }
          // A "steal" may only succeed when thief and victim are the same account.
          assert.ok(!(ok && op.type === 'steal' && op.user !== op.victim), 'a user took another user\'s funds');
          // A swap with min_out one above the true output must fail; with
          // the exact output it must not fail for that reason.
          assert.ok(!(ok && op.type === 'swap' && op.limit === 'greedy'), 'a swap paid more than the reference output');

          const after = snapshot(ctx);
          checkInvariants(before, after, op, ok);
          (ok ? accepted : rejected)[op.type] = ((ok ? accepted : rejected)[op.type] ?? 0) + 1;
          before = after;
        }

        // Full exit. Every withdrawal must succeed.
        for (const name of USERS) {
          const dep = depositOf(pool, name);
          if (dep.a > 0n || dep.b > 0n) await pool.actions.withdrawdep([name]).send(name);
          const shares = sharesOf(pool, name);
          if (shares > 0n) {
            await pool.actions.remliquidity([name, shares.toString(), zero(A), zero(B)]).send(name);
          }
        }
        const end = snapshot(ctx);
        checkInvariants(before, end, { type: 'exit' }, true);
        assert.deepEqual(pool.tables.deposits().getTableRows(), []);
        assert.deepEqual(pool.tables.shares().getTableRows(), []);
        // Only the locked minimum is left, and the pool holds exactly its reserves.
        assert.ok(end.pool.total === 0n || end.pool.total === MIN_LIQUIDITY);
        assert.deepEqual(end.balance, { a: end.pool.ra, b: end.pool.rb });
      }),
      // Fixed seed: the same sequences on every run, so a failure is reproducible.
      { numRuns: 100, seed: 20261118 },
    );

    console.log('pool invariants: accepted', JSON.stringify(accepted));
    console.log('pool invariants: rejected', JSON.stringify(rejected));
    // Guard against a vacuous test: every kind of operation must really have
    // been both accepted and rejected.
    for (const type of ['deposit', 'addliquidity', 'swap', 'remliquidity', 'withdrawdep']) {
      assert.ok((accepted[type] ?? 0) > 50, `too few accepted ${type}: ${accepted[type]}`);
      assert.ok((rejected[type] ?? 0) > 20, `too few rejected ${type}: ${rejected[type]}`);
    }
    assert.ok((rejected.steal ?? 0) > 20, 'too few steal attempts');
  });
});
