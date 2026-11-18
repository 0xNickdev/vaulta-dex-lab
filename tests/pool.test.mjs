// Unit tests for contracts/pool/pool.cpp (the safe pool): every action and
// every memo path, positive and negative.
// The attacks against it live in pool.attacks.test.mjs.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { deploy, tkn, tokenBalance, expectError, assertMsg, missingAuth } from './helpers/chain.mjs';
import {
  setupPool, deposit, swap, addLiquidity, poolState, depositOf, sharesOf, wallet,
  A, B, TOKEN_A, TOKEN_B, MIN_LIQUIDITY, MAX_RESERVE,
} from './helpers/pool.mjs';

const START = 10_000_000n; // alice and bob each start with 1000.0000 TKA and TKB

const NOT_POOL_TOKEN = assertMsg('not a pool token: contract and symbol must match the pool configuration');
const UNKNOWN_MEMO = assertMsg("unknown memo: use 'deposit' or 'swap:<min_out>'");
const BAD_SWAP_MEMO = assertMsg("bad swap memo: use 'swap:<min_out>', min_out = 1 to 18 digits");
const NOT_INITIALIZED = assertMsg('pool is not initialized');

const zero = (code) => tkn(0, code);

let ctx;
let token;
let pool;

// Fresh chain for every test: an initialized, EMPTY pool (fee 0.30%).
beforeEach(async () => {
  ctx = await setupPool({ start: START });
  ({ token, pool } = ctx);
});

// ====================================================================== init
describe('pool: init', () => {
  it('stores the two tokens, the fee and empty reserves', () => {
    assert.deepEqual(pool.tables.pool().getTableRows(), [{
      reserve_a: { quantity: zero(A), contract: 'token' },
      reserve_b: { quantity: zero(B), contract: 'token' },
      fee_bps: 30,
      total_shares: 0,
    }]);
  });

  it('needs the pool account', async () => {
    const fresh = await setupPool({ init: false });
    await expectError(
      fresh.pool.actions.init([TOKEN_A, TOKEN_B, 30]).send('alice'),
      missingAuth('pool'),
    );
  });

  it('cannot be called twice', async () => {
    await expectError(
      pool.actions.init([TOKEN_A, TOKEN_B, 0]).send('pool'),
      assertMsg('pool is already initialized'),
    );
    assert.equal(poolState(pool).fee, 30n);
  });

  it('accepts a fee of 0 and of exactly 100 basis points, rejects 101', async () => {
    for (const fee of [0, 100]) {
      const fresh = await setupPool({ init: false });
      await fresh.pool.actions.init([TOKEN_A, TOKEN_B, fee]).send('pool');
      assert.equal(poolState(fresh.pool).fee, BigInt(fee));
    }
    const fresh = await setupPool({ init: false });
    await expectError(
      fresh.pool.actions.init([TOKEN_A, TOKEN_B, 101]).send('pool'),
      assertMsg('fee is above the maximum of 100 basis points'),
    );
    assert.equal(poolState(fresh.pool), undefined);
  });

  it('rejects the same token twice', async () => {
    const fresh = await setupPool({ init: false });
    await expectError(
      fresh.pool.actions.init([TOKEN_A, TOKEN_A, 30]).send('pool'),
      assertMsg('the two tokens must be different'),
    );
    // Same code and contract with another precision is still the same token.
    await expectError(
      fresh.pool.actions.init([TOKEN_A, { sym: `2,${A}`, contract: 'token' }, 30]).send('pool'),
      assertMsg('the two tokens must be different'),
    );
  });

  it('rejects a token contract that does not exist', async () => {
    const fresh = await setupPool({ init: false });
    await expectError(
      fresh.pool.actions.init([TOKEN_A, { sym: `4,${B}`, contract: 'nobody' }, 30]).send('pool'),
      assertMsg('token contract account does not exist'),
    );
  });

  it('before init: transfers and all actions are rejected, no tokens are taken', async () => {
    const fresh = await setupPool({ init: false });
    await expectError(deposit(fresh, 'alice', A, 1000n), NOT_INITIALIZED);
    await expectError(swap(fresh, 'alice', A, 1000n, 1), NOT_INITIALIZED);
    await expectError(fresh.pool.actions.addliquidity(['alice', 1]).send('alice'), NOT_INITIALIZED);
    await expectError(
      fresh.pool.actions.remliquidity(['alice', 1, zero(A), zero(B)]).send('alice'), NOT_INITIALIZED);
    await expectError(fresh.pool.actions.withdrawdep(['alice']).send('alice'), NOT_INITIALIZED);
    assert.deepEqual(wallet(fresh.token, 'alice'), { a: START, b: START });
  });
});

