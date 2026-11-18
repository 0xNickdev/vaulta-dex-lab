// Attack tests for the pool. Each attack is run twice:
//   - against the vulnerable variant: the attack SUCCEEDS (the stolen amount
//     is asserted concretely);
//   - against the safe pool: the same steps are REJECTED (exact error) or
//     are harmless (balances asserted).
//
// All amounts are in units: 10000 units = 1.0000 token.
//
// About ordering: on a real chain the attacker gets his transactions around
// the victim's by watching pending transactions. The emulator has no mempool,
// so the tests simply send the transactions in the attacker's order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tkn, expectError, assertMsg } from './helpers/chain.mjs';
import {
  setupPool, deposit, swap, addLiquidity, poolState, depositOf, sharesOf, wallet, A, B,
} from './helpers/pool.mjs';

const zero = (code) => tkn(0, code);

// ============================================================ Attack D
// Sandwich: no min_out, so the victim's swap executes at any price.
describe('attack D: sandwich (min_out)', () => {
  const LIQUIDITY = 10_000_000n;   // 1000.0000 of each token
  const VICTIM_IN = 1_000_000n;    // the victim sells 100.0000 TKA
  const FAIR_QUOTE = 906_610n;     // what the victim was quoted: 90.6610 TKB
  const MIN_OUT = 897_543n;        // the quote minus 1% slippage tolerance
  const ATTACKER_IN = 3_000_000n;  // the attacker front-runs with 300.0000 TKA

  async function setup(contract) {
    const ctx = await setupPool({ contract, users: ['lp', 'victim', 'attacker'], start: LIQUIDITY });
    await addLiquidity(ctx, 'lp', LIQUIDITY, LIQUIDITY);
    return ctx;
  }

  it('SUCCEEDS against pool_no_min_out: the victim is paid 40% less, the attacker profits', async () => {
    const ctx = await setup('pool_no_min_out');
    const { token } = ctx;

    // 1. Front-run: the attacker buys TKB first and pushes its price up.
    await swap(ctx, 'attacker', A, ATTACKER_IN, 1);
    const bought = wallet(token, 'attacker').b - LIQUIDITY;
    assert.equal(bought, 2_302_363n);

    // 2. The victim's swap. He asked for at least MIN_OUT, the vulnerable
    //    pool ignores that and pays far less.
    await swap(ctx, 'victim', A, VICTIM_IN, MIN_OUT);
    const victimGot = wallet(token, 'victim').b - LIQUIDITY;
    assert.equal(victimGot, 548_299n);              // 54.8299 TKB instead of 90.6610
    assert.ok(victimGot < MIN_OUT);
    assert.equal(FAIR_QUOTE - victimGot, 358_311n); // 35.8311 TKB lost

    // 3. Back-run: the attacker sells what he bought at the price the
    //    victim has just pushed up for him.
    await swap(ctx, 'attacker', B, bought, 1);

    const attacker = wallet(token, 'attacker');
    assert.equal(attacker.b, LIQUIDITY);              // all TKB sold back
    assert.equal(attacker.a - LIQUIDITY, 402_549n);   // +40.2549 TKA, fees already paid
  });

  it('REJECTED against the safe pool: the front-run victim swap reverts, the attacker loses fees', async () => {
    const ctx = await setup('pool');
    const { token } = ctx;

    await swap(ctx, 'attacker', A, ATTACKER_IN, 1);
    const bought = wallet(token, 'attacker').b - LIQUIDITY;

    // The same victim transaction now fails, and his tokens stay with him.
    await expectError(swap(ctx, 'victim', A, VICTIM_IN, MIN_OUT), assertMsg('output is less than min_out'));
    assert.deepEqual(wallet(token, 'victim'), { a: LIQUIDITY, b: LIQUIDITY });

    // The victim cannot be made to forget the limit either.
    await expectError(swap(ctx, 'victim', A, VICTIM_IN, 0), assertMsg('min_out must be positive'));

    // The attacker has to undo his own trade and pays the fee twice.
    await swap(ctx, 'attacker', B, bought, 1);
    const attacker = wallet(token, 'attacker');
    assert.equal(attacker.b, LIQUIDITY);
    assert.equal(attacker.a - LIQUIDITY, -13_845n); // -1.3845 TKA

    // Without the front-run the victim gets exactly his quote.
    const calm = await setup('pool');
    await swap(calm, 'victim', A, VICTIM_IN, MIN_OUT);
    assert.equal(wallet(calm.token, 'victim').b - LIQUIDITY, FAIR_QUOTE);
  });
});

