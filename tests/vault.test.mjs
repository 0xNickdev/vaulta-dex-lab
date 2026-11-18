// Unit tests for contracts/vault/vault.cpp (the safe vault).
// The attacks against it live in attacks.test.mjs.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  newChain, deploy, tkn, tokenBalance, vaultRows, vaultBalance,
  expectError, assertMsg, missingAuth, SYMBOL, CODE,
} from './helpers/chain.mjs';

let chain;
let token;
let vault;

/** withdraw() takes an extended_asset: quantity + token contract. */
const ext = (amount, contract = 'token') => ({ quantity: tkn(amount), contract });

// Fresh chain for every test:
//   token  - the real token contract, TKN allow-listed in the vault
//   alice  - holds 100.0000 TKN, bob holds 50.0000 TKN
beforeEach(async () => {
  chain = newChain();
  token = deploy(chain, 'token', 'token');
  vault = deploy(chain, 'vault', 'vault');
  chain.createAccounts('issuer', 'alice', 'bob');

  await token.actions.create(['issuer', tkn(10_000_000)]).send('token');
  await token.actions.issue(['issuer', tkn(1_500_000), '']).send('issuer');
  await token.actions.transfer(['issuer', 'alice', tkn(1_000_000), '']).send('issuer');
  await token.actions.transfer(['issuer', 'bob', tkn(500_000), '']).send('issuer');

  await vault.actions.addtoken(['token', SYMBOL]).send('vault');
});

describe('vault: allow-list (admin)', () => {
  it('addtoken stores the symbol and its contract', () => {
    assert.deepEqual(vault.tables.tokens().getTableRows(), [{ sym: SYMBOL, contract: 'token' }]);
  });

  it('addtoken needs the vault account', async () => {
    await expectError(
      vault.actions.addtoken(['token', '2,USD']).send('alice'),
      missingAuth('vault'),
    );
  });

  it('rmtoken needs the vault account', async () => {
    await expectError(vault.actions.rmtoken([CODE]).send('alice'), missingAuth('vault'));
  });

  it('the same symbol cannot be listed twice', async () => {
    await expectError(
      vault.actions.addtoken(['alice', SYMBOL]).send('vault'),
      assertMsg('symbol is already allow-listed'),
    );
  });

  it('a non-existent token contract cannot be listed', async () => {
    await expectError(
      vault.actions.addtoken(['nobody', '2,USD']).send('vault'),
      assertMsg('token contract account does not exist'),
    );
  });

  it('rmtoken of an unknown symbol is rejected', async () => {
    await expectError(
      vault.actions.rmtoken(['USD']).send('vault'),
      assertMsg('symbol is not allow-listed'),
    );
  });
});

describe('vault: deposit', () => {
  it('a transfer to the vault credits the sender', async () => {
    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');

    assert.deepEqual(vaultRows(vault, 'alice'), [
      { id: 0, balance: { quantity: tkn(300_000), contract: 'token' } },
    ]);
    assert.equal(tokenBalance(token, 'vault'), 300_000n);
    assert.equal(tokenBalance(token, 'alice'), 700_000n);
  });

  it('a second deposit adds to the same row', async () => {
    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');
    await token.actions.transfer(['alice', 'vault', tkn(1), '']).send('alice');

    assert.equal(vaultRows(vault, 'alice').length, 1);
    assert.equal(vaultBalance(vault, 'alice'), 300_001n);
  });

  it('balances of different users are separate', async () => {
    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');
    await token.actions.transfer(['bob', 'vault', tkn(50_000), '']).send('bob');

    assert.equal(vaultBalance(vault, 'alice'), 300_000n);
    assert.equal(vaultBalance(vault, 'bob'), 50_000n);
    assert.equal(tokenBalance(token, 'vault'), 350_000n);
  });

  it('the vault, not the depositor, pays RAM for the balance row', async () => {
    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');

    const rows = chain.getStorage().vault.balances.alice;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payer, 'vault');
  });

  it('a token that is not allow-listed is rejected and the transfer is reverted', async () => {
    await token.actions.create(['issuer', '1000.00 USD']).send('token');
    await token.actions.issue(['issuer', '1000.00 USD', '']).send('issuer');

    await expectError(
      token.actions.transfer(['issuer', 'vault', '10.00 USD', '']).send('issuer'),
      assertMsg('token is not allow-listed'),
    );
    // The whole transaction was rolled back: the sender keeps the tokens.
    assert.equal(tokenBalance(token, 'issuer', 'USD'), 100_000n);
    assert.equal(tokenBalance(token, 'vault', 'USD'), 0n);
  });

  it('after rmtoken new deposits are rejected', async () => {
    await vault.actions.rmtoken([CODE]).send('vault');
    await expectError(
      token.actions.transfer(['alice', 'vault', tkn(1), '']).send('alice'),
      assertMsg('token is not allow-listed'),
    );
  });

  it('a listing with the wrong precision rejects deposits instead of mis-crediting them', async () => {
    await vault.actions.rmtoken([CODE]).send('vault');
    await vault.actions.addtoken(['token', '2,TKN']).send('vault'); // admin mistake
    await expectError(
      token.actions.transfer(['alice', 'vault', tkn(1), '']).send('alice'),
      assertMsg('symbol precision mismatch'),
    );
  });
});