// =================================================================== deposit
describe('pool: transfer with memo "deposit"', () => {
  it('credits the sender, per token, and adds up', async () => {
    await deposit(ctx, 'alice', A, 300n);
    assert.deepEqual(depositOf(pool, 'alice'), { a: 300n, b: 0n });

    await deposit(ctx, 'alice', B, 50n);
    await deposit(ctx, 'alice', A, 700n);
    assert.deepEqual(depositOf(pool, 'alice'), { a: 1000n, b: 50n });
    assert.deepEqual(depositOf(pool, 'bob'), { a: 0n, b: 0n });

    // A deposit is NOT liquidity: reserves and shares are untouched.
    const state = poolState(pool);
    assert.deepEqual([state.ra, state.rb, state.total], [0n, 0n, 0n]);
    assert.deepEqual(wallet(token, 'pool'), { a: 1000n, b: 50n });
  });

  it('a fake token contract with the right symbol is rejected', async () => {
    // The attacker deploys the same token code on his own account and
    // creates his own "TKA" there.
    const fake = deploy(ctx.chain, 'fake.tk', 'token');
    await fake.actions.create(['alice', tkn(1_000_000n, A)]).send('fake.tk');
    await fake.actions.issue(['alice', tkn(1_000_000n, A), '']).send('alice');

    await expectError(
      fake.actions.transfer(['alice', 'pool', tkn(1000n, A), 'deposit']).send('alice'),
      NOT_POOL_TOKEN,
    );
    await expectError(
      fake.actions.transfer(['alice', 'pool', tkn(1000n, A), 'swap:1']).send('alice'),
      NOT_POOL_TOKEN,
    );
    assert.deepEqual(depositOf(pool, 'alice'), { a: 0n, b: 0n });
  });

  it('a third token from the real token contract is rejected', async () => {
    await token.actions.create(['issuer', tkn(1_000_000n, 'TKC')]).send('token');
    await token.actions.issue(['issuer', tkn(1_000_000n, 'TKC'), '']).send('issuer');
    await token.actions.transfer(['issuer', 'alice', tkn(1000n, 'TKC'), '']).send('issuer');

    await expectError(
      token.actions.transfer(['alice', 'pool', tkn(1000n, 'TKC'), 'deposit']).send('alice'),
      NOT_POOL_TOKEN,
    );
    assert.equal(tokenBalance(token, 'alice', 'TKC'), 1000n); // nothing lost
  });

  it('the wrong precision is rejected', async () => {
    // This pool was configured with "2,TKA" although the real TKA has 4
    // decimals. Accepting it would read 1.0000 TKA (10000 units) as 100.00.
    const fresh = await setupPool({ init: false });
    await fresh.pool.actions.init([{ sym: `2,${A}`, contract: 'token' }, TOKEN_B, 30]).send('pool');
    await expectError(deposit(fresh, 'alice', A, 10_000n), NOT_POOL_TOKEN);
    assert.equal(tokenBalance(fresh.token, 'alice', A), START);
  });

  it('a forwarded notification (to != pool) is ignored', async () => {
    // alice -> her own forwarder contract; the forwarder relays the
    // notification to the account named in the memo ("pool").
    deploy(ctx.chain, 'alice.fw', 'forwarder');
    await token.actions.transfer(['alice', 'alice.fw', tkn(5000n, A), 'pool']).send('alice');

    assert.equal(tokenBalance(token, 'alice.fw', A), 5000n); // the transfer itself went through
    assert.deepEqual(pool.tables.deposits().getTableRows(), []); // but the pool credited nothing
    assert.equal(tokenBalance(token, 'pool', A), 0n);
  });

  it('an unknown memo reverts the transfer', async () => {
    for (const memo of ['', 'Deposit', 'deposit ', ' deposit', 'deposit:1', 'swap', 'Swap:1', 'hello']) {
      await expectError(
        token.actions.transfer(['alice', 'pool', tkn(1000n, A), memo]).send('alice'),
        UNKNOWN_MEMO,
      );
    }
    assert.deepEqual(wallet(token, 'alice'), { a: START, b: START });
    assert.deepEqual(wallet(token, 'pool'), { a: 0n, b: 0n });
  });
});