// ============================================================ Attack E
// Output rounded up: dust trades are paid a whole unit they did not earn.
describe('attack E: rounding (output rounded up)', () => {
  // TKB is 100 times more valuable than TKA in this pool:
  // 10000.0000 TKA against 100.0000 TKB.
  const RESERVE_A = 100_000_000n;
  const RESERVE_B = 1_000_000n;
  const DUST_TRADES = 50;

  async function setup(contract) {
    const ctx = await setupPool({ contract, users: ['lp', 'attacker'], start: RESERVE_A });
    await addLiquidity(ctx, 'lp', RESERVE_A, RESERVE_B);
    return ctx;
  }

  it('SUCCEEDS against pool_round_up: 50 dust trades turn 0.0050 TKA into 0.4986 TKA', async () => {
    const ctx = await setup('pool_round_up');
    const { token, pool } = ctx;
    const productBefore = RESERVE_A * RESERVE_B;

    // 1 unit of TKA is worth 0.00997 units of TKB. Rounded UP that is one
    // whole unit of TKB: the attacker buys it 100 times too cheap.
    for (let i = 0; i < DUST_TRADES; i++) {
      await swap(ctx, 'attacker', A, 1n, 1);
      const state = poolState(pool);
      assert.ok(state.ra * state.rb < productBefore, 'the product must have dropped');
    }
    assert.deepEqual(wallet(token, 'attacker'), { a: RESERVE_A - 50n, b: RESERVE_A + 50n });

    // Sell the 50 units of TKB back at the real price.
    await swap(ctx, 'attacker', B, 50n, 1);

    const attacker = wallet(token, 'attacker');
    assert.equal(attacker.b, RESERVE_A);            // TKB position closed
    assert.equal(attacker.a - RESERVE_A, 4_936n);   // paid 50 units, received 4986

    // The liquidity providers paid for it: the pool is back at its original
    // TKB reserve but has 4936 units of TKA less.
    const state = poolState(pool);
    assert.deepEqual([state.ra, state.rb], [RESERVE_A - 4_936n, RESERVE_B]);
    assert.equal(productBefore - state.ra * state.rb, 4_936_000_000n);
  });

  it('REJECTED against the safe pool: a dust trade rounds down to zero and reverts', async () => {
    const ctx = await setup('pool');
    const { token, pool } = ctx;

    for (let i = 0; i < DUST_TRADES; i++) {
      await expectError(swap(ctx, 'attacker', A, 1n, 1), assertMsg('output amount is zero'));
    }
    assert.deepEqual(wallet(token, 'attacker'), { a: RESERVE_A, b: RESERVE_A });

    // The smallest trade that is accepted costs the attacker more than it
    // returns, and the product goes UP: 101 units of TKA buy 1 unit of TKB,
    // which sells for 99 units of TKA.
    await swap(ctx, 'attacker', A, 101n, 1);
    assert.equal(wallet(token, 'attacker').b, RESERVE_A + 1n);
    await swap(ctx, 'attacker', B, 1n, 1);
    assert.equal(wallet(token, 'attacker').a - RESERVE_A, -2n);

    const state = poolState(pool);
    assert.ok(state.ra * state.rb > RESERVE_A * RESERVE_B);
  });
});

