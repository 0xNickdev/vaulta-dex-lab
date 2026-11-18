// The pool math against an independent reference implementation.
//
// The reference (refAmountOut / refSqrt in helpers/pool.mjs) uses unbounded
// BigInt arithmetic and a different square-root algorithm, so it cannot
// overflow and cannot share a bug with pool.cpp. The contract is driven
// through its real interface: the numbers compared are tokens actually paid
// out and shares actually minted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { expectError, assertMsg } from './helpers/chain.mjs';
import {
  setupPool, deposit, swap, addLiquidity, poolState, sharesOf, wallet,
  refAmountOut, refSqrt, A, B, MIN_LIQUIDITY, MAX_RESERVE,
} from './helpers/pool.mjs';

// A number with a random SIZE first (1 to `maxBits` bits), then a random
// value of that size. A plain uniform pick up to 2^57 would almost never
// produce a small number.
const sized = (maxBits) =>
  fc.integer({ min: 1, max: maxBits }).chain((bits) => fc.bigInt({ min: 1n, max: (1n << BigInt(bits)) - 1n }));

const min = (x, y) => (x < y ? x : y);

describe('pool math: integer square root', () => {
  // The first addliquidity mints sqrt(a * b) shares in total.
  async function firstMint(a, b) {
    const ctx = await setupPool({ users: ['alice'], start: MAX_RESERVE });
    await deposit(ctx, 'alice', A, a);
    await deposit(ctx, 'alice', B, b);
    const expected = refSqrt(a * b);
    if (expected <= MIN_LIQUIDITY) {
      await expectError(
        ctx.pool.actions.addliquidity(['alice', 1]).send('alice'),
        assertMsg('initial liquidity is too small'),
      );
      return;
    }
    await ctx.pool.actions.addliquidity(['alice', 1]).send('alice');
    assert.equal(poolState(ctx.pool).total, expected, `sqrt(${a} * ${b})`);
    assert.equal(sharesOf(ctx.pool, 'alice'), expected - MIN_LIQUIDITY);
  }

  it('edge cases: perfect squares, one below, one above, the largest reserves', async () => {
    const cases = [
      [1001n, 1001n],                 // smallest accepted
      [1000n, 1002n],                 // 1_002_000 -> 1000 (rounded down) -> rejected
      [1n, 1_002_001n],               // 1001^2
      [1n, 1_002_000n],               // 1001^2 - 1 -> 1000 -> rejected
      [1n, 1_002_002n],               // 1001^2 + 1 -> 1001
      [123_456_789n, 123_456_789n],
      [123_456_789n, 123_456_790n],   // n * (n + 1) -> n
      [123_456_790n, 123_456_788n],   // n^2 - 1 -> n - 1
      [1n, MAX_RESERVE],
      [MAX_RESERVE, MAX_RESERVE],     // the largest product the pool accepts
      [MAX_RESERVE, MAX_RESERVE - 1n],
    ];
    for (const [a, b] of cases) await firstMint(a, b);
  });

  it('matches the reference for random deposits', async () => {
    await fc.assert(
      fc.asyncProperty(sized(57), sized(57), firstMint),
      { numRuns: 150, seed: 20261118 },
    );
  });
});

describe('pool math: swap output', () => {
  // One swap, compared with the reference. Returns false when there was
  // nothing to try (no room under MAX_RESERVE, or the trader is out of tokens).
  async function checkSwap(ctx, aIn, wanted) {
    const { token, pool } = ctx;
    const before = poolState(pool);
    const have = wallet(token, 'trader');
    const [x, y] = aIn ? [before.ra, before.rb] : [before.rb, before.ra];
    const dx = min(min(wanted, MAX_RESERVE - x), aIn ? have.a : have.b);
    if (dx <= 0n) return false;

    const expected = refAmountOut(dx, x, y, before.fee);
    if (expected === 0n) {
      await expectError(swap(ctx, 'trader', aIn ? A : B, dx, 1), assertMsg('output amount is zero'));
      return true;
    }

    // min_out = the exact expected output: one unit less and the swap fails.
    await swap(ctx, 'trader', aIn ? A : B, dx, expected);
    const after = poolState(pool);
    const now = wallet(token, 'trader');
    assert.equal(aIn ? now.b - have.b : now.a - have.a, expected, `out for dx=${dx} x=${x} y=${y} fee=${before.fee}`);
    assert.equal(aIn ? have.a - now.a : have.b - now.b, dx);
    assert.deepEqual(aIn ? [after.ra, after.rb] : [after.rb, after.ra], [x + dx, y - expected]);
    assert.ok(after.ra * after.rb >= before.ra * before.rb, 'product decreased');
    return true;
  }

  async function poolWith(ra, rb, fee) {
    const ctx = await setupPool({ users: ['lp', 'trader'], start: MAX_RESERVE, fee });
    await addLiquidity(ctx, 'lp', ra, rb);
    return ctx;
  }

  it('near-maximum reserves: no overflow, exact result', async () => {
    // Both reserves at 2^56, then the largest input the pool accepts. The
    // numerator is about 2^56 * 2^56 * 10000 = 2^125: it needs 128 bits.
    const half = 1n << 56n;
    for (const fee of [0, 30, 100]) {
      const ctx = await poolWith(half, half, fee);
      assert.ok(await checkSwap(ctx, true, MAX_RESERVE));
      assert.equal(poolState(ctx.pool).ra, MAX_RESERVE);
      assert.ok(await checkSwap(ctx, false, MAX_RESERVE));
    }

    // One reserve at the maximum, the other tiny, in both directions.
    const lopsided = await poolWith(MAX_RESERVE, 2000n, 30);
    assert.ok(await checkSwap(lopsided, false, MAX_RESERVE));
    assert.ok(await checkSwap(lopsided, true, MAX_RESERVE));
    assert.ok(await checkSwap(lopsided, false, 1n));
  });

  it('matches the reference for random reserves, fees and inputs', async () => {
    let swaps = 0;
    let zeroOutputs = 0;

    await fc.assert(
      fc.asyncProperty(
        sized(57), sized(57), fc.integer({ min: 0, max: 100 }),
        fc.array(fc.record({ aIn: fc.boolean(), dx: sized(57) }), { minLength: 4, maxLength: 8 }),
        async (ra, rb, fee, trades) => {
          fc.pre(refSqrt(ra * rb) > MIN_LIQUIDITY);
          const ctx = await poolWith(ra, rb, fee);
          for (const { aIn, dx } of trades) {
            const before = wallet(ctx.token, 'trader');
            if (await checkSwap(ctx, aIn, dx)) {
              swaps++;
              const after = wallet(ctx.token, 'trader');
              if (after.a === before.a && after.b === before.b) zeroOutputs++;
            }
          }
        },
      ),
      { numRuns: 200, seed: 20261118 },
    );

    console.log(`pool math: ${swaps} swaps compared with the reference, ${zeroOutputs} of them zero-output rejections`);
    // Guard against a vacuous test.
    assert.ok(swaps > 800, `too few swaps: ${swaps}`);
    assert.ok(zeroOutputs > 10, `too few zero-output cases: ${zeroOutputs}`);
  });
});