// ============================================================== addliquidity
describe('pool: addliquidity', () => {
  it('first deposit: shares = sqrt(a * b), MIN_LIQUIDITY of them locked', async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n);

    // sqrt(4_000_000 * 1_000_000) = 2_000_000
    assert.deepEqual(poolState(pool), { ra: 4_000_000n, rb: 1_000_000n, fee: 30n, total: 2_000_000n });
    assert.equal(sharesOf(pool, 'alice'), 2_000_000n - MIN_LIQUIDITY);
    assert.deepEqual(pool.tables.deposits().getTableRows(), []); // fully used, row deleted
  });

  it('needs the owner', async () => {
    await deposit(ctx, 'alice', A, 5000n);
    await deposit(ctx, 'alice', B, 5000n);
    await expectError(pool.actions.addliquidity(['alice', 1]).send('bob'), missingAuth('alice'));
  });

  it('min_shares of zero or below is rejected', async () => {
    await deposit(ctx, 'alice', A, 5000n);
    await deposit(ctx, 'alice', B, 5000n);
    for (const min of [0, -1]) {
      await expectError(
        pool.actions.addliquidity(['alice', min]).send('alice'),
        assertMsg('min_shares must be positive'),
      );
    }
  });

  it('needs a deposit of BOTH tokens', async () => {
    await expectError(
      pool.actions.addliquidity(['alice', 1]).send('alice'),
      assertMsg('deposit both tokens first'),
    );
    await deposit(ctx, 'alice', A, 5000n);
    await expectError(
      pool.actions.addliquidity(['alice', 1]).send('alice'),
      assertMsg('deposit both tokens first'),
    );
  });

  it('first deposit must mint more than MIN_LIQUIDITY', async () => {
    // sqrt(1000 * 1000) = 1000: all of it would be locked, nothing for alice.
    await deposit(ctx, 'alice', A, 1000n);
    await deposit(ctx, 'alice', B, 1000n);
    await expectError(
      pool.actions.addliquidity(['alice', 1]).send('alice'),
      assertMsg('initial liquidity is too small'),
    );

    // One unit more of each: sqrt(1001 * 1001) = 1001 -> exactly 1 share.
    await deposit(ctx, 'alice', A, 1n);
    await deposit(ctx, 'alice', B, 1n);
    await pool.actions.addliquidity(['alice', 1]).send('alice');
    assert.equal(sharesOf(pool, 'alice'), 1n);
    assert.equal(poolState(pool).total, 1001n);
  });

  it('later deposit at the pool ratio: proportional shares, everything used', async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n); // total 2_000_000
    await addLiquidity(ctx, 'bob', 400_000n, 100_000n);       // exactly 10% more

    assert.equal(sharesOf(pool, 'bob'), 200_000n);
    assert.deepEqual(poolState(pool), { ra: 4_400_000n, rb: 1_100_000n, fee: 30n, total: 2_200_000n });
    assert.deepEqual(depositOf(pool, 'bob'), { a: 0n, b: 0n });
  });

  it('later deposit off the ratio: the excess stays in the deposit, not in the pool', async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n);
    // bob brings 400_000 A but 300_000 B; the A side limits him to 10%.
    await addLiquidity(ctx, 'bob', 400_000n, 300_000n);

    assert.equal(sharesOf(pool, 'bob'), 200_000n);
    assert.deepEqual(poolState(pool), { ra: 4_400_000n, rb: 1_100_000n, fee: 30n, total: 2_200_000n });
    assert.deepEqual(depositOf(pool, 'bob'), { a: 0n, b: 200_000n }); // still bob's
  });

  it('amounts taken from the depositor are rounded UP, shares rounded DOWN', async () => {
    await addLiquidity(ctx, 'alice', 3_000_000n, 3_000_000n);
    await swap(ctx, 'alice', A, 1_000_000n, 1); // makes the ratio "ugly"
    const before = poolState(pool); // ra 4_000_000, rb 2_251_877, total 3_000_000

    await addLiquidity(ctx, 'bob', 1000n, 1000n);
    // shares = min(1000 * 3_000_000 / 4_000_000, 1000 * 3_000_000 / 2_251_877)
    //        = min(750, 1332) = 750
    assert.equal(sharesOf(pool, 'bob'), 750n);
    const after = poolState(pool);
    // used_a = ceil(750 * 4_000_000 / 3_000_000) = 1000
    // used_b = ceil(750 * 2_251_877 / 3_000_000) = ceil(562.97) = 563
    assert.equal(after.ra - before.ra, 1000n);
    assert.equal(after.rb - before.rb, 563n);
    assert.deepEqual(depositOf(pool, 'bob'), { a: 0n, b: 437n });
  });

  it('min_shares protects the depositor', async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n);
    await deposit(ctx, 'bob', A, 400_000n);
    await deposit(ctx, 'bob', B, 100_000n);
    await expectError(
      pool.actions.addliquidity(['bob', 200_001]).send('bob'),
      assertMsg('shares are less than min_shares'),
    );
    await pool.actions.addliquidity(['bob', 200_000]).send('bob');
    assert.equal(sharesOf(pool, 'bob'), 200_000n);
  });

  it('a deposit too small for one share is rejected and stays withdrawable', async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n); // 1 share costs 2 A + 0.5 B
    await deposit(ctx, 'bob', A, 1n);
    await deposit(ctx, 'bob', B, 1n);
    await expectError(
      pool.actions.addliquidity(['bob', 1]).send('bob'),
      assertMsg('deposit is too small to mint a share'),
    );
    await pool.actions.withdrawdep(['bob']).send('bob');
    assert.deepEqual(wallet(token, 'bob'), { a: START, b: START });
  });

  it('a reserve above MAX_RESERVE is rejected', async () => {
    const big = await setupPool({ users: ['alice'], start: MAX_RESERVE + 1n });
    await deposit(big, 'alice', A, MAX_RESERVE + 1n);
    await deposit(big, 'alice', B, 1_000_000n);
    await expectError(
      big.pool.actions.addliquidity(['alice', 1]).send('alice'),
      assertMsg('reserve limit exceeded'),
    );
    // Exactly MAX_RESERVE is fine.
    await big.pool.actions.withdrawdep(['alice']).send('alice');
    await addLiquidity(big, 'alice', MAX_RESERVE, 1_000_000n);
    assert.equal(poolState(big.pool).ra, MAX_RESERVE);
  });
});