describe('vault: withdraw', () => {
  beforeEach(async () => {
    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');
  });

  it('pays the owner and lowers the vault balance', async () => {
    await vault.actions.withdraw(['alice', ext(100_000)]).send('alice');

    assert.equal(vaultBalance(vault, 'alice'), 200_000n);
    assert.equal(tokenBalance(token, 'alice'), 800_000n);
    assert.equal(tokenBalance(token, 'vault'), 200_000n);
  });

  it('withdrawing everything deletes the row (no zero-balance rows are left)', async () => {
    await vault.actions.withdraw(['alice', ext(300_000)]).send('alice');

    assert.deepEqual(vaultRows(vault, 'alice'), []);
    assert.equal(tokenBalance(token, 'alice'), 1_000_000n);
    assert.equal(tokenBalance(token, 'vault'), 0n);
  });

  it('needs the owner: bob cannot withdraw alice\'s balance', async () => {
    await expectError(
      vault.actions.withdraw(['alice', ext(100_000)]).send('bob'),
      missingAuth('alice'),
    );
    assert.equal(vaultBalance(vault, 'alice'), 300_000n);
  });

  it('more than the balance is rejected', async () => {
    await expectError(
      vault.actions.withdraw(['alice', ext(300_001)]).send('alice'),
      assertMsg('overdrawn balance'),
    );
  });

  it('a user cannot withdraw from another user\'s deposit', async () => {
    // bob has no vault balance; the vault holds only alice's tokens.
    await expectError(
      vault.actions.withdraw(['bob', ext(1)]).send('bob'),
      assertMsg('no balance for this token'),
    );
  });

  it('zero and negative amounts are rejected', async () => {
    await expectError(
      vault.actions.withdraw(['alice', ext(0)]).send('alice'),
      assertMsg('must withdraw positive quantity'),
    );
    await expectError(
      vault.actions.withdraw(['alice', ext(-100_000)]).send('alice'),
      assertMsg('must withdraw positive quantity'),
    );
    assert.equal(vaultBalance(vault, 'alice'), 300_000n);
  });

  it('the wrong precision is rejected', async () => {
    // "30 TKN" with 0 decimals is amount 30; it must not be read as 0.0030 TKN.
    await expectError(
      vault.actions.withdraw(['alice', { quantity: '30 TKN', contract: 'token' }]).send('alice'),
      assertMsg('symbol precision mismatch'),
    );
  });

  it('the right symbol with the wrong token contract is rejected', async () => {
    await expectError(
      vault.actions.withdraw(['alice', ext(1, 'bob')]).send('alice'),
      assertMsg('no balance for this token'),
    );
  });

  it('still works after the token was removed from the allow-list', async () => {
    await vault.actions.rmtoken([CODE]).send('vault');
    await vault.actions.withdraw(['alice', ext(300_000)]).send('alice');
    assert.equal(tokenBalance(token, 'alice'), 1_000_000n);
  });

  it('fails without eosio.code on the vault account, and nothing changes', async () => {
    // Same vault code on an account whose active permission does NOT include
    // <account>@eosio.code: the inline payout transfer is not authorized.
    const locked = deploy(chain, 'lockedvault', 'vault', { inline: false });
    await locked.actions.addtoken(['token', SYMBOL]).send('lockedvault');
    await token.actions.transfer(['bob', 'lockedvault', tkn(50_000), '']).send('bob');

    await assert.rejects(
      locked.actions.withdraw(['bob', ext(50_000)]).send('bob'),
      /^Error: Permission lockedvault@active is not satisfied by .*@eosio\.code$/,
    );
    assert.equal(vaultBalance(locked, 'bob'), 50_000n);
    assert.equal(tokenBalance(token, 'lockedvault'), 50_000n);
  });
});

describe('vault: same symbol from two token contracts', () => {
  it('balances are kept per token contract and paid out from the right one', async () => {
    // A second, independent token contract that also has a "TKN".
    const token2 = deploy(chain, 'token2', 'token');
    await token2.actions.create(['issuer', tkn(10_000_000)]).send('token2');
    await token2.actions.issue(['issuer', tkn(1_000_000), '']).send('issuer');
    await token2.actions.transfer(['issuer', 'alice', tkn(1_000_000), '']).send('issuer');

    await token.actions.transfer(['alice', 'vault', tkn(300_000), '']).send('alice');

    // The admin re-points "TKN" to token2.
    await vault.actions.rmtoken([CODE]).send('vault');
    await vault.actions.addtoken(['token2', SYMBOL]).send('vault');
    await token2.actions.transfer(['alice', 'vault', tkn(70_000), '']).send('alice');

    // Two rows: the old deposit is not mixed with the new one.
    assert.equal(vaultBalance(vault, 'alice', 'token'), 300_000n);
    assert.equal(vaultBalance(vault, 'alice', 'token2'), 70_000n);

    // alice cannot use her token2 balance to take more of the first token.
    await expectError(
      vault.actions.withdraw(['alice', ext(300_001, 'token')]).send('alice'),
      assertMsg('overdrawn balance'),
    );

    await vault.actions.withdraw(['alice', ext(300_000, 'token')]).send('alice');
    await vault.actions.withdraw(['alice', ext(70_000, 'token2')]).send('alice');
    assert.equal(tokenBalance(token, 'alice'), 1_000_000n);
    assert.equal(tokenBalance(token2, 'alice'), 1_000_000n);
    assert.deepEqual(vaultRows(vault, 'alice'), []);
  });
});
