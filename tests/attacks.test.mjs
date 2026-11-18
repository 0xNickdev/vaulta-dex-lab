// Attack tests. Each attack is run twice:
//   - against the vulnerable variant: the attack SUCCEEDS (assert the stolen
//     amount concretely);
//   - against the safe vault: the attack is REJECTED (assert the exact error,
//     or, where the safe vault silently ignores the notification, assert that
//     nothing changed).
//
// Every attack starts from the same setup: a victim deposits real tokens into
// a vault, and an attacker tries to walk away with them.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  newChain, deploy, tkn, tokenBalance, vaultBalance, vaultRows,
  expectError, assertMsg, missingAuth, SYMBOL,
} from './helpers/chain.mjs';

const ext = (amount, contract = 'token') => ({ quantity: tkn(amount), contract });

// Builds a chain with the real token, a `victim` who has deposited 100.0000
// TKN into `vaultName`, and an empty-handed `attacker`.
async function setup(vaultName, vaultContract) {
  const chain = newChain();
  const token = deploy(chain, 'token', 'token');
  const vault = deploy(chain, vaultName, vaultContract);
  chain.createAccounts('issuer', 'victim', 'attacker');

  await token.actions.create(['issuer', tkn(10_000_000)]).send('token');
  await token.actions.issue(['issuer', tkn(2_000_000), '']).send('issuer');
  await token.actions.transfer(['issuer', 'victim', tkn(1_000_000), '']).send('issuer');

  await vault.actions.addtoken(['token', SYMBOL]).send(vaultName);
  await token.actions.transfer(['victim', vaultName, tkn(1_000_000), '']).send('victim');

  return { chain, token, vault };
}

// ============================================================ Attack A
// A fake token contract with the same symbol credits a deposit.
describe('attack A: fake token (get_first_receiver)', () => {
  // The attacker deploys the SAME token code on his own account and makes a
  // "TKN" there. Deployed under a different account it is a different
  // contract, so get_first_receiver() would expose it.
  async function deployFakeToken(chain, token) {
    const fake = deploy(chain, 'attacker.tk', 'token');
    await fake.actions.create(['attacker', tkn(10_000_000)]).send('attacker.tk');
    await fake.actions.issue(['attacker', tkn(1_000_000), '']).send('attacker');
    return fake;
  }

  it('SUCCEEDS against vault_no_first_receiver: attacker drains the victim', async () => {
    const { chain, token, vault } = await setup('vault', 'vault_no_first_receiver');
    const fake = await deployFakeToken(chain, token);

    // The fake "TKN" is sent to the vault. The vulnerable vault checks only
    // the symbol, so it credits the attacker with 500.0000 TKN of REAL value.
    await fake.actions.transfer(['attacker', 'vault', tkn(500_000), '']).send('attacker');
    assert.equal(vaultBalance(vault, 'attacker'), 500_000n);

    // The attacker withdraws, and the vault pays out REAL tokens.
    await vault.actions.withdraw(['attacker', ext(500_000)]).send('attacker');

    assert.equal(tokenBalance(token, 'attacker'), 500_000n); // stolen from the victim's deposit
    assert.equal(tokenBalance(token, 'vault'), 500_000n);    // vault is now under-backed
    assert.ok(tokenBalance(token, 'vault') < vaultBalance(vault, 'victim'),
      'the victim can no longer be fully paid back');
  });

  it('REJECTED against the safe vault: the fake transfer is reverted', async () => {
    const { chain, token, vault } = await setup('vault', 'vault');
    const fake = await deployFakeToken(chain, token);

    // get_first_receiver() is attacker.tk, not the allow-listed `token`.
    await expectError(
      fake.actions.transfer(['attacker', 'vault', tkn(500_000), '']).send('attacker'),
      assertMsg('transfer is not from the allow-listed token contract'),
    );
    assert.equal(vaultBalance(vault, 'attacker'), 0n);
    assert.equal(tokenBalance(token, 'vault'), 1_000_000n); // still fully backs the victim
  });
});