// ====================================================================== swap
describe('pool: transfer with memo "swap:<min_out>"', () => {
  beforeEach(async () => {
    await addLiquidity(ctx, 'alice', 5_000_000n, 5_000_000n); // 500.0000 / 500.0000
  });

  it('A -> B pays out by the constant-product formula, rounded down', async () => {
    await swap(ctx, 'bob', A, 100_000n, 1);

    // 5_000_000 * 100_000 * 9970 / (5_000_000 * 10000 + 100_000 * 9970) = 97_750.9...
    assert.deepEqual(wallet(token, 'bob'), { a: START - 100_000n, b: START + 97_750n });
    const state = poolState(pool);
    assert.deepEqual([state.ra, state.rb], [5_100_000n, 4_902_250n]);
    assert.equal(state.total, 5_000_000n); // a swap never changes shares
    assert.deepEqual(wallet(token, 'pool'), { a: 5_100_000n, b: 4_902_250n });
  });

  it('B -> A works the same way in the other direction', async () => {
    await swap(ctx, 'bob', B, 100_000n, 97_750);
    assert.deepEqual(wallet(token, 'bob'), { a: START + 97_750n, b: START - 100_000n });
    const state = poolState(pool);
    assert.deepEqual([state.ra, state.rb], [4_902_250n, 5_100_000n]);
  });

  it('with a fee of 0 the product still does not decrease', async () => {
    const free = await setupPool({ fee: 0, start: START });
    await addLiquidity(free, 'alice', 5_000_000n, 5_000_000n);
    await swap(free, 'bob', A, 100_000n, 1);
    // 5_000_000 * 100_000 / 5_100_000 = 98_039.2...
    assert.equal(tokenBalance(free.token, 'bob', B), START + 98_039n);
    const state = poolState(free.pool);
    assert.ok(state.ra * state.rb >= 5_000_000n * 5_000_000n);
  });

  it('is rejected while the pool has no liquidity', async () => {
    const empty = await setupPool({ start: START });
    await expectError(swap(empty, 'bob', A, 100_000n, 1), assertMsg('pool has no liquidity'));
    assert.deepEqual(wallet(empty.token, 'bob'), { a: START, b: START });
  });

  it('is rejected when the output is below min_out', async () => {
    await expectError(swap(ctx, 'bob', A, 100_000n, 97_751), assertMsg('output is less than min_out'));
    assert.deepEqual(wallet(token, 'bob'), { a: START, b: START }); // the input came back
    await swap(ctx, 'bob', A, 100_000n, 97_750); // exactly the output: accepted
  });

  it('min_out = 0 is rejected: slippage protection cannot be switched off', async () => {
    await expectError(swap(ctx, 'bob', A, 100_000n, 0), assertMsg('min_out must be positive'));
    await expectError(swap(ctx, 'bob', A, 100_000n, '000'), assertMsg('min_out must be positive'));
  });

  it('a malformed swap memo is rejected', async () => {
    const bad = ['swap:', 'swap:-1', 'swap:+1', 'swap:1.5', 'swap: 1', 'swap:1 ', 'swap:1e3', 'swap:abc',
      'swap:0x10', 'swap:1,TKB', 'swap:1234567890123456789' /* 19 digits */];
    for (const memo of bad) {
      await expectError(
        token.actions.transfer(['bob', 'pool', tkn(100_000n, A), memo]).send('bob'),
        BAD_SWAP_MEMO,
      );
    }
    assert.deepEqual(wallet(token, 'bob'), { a: START, b: START });
  });

  it('an 18-digit min_out parses and is simply not reached', async () => {
    await expectError(
      swap(ctx, 'bob', A, 100_000n, '999999999999999999'),
      assertMsg('output is less than min_out'),
    );
  });

  it('a trade whose output rounds down to zero is rejected', async () => {
    // 1 unit in: 5_000_000 * 1 * 9970 / (5_000_000 * 10000 + 9970) = 0.99...
    await expectError(swap(ctx, 'bob', A, 1n, 1), assertMsg('output amount is zero'));
    // 2 units in -> 1.99 -> 1 unit out.
    await swap(ctx, 'bob', A, 2n, 1);
    assert.equal(tokenBalance(token, 'bob', B), START + 1n);
  });

  it('an input that would push the reserve above MAX_RESERVE is rejected', async () => {
    const big = await setupPool({ users: ['alice', 'bob'], start: MAX_RESERVE });
    await addLiquidity(big, 'alice', 5_000_000n, 5_000_000n);
    await expectError(
      swap(big, 'bob', A, MAX_RESERVE - 5_000_000n + 1n, 1),
      assertMsg('reserve limit exceeded'),
    );
    // The largest allowed input works and cannot empty the other reserve.
    await swap(big, 'bob', A, MAX_RESERVE - 5_000_000n, 1);
    const state = poolState(big.pool);
    assert.equal(state.ra, MAX_RESERVE);
    assert.ok(state.rb > 0n);
  });

  it('fails without eosio.code and changes nothing', async () => {
    // Same setup, but the pool account may not send inline actions.
    const chain = ctx.chain;
    const locked = deploy(chain, 'pool2', 'pool', { inline: false });
    await locked.actions.init([TOKEN_A, TOKEN_B, 30]).send('pool2');
    await token.actions.transfer(['alice', 'pool2', tkn(1_000_000n, A), 'deposit']).send('alice');
    await token.actions.transfer(['alice', 'pool2', tkn(1_000_000n, B), 'deposit']).send('alice');
    await locked.actions.addliquidity(['alice', 1]).send('alice');

    await assert.rejects(
      token.actions.transfer(['bob', 'pool2', tkn(100_000n, A), 'swap:1']).send('bob'),
    );
    assert.deepEqual(wallet(token, 'bob'), { a: START, b: START });
    const state = poolState(locked);
    assert.deepEqual([state.ra, state.rb], [1_000_000n, 1_000_000n]);
  });
});

