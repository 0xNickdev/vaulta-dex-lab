// Shared helpers for the pool tests: a ready-made chain with two tokens and
// a pool, readers for the pool tables, and an independent BigInt reference
// implementation of the pool math.
import { nameToBigInt } from '@vaulta/vert';

import { newChain, deploy, tkn, units, tokenBalance } from './chain.mjs';

// The two pool tokens. Both live on the `token` contract and have 4
// decimals: 1.0000 TKA = 10000 units.
export const A = 'TKA';
export const B = 'TKB';
export const TOKEN_A = { sym: `4,${A}`, contract: 'token' };
export const TOKEN_B = { sym: `4,${B}`, contract: 'token' };

export const MIN_LIQUIDITY = 1000n;          // same as in pool.cpp
export const MAX_RESERVE = (1n << 57n) - 1n; // same as in pool.cpp
export const MAX_AMOUNT = (1n << 62n) - 1n;  // asset::max_amount

/**
 * A fresh chain with:
 *   token  - the token contract with TKA and TKB (max supply = asset::max_amount)
 *   pool   - build/<contract>, initialized with TKA/TKB and `fee` basis points
 *   users  - each holds `start` units of TKA and of TKB
 */
export async function setupPool({ contract = 'pool', fee = 30, users = ['alice', 'bob'], start = 10_000_000n, init = true } = {}) {
  const chain = newChain();
  const token = deploy(chain, 'token', 'token');
  const pool = deploy(chain, 'pool', contract);
  chain.createAccounts('issuer', ...users);

  for (const code of [A, B]) {
    await token.actions.create(['issuer', tkn(MAX_AMOUNT, code)]).send('token');
    await token.actions.issue(['issuer', tkn(BigInt(start) * BigInt(users.length), code), '']).send('issuer');
    for (const user of users) {
      await token.actions.transfer(['issuer', user, tkn(start, code), '']).send('issuer');
    }
  }
  if (init) {
    await pool.actions.init([TOKEN_A, TOKEN_B, fee]).send('pool');
  }
  return { chain, token, pool };
}

/** Sends `amount` units of `code` to the pool with the memo "deposit". */
export function deposit({ token }, user, code, amount) {
  return token.actions.transfer([user, 'pool', tkn(amount, code), 'deposit']).send(user);
}

/** Swaps `amount` units of `code` for the other token; `minOut` is in units. */
export function swap({ token }, user, code, amount, minOut) {
  return token.actions.transfer([user, 'pool', tkn(amount, code), `swap:${minOut}`]).send(user);
}

/** Deposits `a` TKA + `b` TKB and turns them into shares. */
export async function addLiquidity(ctx, user, a, b, minShares = 1) {
  await deposit(ctx, user, A, a);
  await deposit(ctx, user, B, b);
  await ctx.pool.actions.addliquidity([user, minShares]).send(user);
}

/** The pool row as BigInts: { ra, rb, fee, total }. Undefined before init. */
export function poolState(pool) {
  const row = pool.tables.pool().getTableRow(0n);
  if (!row) return undefined;
  return {
    ra: units(row.reserve_a.quantity),
    rb: units(row.reserve_b.quantity),
    fee: BigInt(row.fee_bps),
    total: BigInt(row.total_shares),
  };
}

/** Pending deposit of `owner` in units: { a, b } (zeros when there is no row). */
export function depositOf(pool, owner) {
  const row = pool.tables.deposits().getTableRow(nameToBigInt(owner));
  return row ? { a: units(row.a), b: units(row.b) } : { a: 0n, b: 0n };
}

/** Shares of `owner` (0n when there is no row). */
export function sharesOf(pool, owner) {
  const row = pool.tables.shares().getTableRow(nameToBigInt(owner));
  return row ? BigInt(row.shares) : 0n;
}

/** Wallet of `user`: { a, b } in units. */
export function wallet(token, user) {
  return { a: tokenBalance(token, user, A), b: tokenBalance(token, user, B) };
}

// ------------------------------------------------------- reference math
// Written independently of pool.cpp, with unbounded BigInt arithmetic, so it
// cannot overflow or round differently by accident.

/** Swap output: floor(y * dx * (10000 - fee) / (x * 10000 + dx * (10000 - fee))). */
export function refAmountOut(dx, x, y, fee) {
  const inAfterFee = BigInt(dx) * (10000n - BigInt(fee));
  return (BigInt(y) * inAfterFee) / (BigInt(x) * 10000n + inAfterFee);
}

/** Integer square root by binary search (deliberately NOT Newton's method). */
export function refSqrt(n) {
  let lo = 0n;
  let hi = 1n << 64n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid * mid <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