// ============================================================ Attack F
// First depositor: no locked minimum + whole deposits swallowed by the pool.
describe('attack F: first depositor (minimum liquidity)', () => {
  const START = 100_000_000n;      // everybody starts with 10000.0000 of each token
  const VICTIM_IN = 19_999_999n;   // the victim adds 1999.9999 of each token

  it('SUCCEEDS against pool_no_min_liquidity: the victim loses 799.9999 of each token', async () => {
    const ctx = await setupPool({ contract: 'pool_no_min_liquidity', users: ['attacker', 'victim'], start: START });
    const { token, pool } = ctx;

    // 1. The attacker is first: 1 unit of each token -> 1 share, nothing locked.
    await addLiquidity(ctx, 'attacker', 1n, 1n);
    assert.deepEqual(poolState(pool), { ra: 1n, rb: 1n, fee: 30n, total: 1n });

    // 2. Inflation. Each deposit is far off the pool ratio; the pool mints
    //    shares for the small side only and swallows the big side whole.
    await addLiquidity(ctx, 'attacker', 1n, 19_999_999n);          // +1 share
    assert.deepEqual(poolState(pool), { ra: 2n, rb: 20_000_000n, fee: 30n, total: 2n });
    await addLiquidity(ctx, 'attacker', 39_999_998n, 20_000_000n); // +2 shares
    assert.deepEqual(poolState(pool), { ra: 40_000_000n, rb: 40_000_000n, fee: 30n, total: 4n });

    // The whole pool is 4 shares, all the attacker's; ONE share is now worth
    // 1000.0000 TKA + 1000.0000 TKB.
    assert.equal(sharesOf(pool, 'attacker'), 4n);
    const invested = START - wallet(token, 'attacker').a;
    assert.equal(invested, 40_000_000n);

    // 3. The victim adds 1999.9999 of each token: worth 1.99999995 shares,
    //    rounded down to 1. The pool keeps his whole deposit anyway.
    await addLiquidity(ctx, 'victim', VICTIM_IN, VICTIM_IN);
    assert.equal(sharesOf(pool, 'victim'), 1n);
    assert.deepEqual(depositOf(pool, 'victim'), { a: 0n, b: 0n });

    // 4. Everybody leaves.
    await pool.actions.remliquidity(['attacker', 4, zero(A), zero(B)]).send('attacker');
    await pool.actions.remliquidity(['victim', 1, zero(A), zero(B)]).send('victim');

    // The attacker holds 4 of 5 shares of a pool with 5999.9999 of each.
    assert.deepEqual(wallet(token, 'attacker'), { a: START + 7_999_999n, b: START + 7_999_999n });
    assert.deepEqual(wallet(token, 'victim'), { a: START - 7_999_999n, b: START - 7_999_999n });
  });

  it('REJECTED against the safe pool: the 1-unit first deposit fails, and the same deposits later are harmless', async () => {
    const ctx = await setupPool({ contract: 'pool', users: ['attacker', 'victim'], start: START });
    const { token, pool } = ctx;

    // 1. The attacker's opening move is refused: sqrt(1 * 1) = 1 share is
    //    not more than the locked minimum.
    await deposit(ctx, 'attacker', A, 1n);
    await deposit(ctx, 'attacker', B, 1n);
    await expectError(
      pool.actions.addliquidity(['attacker', 1]).send('attacker'),
      assertMsg('initial liquidity is too small'),
    );

    // The smallest first deposit that works: 1001 units of each. The
    // attacker gets 1 share; 1000 shares are locked and belong to nobody.
    await deposit(ctx, 'attacker', A, 1000n);
    await deposit(ctx, 'attacker', B, 1000n);
    await pool.actions.addliquidity(['attacker', 1]).send('attacker');
    assert.deepEqual(poolState(pool), { ra: 1001n, rb: 1001n, fee: 30n, total: 1001n });
    assert.equal(sharesOf(pool, 'attacker'), 1n);

    // 2. The same off-ratio deposits. The safe pool takes only what the
    //    minted shares cost; the rest stays the attacker's own deposit and
    //    does NOT inflate the reserves.
    await addLiquidity(ctx, 'attacker', 1n, 19_999_999n);
    assert.deepEqual(poolState(pool), { ra: 1002n, rb: 1002n, fee: 30n, total: 1002n });
    assert.deepEqual(depositOf(pool, 'attacker'), { a: 0n, b: 19_999_998n });

    await addLiquidity(ctx, 'attacker', 39_999_998n, 20_000_000n);
    // Shares are still worth exactly 1 unit of each token.
    assert.deepEqual(poolState(pool), { ra: 40_001_000n, rb: 40_001_000n, fee: 30n, total: 40_001_000n });
    assert.deepEqual(depositOf(pool, 'attacker'), { a: 0n, b: 0n });

    // 3. The victim gets one share per unit: nothing is rounded away.
    await addLiquidity(ctx, 'victim', VICTIM_IN, VICTIM_IN);
    assert.equal(sharesOf(pool, 'victim'), VICTIM_IN);

    // 4. Everybody leaves. The victim gets everything back; the attacker
    //    is out the 1000 units of each token that stay locked.
    await pool.actions.remliquidity(['attacker', sharesOf(pool, 'attacker').toString(), zero(A), zero(B)]).send('attacker');
    await pool.actions.remliquidity(['victim', sharesOf(pool, 'victim').toString(), zero(A), zero(B)]).send('victim');
    assert.deepEqual(wallet(token, 'victim'), { a: START, b: START });
    assert.deepEqual(wallet(token, 'attacker'), { a: START - 1000n, b: START - 1000n });
  });
});