// ============================================================== remliquidity
describe('pool: remliquidity', () => {
  beforeEach(async () => {
    await addLiquidity(ctx, 'alice', 4_000_000n, 1_000_000n); // total 2_000_000, alice 1_999_000
  });

  it('pays the proportional part of both reserves', async () => {
    await pool.actions.remliquidity(['alice', 500_000, tkn(1_000_000n, A), tkn(250_000n, B)]).send('alice');

    // 500_000 / 2_000_000 = a quarter of each reserve.
    assert.deepEqual(wallet(token, 'alice'), { a: START - 3_000_000n, b: START - 750_000n });
    assert.deepEqual(poolState(pool), { ra: 3_000_000n, rb: 750_000n, fee: 30n, total: 1_500_000n });
    assert.equal(sharesOf(pool, 'alice'), 1_499_000n);
  });

  it('payouts are rounded down', async () => {
    await swap(ctx, 'bob', A, 123_457n, 1);
    const before = poolState(pool);
    await pool.actions.remliquidity(['alice', 333_333, zero(A), zero(B)]).send('alice');
    const after = poolState(pool);

    assert.equal(before.ra - after.ra, (333_333n * before.ra) / before.total);
    assert.equal(before.rb - after.rb, (333_333n * before.rb) / before.total);
    // The pool keeps the fractions: what is left per share did not go down.
    assert.ok(after.ra * before.total >= before.ra * after.total);
    assert.ok(after.rb * before.total >= before.rb * after.total);
  });

  it('needs the owner', async () => {
    await expectError(
      pool.actions.remliquidity(['alice', 1000, zero(A), zero(B)]).send('bob'),
      missingAuth('alice'),
    );
  });

  it('zero and negative shares are rejected', async () => {
    for (const shares of [0, -1000]) {
      await expectError(
        pool.actions.remliquidity(['alice', shares, zero(A), zero(B)]).send('alice'),
        assertMsg('shares must be positive'),
      );
    }
    assert.equal(sharesOf(pool, 'alice'), 1_999_000n);
  });

  it('more shares than owned is rejected (the locked minimum is nobody\'s)', async () => {
    // alice minted 2_000_000 but owns only 1_999_000.
    await expectError(
      pool.actions.remliquidity(['alice', 1_999_001, zero(A), zero(B)]).send('alice'),
      assertMsg('not enough shares'),
    );
    // bob has no shares at all.
    await expectError(
      pool.actions.remliquidity(['bob', 1, zero(A), zero(B)]).send('bob'),
      assertMsg('not enough shares'),
    );
  });

  it('min_a / min_b protect the owner', async () => {
    await expectError(
      pool.actions.remliquidity(['alice', 500_000, tkn(1_000_001n, A), zero(B)]).send('alice'),
      assertMsg('output is less than min_a / min_b'),
    );
    await expectError(
      pool.actions.remliquidity(['alice', 500_000, zero(A), tkn(250_001n, B)]).send('alice'),
      assertMsg('output is less than min_a / min_b'),
    );
  });

  it('min_a / min_b with the wrong symbol, precision or sign are rejected', async () => {
    await expectError(
      pool.actions.remliquidity(['alice', 1000, zero(B), zero(A)]).send('alice'),
      assertMsg('min_a / min_b symbol mismatch'),
    );
    await expectError(
      pool.actions.remliquidity(['alice', 1000, `0.00 ${A}`, zero(B)]).send('alice'),
      assertMsg('min_a / min_b symbol mismatch'),
    );
    await expectError(
      pool.actions.remliquidity(['alice', 1000, tkn(-1n, A), zero(B)]).send('alice'),
      assertMsg('min_a and min_b must not be negative'),
    );
  });

  it('removing everything leaves MIN_LIQUIDITY locked in the pool forever', async () => {
    await pool.actions.remliquidity(['alice', 1_999_000, zero(A), zero(B)]).send('alice');

    assert.deepEqual(pool.tables.shares().getTableRows(), []); // row deleted
    // 1000 of 2_000_000 shares stay: 0.05% of each reserve.
    assert.deepEqual(poolState(pool), { ra: 2000n, rb: 500n, fee: 30n, total: MIN_LIQUIDITY });
    assert.deepEqual(wallet(token, 'alice'), { a: START - 2000n, b: START - 500n });
    assert.deepEqual(wallet(token, 'pool'), { a: 2000n, b: 500n });
  });
});

