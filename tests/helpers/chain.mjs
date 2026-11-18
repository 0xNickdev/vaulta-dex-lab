// Shared test helpers: a fresh emulated blockchain plus small readers for
// the contract tables. Everything here runs in the VeRT emulator
// (@vaulta/vert); nothing touches a real network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Blockchain, nameToBigInt } from '@vaulta/vert';

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build');

// All tests use one token symbol with 4 decimals: 1.0000 TKN = 10000 units.
export const SYMBOL = '4,TKN';
export const CODE = 'TKN';
const PRECISION = 4;

/** A new empty chain. Each test creates its own, so tests cannot affect each other. */
export function newChain() {
  return new Blockchain();
}

/**
 * Deploys build/<contract>/<contract>.wasm to `account`.
 * `inline: true` adds `<account>@eosio.code` to the account's active
 * permission, which a contract needs in order to send inline actions.
 */
export function deploy(chain, account, contract, { inline = true } = {}) {
  return chain.createAccount({
    name: account,
    wasm: readFileSync(path.join(BUILD_DIR, contract, `${contract}.wasm`)),
    abi: readFileSync(path.join(BUILD_DIR, contract, `${contract}.abi`), 'utf8'),
    enableInline: inline,
  });
}

/** 12345n -> "1.2345 TKN" (negative values supported for negative tests). */
export function tkn(units, code = CODE) {
  const n = BigInt(units);
  const abs = n < 0n ? -n : n;
  const whole = abs / 10n ** BigInt(PRECISION);
  const frac = String(abs % 10n ** BigInt(PRECISION)).padStart(PRECISION, '0');
  return `${n < 0n ? '-' : ''}${whole}.${frac} ${code}`;
}

/** "1.2345 TKN" -> 12345n */
export function units(assetString) {
  const [amount] = assetString.split(' ');
  return BigInt(amount.replace('.', ''));
}

/** Symbol code -> the uint64 used as table key/scope (same as symbol_code::raw() in C++). */
export function symbolCodeRaw(code) {
  let value = 0n;
  for (let i = code.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(code.charCodeAt(i));
  }
  return value;
}

/** Balance of `owner` in a token contract, in units. 0n when there is no row. */
export function tokenBalance(token, owner, code = CODE) {
  const row = token.tables.accounts(nameToBigInt(owner)).getTableRow(symbolCodeRaw(code));
  return row ? units(row.balance) : 0n;
}

/** True when `owner` has a balance row (even an empty one) in the token contract. */
export function hasTokenRow(token, owner, code = CODE) {
  return token.tables.accounts(nameToBigInt(owner)).getTableRow(symbolCodeRaw(code)) !== undefined;
}

/** The `stat` row of a token: { supply, max_supply, issuer } or undefined. */
export function tokenStat(token, code = CODE) {
  const raw = symbolCodeRaw(code);
  return token.tables.stat(raw).getTableRow(raw);
}

/** All vault balance rows of `owner`: [{ id, balance: { quantity, contract } }]. */
export function vaultRows(vault, owner) {
  return vault.tables.balances(nameToBigInt(owner)).getTableRows();
}

/** Vault balance of `owner` for one token (contract + symbol code), in units. */
export function vaultBalance(vault, owner, tokenContract = 'token', code = CODE) {
  const row = vaultRows(vault, owner).find(
    (r) => r.balance.contract === tokenContract && r.balance.quantity.endsWith(` ${code}`),
  );
  return row ? units(row.balance.quantity) : 0n;
}

/** Asserts that the transaction fails with exactly this error message. */
export async function expectError(promise, message) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.message, message);
    return true;
  });
}

/** How VeRT reports a failed `check(cond, "msg")` from C++. */
export const assertMsg = (msg) => `eosio_assert: ${msg}`;
/** How VeRT reports a failed `require_auth(account)`. */
export const missingAuth = (account) => `missing required authority ${account}`;