// ============================================================ Attack B
// A forwarded notification credits a deposit.
describe('attack B: forwarded notification (to == get_self)', () => {
  it('SUCCEEDS against vault_no_to_check: attacker credits himself with no real deposit', async () => {
    const { chain, token, vault } = await setup('vault', 'vault_no_to_check');
    const fwd = deploy(chain, 'attacker.fw', 'forwarder');

    // The attacker transfers REAL tokens between his OWN accounts
    // (attacker -> attacker.fw). The forwarder passes the notification on to
    // the vault with the memo "vault". get_first_receiver() is still the real
    // token contract, and the vulnerable vault never checks that `to` is
    // itself, so it credits the attacker.
    await token.actions.transfer(['issuer', 'attacker', tkn(300_000), '']).send('issuer');
    await token.actions.transfer(['attacker', 'attacker.fw', tkn(300_000), 'vault']).send('attacker');

    // Credited 300.0000 TKN although the vault received nothing.
    assert.equal(vaultBalance(vault, 'attacker'), 300_000n);
    assert.equal(tokenBalance(token, 'attacker.fw'), 300_000n); // tokens sit on the attacker's own contract

    // The attacker withdraws from the VICTIM's real deposit.
    await vault.actions.withdraw(['attacker', ext(300_000)]).send('attacker');
    assert.equal(tokenBalance(token, 'attacker'), 300_000n);
    assert.equal(tokenBalance(token, 'vault'), 700_000n); // victim's deposit was raided
  });

  it('REJECTED against the safe vault: the forwarded notification is ignored', async () => {
    const { chain, token, vault } = await setup('vault', 'vault');
    const fwd = deploy(chain, 'attacker.fw', 'forwarder');
    await token.actions.transfer(['issuer', 'attacker', tkn(300_000), '']).send('issuer');

    // The safe vault silently ignores the notification (to != vault), so the
    // transfer itself succeeds but NO deposit is credited.
    await token.actions.transfer(['attacker', 'attacker.fw', tkn(300_000), 'vault']).send('attacker');

    assert.equal(vaultBalance(vault, 'attacker'), 0n);
    assert.deepEqual(vaultRows(vault, 'attacker'), []);
    assert.equal(tokenBalance(token, 'vault'), 1_000_000n); // untouched, still backs the victim

    // And the attacker cannot withdraw anything.
    await expectError(
      vault.actions.withdraw(['attacker', ext(1)]).send('attacker'),
      assertMsg('no balance for this token'),
    );
  });
});

// ============================================================ Attack C
// withdraw without require_auth(owner): anyone drains anyone.
describe('attack C: withdraw without authorization (require_auth)', () => {
  it('SUCCEEDS against vault_no_auth: attacker withdraws the victim\'s balance to himself', async () => {
    const { token, vault } = await setup('vault', 'vault_no_auth');

    // The vulnerable signature is withdraw(owner, to, quantity). The attacker
    // signs with his OWN key, names the victim as `owner` and himself as `to`.
    await vault.actions
      .withdraw(['victim', 'attacker', ext(1_000_000)])
      .send('attacker');

    assert.equal(tokenBalance(token, 'attacker'), 1_000_000n); // the whole deposit, stolen
    assert.equal(vaultBalance(vault, 'victim'), 0n);
    assert.equal(tokenBalance(token, 'vault'), 0n);
  });

  it('REJECTED against the safe vault: the thief has no authority over the owner', async () => {
    const { token, vault } = await setup('vault', 'vault');

    // The safe withdraw(owner, quantity) calls require_auth(owner); the
    // attacker's signature does not satisfy it.
    await expectError(
      vault.actions.withdraw(['victim', ext(1_000_000)]).send('attacker'),
      missingAuth('victim'),
    );
    assert.equal(tokenBalance(token, 'attacker'), 0n);
    assert.equal(vaultBalance(vault, 'victim'), 1_000_000n); // deposit intact
    assert.equal(tokenBalance(token, 'vault'), 1_000_000n);
  });
});