// =============================================================== withdrawdep
describe('pool: withdrawdep', () => {
  it('returns both pending deposits and deletes the row', async () => {
    await deposit(ctx, 'alice', A, 700n);
    await deposit(ctx, 'alice', B, 900n);
    await pool.actions.withdrawdep(['alice']).send('alice');

    assert.deepEqual(wallet(token, 'alice'), { a: START, b: START });
    assert.deepEqual(pool.tables.deposits().getTableRows(), []);
    assert.deepEqual(wallet(token, 'pool'), { a: 0n, b: 0n });
  });

  it('works with a deposit of only one token (the zero side is skipped)', async () => {
    await deposit(ctx, 'alice', B, 900n);
    await pool.actions.withdrawdep(['alice']).send('alice');
    assert.deepEqual(wallet(token, 'alice'), { a: START, b: START });
  });

  it('needs the owner', async () => {
    await deposit(ctx, 'alice', A, 700n);
    await expectError(pool.actions.withdrawdep(['alice']).send('bob'), missingAuth('alice'));
    assert.deepEqual(depositOf(pool, 'alice'), { a: 700n, b: 0n });
  });

  it('is rejected when there is nothing to withdraw', async () => {
    await expectError(
      pool.actions.withdrawdep(['alice']).send('alice'),
      assertMsg('no deposits to withdraw'),
    );
  });

  it('does not touch the reserves or other users\' deposits', async () => {
    await addLiquidity(ctx, 'alice', 1_000_000n, 1_000_000n);
    await deposit(ctx, 'alice', A, 111n);
    await deposit(ctx, 'bob', A, 222n);
    await pool.actions.withdrawdep(['bob']).send('bob');

    assert.deepEqual(depositOf(pool, 'alice'), { a: 111n, b: 0n });
    const state = poolState(pool);
    assert.deepEqual([state.ra, state.rb], [1_000_000n, 1_000_000n]);
    assert.deepEqual(wallet(token, 'pool'), { a: 1_000_111n, b: 1_000_000n });
  });
});