// ============================================================ Attack G
// Reserves read from the real balance: pending deposits are sold as liquidity.
describe('attack G: reserves from balance (table reserves)', () => {
  const LIQUIDITY = 10_000_000n;      // the pool really has 1000.0000 / 1000.0000
  const VICTIM_DEPOSIT = 90_000_000n; // 9000.0000 TKB, pending
  const ATTACKER_IN = 10_000_000n;    // the attacker sells 1000.0000 TKA
  const FAIR_OUT = 4_992_488n;        // 499.2488 TKB: the price of the real reserves

  async function setup(contract) {
    const ctx = await setupPool({ contract, users: ['lp', 'victim', 'attacker'], start: 100_000_000n });
    await addLiquidity(ctx, 'lp', LIQUIDITY, LIQUIDITY);
    // The victim is half-way through adding liquidity: TKB is deposited,
    // TKA is not yet. The tokens sit on the pool account but are HIS.
    await deposit(ctx, 'victim', B, VICTIM_DEPOSIT);
    return ctx;
  }

  it('SUCCEEDS against pool_balance_reserves: the attacker is paid 4493.2399 TKB of the victim\'s deposit', async () => {
    const ctx = await setup('pool_balance_reserves');
    const { token, pool } = ctx;

    // The vulnerable pool prices the swap against 10000.0000 TKB (its real
    // balance) although only 1000.0000 TKB are liquidity.
    await swap(ctx, 'attacker', A, ATTACKER_IN, 1);

    const got = wallet(token, 'attacker').b - 100_000_000n;
    assert.equal(got, 49_924_887n);              // 4992.4887 TKB
    assert.equal(got - FAIR_OUT, 44_932_399n);   // 4493.2399 TKB more than the fair price
    assert.ok(got > LIQUIDITY, 'more than the pool\'s whole real TKB reserve');

    // The victim still has a deposit row for 9000.0000 TKB ...
    assert.deepEqual(depositOf(pool, 'victim'), { a: 0n, b: VICTIM_DEPOSIT });
    // ... but the pool no longer holds that much, so the refund fails.
    assert.equal(wallet(token, 'pool').b, 50_075_113n);
    await expectError(pool.actions.withdrawdep(['victim']).send('victim'), assertMsg('overdrawn balance'));
  });

  it('REJECTED against the safe pool: the same swap gets the fair price, the deposit is untouched', async () => {
    const ctx = await setup('pool');
    const { token, pool } = ctx;

    await swap(ctx, 'attacker', A, ATTACKER_IN, 1);
    assert.equal(wallet(token, 'attacker').b - 100_000_000n, FAIR_OUT);

    // The attacker cannot ask for the inflated amount either.
    await expectError(swap(ctx, 'attacker', A, ATTACKER_IN, 49_924_887), assertMsg('output is less than min_out'));

    // A plain "donation" cannot move the reserves at all: without a valid
    // memo the transfer is reverted.
    await expectError(
      token.actions.transfer(['attacker', 'pool', tkn(1_000_000n, B), '']).send('attacker'),
      assertMsg("unknown memo: use 'deposit' or 'swap:<min_out>'"),
    );

    // The victim takes his whole deposit back.
    await pool.actions.withdrawdep(['victim']).send('victim');
    assert.deepEqual(wallet(token, 'victim'), { a: 100_000_000n, b: 100_000_000n });

    // Reserves are exactly what the pool holds.
    const state = poolState(pool);
    assert.deepEqual(wallet(token, 'pool'), { a: state.ra, b: state.rb });
  });
});
