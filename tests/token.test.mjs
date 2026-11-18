// Unit tests for contracts/token/token.cpp: every action once on the happy
// path, then the checks that must reject bad input.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  newChain, deploy, tkn, tokenBalance, hasTokenRow, tokenStat,
  expectError, assertMsg, missingAuth, SYMBOL,
} from './helpers/chain.mjs';

const MAX_SUPPLY = 1_000_000n; // 100.0000 TKN

let token;

// Fresh chain for every test: token created, 50.0000 TKN issued to alice.
beforeEach(async () => {
  const chain = newChain();
  token = deploy(chain, 'token', 'token');
  chain.createAccounts('alice', 'bob', 'carol');
  await token.actions.create(['alice', tkn(MAX_SUPPLY)]).send('token');
  await token.actions.issue(['alice', tkn(500_000), 'initial']).send('alice');
});

describe('token: happy path', () => {
  it('create stores supply 0, the cap and the issuer', async () => {
    await token.actions.create(['bob', '1000.00 USD']).send('token');
    assert.deepEqual(tokenStat(token, 'USD'), {
      supply: '0.00 USD', max_supply: '1000.00 USD', issuer: 'bob',
    });
  });

  it('issue credits the issuer and raises the supply', () => {
    assert.equal(tokenStat(token).supply, tkn(500_000));
    assert.equal(tokenBalance(token, 'alice'), 500_000n);
  });

  it('transfer moves tokens and keeps the supply', async () => {
    await token.actions.transfer(['alice', 'bob', tkn(120_000), 'hi']).send('alice');
    assert.equal(tokenBalance(token, 'alice'), 380_000n);
    assert.equal(tokenBalance(token, 'bob'), 120_000n);
    assert.equal(tokenStat(token).supply, tkn(500_000));
  });

  it('retire burns from the issuer and lowers the supply', async () => {
    await token.actions.retire([tkn(200_000), 'burn']).send('alice');
    assert.equal(tokenBalance(token, 'alice'), 300_000n);
    assert.equal(tokenStat(token).supply, tkn(300_000));
  });

  it('open creates an empty balance row, close removes it', async () => {
    assert.equal(hasTokenRow(token, 'bob'), false);
    await token.actions.open(['bob', SYMBOL, 'bob']).send('bob');
    assert.equal(hasTokenRow(token, 'bob'), true);
    assert.equal(tokenBalance(token, 'bob'), 0n);

    await token.actions.close(['bob', SYMBOL]).send('bob');
    assert.equal(hasTokenRow(token, 'bob'), false);
  });

  it('issue up to exactly the cap is allowed', async () => {
    await token.actions.issue(['alice', tkn(500_000), '']).send('alice');
    assert.equal(tokenStat(token).supply, tkn(MAX_SUPPLY));
  });
});

describe('token: authorization', () => {
  it('create needs the contract account', async () => {
    await expectError(
      token.actions.create(['bob', '1000.00 USD']).send('bob'),
      missingAuth('token'),
    );
  });

  it('issue needs the issuer', async () => {
    await expectError(
      token.actions.issue(['alice', tkn(1), '']).send('bob'),
      missingAuth('alice'),
    );
  });

  it('retire needs the issuer', async () => {
    await expectError(
      token.actions.retire([tkn(1), '']).send('bob'),
      missingAuth('alice'),
    );
  });

  it('transfer needs the sender: bob cannot move alice\'s tokens', async () => {
    await expectError(
      token.actions.transfer(['alice', 'bob', tkn(1), '']).send('bob'),
      missingAuth('alice'),
    );
    assert.equal(tokenBalance(token, 'alice'), 500_000n);
  });

  it('open needs the RAM payer', async () => {
    await expectError(
      token.actions.open(['bob', SYMBOL, 'alice']).send('bob'),
      missingAuth('alice'),
    );
  });

  it('close needs the owner', async () => {
    await token.actions.open(['bob', SYMBOL, 'bob']).send('bob');
    await expectError(
      token.actions.close(['bob', SYMBOL]).send('alice'),
      missingAuth('bob'),
    );
  });
});

describe('token: amounts', () => {
  it('transfer more than the balance is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'bob', tkn(500_001), '']).send('alice'),
      assertMsg('overdrawn balance'),
    );
  });

  it('transfer from an account without a balance row is rejected', async () => {
    await expectError(
      token.actions.transfer(['bob', 'alice', tkn(1), '']).send('bob'),
      assertMsg('no balance object found'),
    );
  });

  it('negative transfer is rejected (it would pull tokens from the receiver)', async () => {
    await token.actions.transfer(['alice', 'bob', tkn(10), '']).send('alice');
    await expectError(
      token.actions.transfer(['alice', 'bob', tkn(-10), '']).send('alice'),
      assertMsg('must transfer positive quantity'),
    );
    assert.equal(tokenBalance(token, 'bob'), 10n);
  });

  it('zero transfer is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'bob', tkn(0), '']).send('alice'),
      assertMsg('must transfer positive quantity'),
    );
  });

  it('negative and zero issue are rejected', async () => {
    await expectError(
      token.actions.issue(['alice', tkn(-1), '']).send('alice'),
      assertMsg('must issue positive quantity'),
    );
    await expectError(
      token.actions.issue(['alice', tkn(0), '']).send('alice'),
      assertMsg('must issue positive quantity'),
    );
  });

  it('negative and zero retire are rejected', async () => {
    await expectError(
      token.actions.retire([tkn(-1), '']).send('alice'),
      assertMsg('must retire positive quantity'),
    );
    await expectError(
      token.actions.retire([tkn(0), '']).send('alice'),
      assertMsg('must retire positive quantity'),
    );
  });

  it('issue above the supply cap is rejected', async () => {
    await expectError(
      token.actions.issue(['alice', tkn(500_001), '']).send('alice'),
      assertMsg('quantity exceeds available supply'),
    );
    assert.equal(tokenStat(token).supply, tkn(500_000));
  });

  it('retire more than the issuer holds is rejected', async () => {
    await token.actions.transfer(['alice', 'bob', tkn(400_000), '']).send('alice');
    await expectError(
      token.actions.retire([tkn(100_001), '']).send('alice'),
      assertMsg('overdrawn balance'),
    );
    assert.equal(tokenStat(token).supply, tkn(500_000));
  });

  it('create with zero or negative max supply is rejected', async () => {
    await expectError(
      token.actions.create(['bob', '0.00 USD']).send('token'),
      assertMsg('max-supply must be positive'),
    );
    await expectError(
      token.actions.create(['bob', '-1.00 USD']).send('token'),
      assertMsg('max-supply must be positive'),
    );
  });
});

describe('token: symbol and precision', () => {
  it('transfer of an unknown symbol is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'bob', '1.0000 FAKE', '']).send('alice'),
      assertMsg('unable to find key'),
    );
  });

  it('transfer with the wrong precision is rejected', async () => {
    // "1.00 TKN" has 2 decimals, the real token has 4.
    await expectError(
      token.actions.transfer(['alice', 'bob', '1.00 TKN', '']).send('alice'),
      assertMsg('symbol precision mismatch'),
    );
  });

  it('issue with the wrong precision is rejected', async () => {
    await expectError(
      token.actions.issue(['alice', '1 TKN', '']).send('alice'),
      assertMsg('symbol precision mismatch'),
    );
  });

  it('retire with the wrong precision is rejected', async () => {
    await expectError(
      token.actions.retire(['1.00000000 TKN', '']).send('alice'),
      assertMsg('symbol precision mismatch'),
    );
  });

  it('open with the wrong precision is rejected', async () => {
    await expectError(
      token.actions.open(['bob', '2,TKN', 'bob']).send('bob'),
      assertMsg('symbol precision mismatch'),
    );
  });

  it('the same symbol code cannot be created twice, even with another precision', async () => {
    await expectError(
      token.actions.create(['bob', '1000.00 TKN']).send('token'),
      assertMsg('token with symbol already exists'),
    );
  });

  it('issue of a token that was never created is rejected', async () => {
    await expectError(
      token.actions.issue(['alice', '1.00 USD', '']).send('alice'),
      assertMsg('token with symbol does not exist, create token before issue'),
    );
  });
});

describe('token: other rules', () => {
  it('transfer to self is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'alice', tkn(1), '']).send('alice'),
      assertMsg('cannot transfer to self'),
    );
  });

  it('transfer to a non-existent account is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'nobody', tkn(1), '']).send('alice'),
      assertMsg('to account does not exist'),
    );
  });

  it('issue to anyone but the issuer is rejected', async () => {
    await expectError(
      token.actions.issue(['bob', tkn(1), '']).send('alice'),
      assertMsg('tokens can only be issued to issuer account'),
    );
  });

  it('memo longer than 256 bytes is rejected', async () => {
    await expectError(
      token.actions.transfer(['alice', 'bob', tkn(1), 'x'.repeat(257)]).send('alice'),
      assertMsg('memo has more than 256 bytes'),
    );
  });

  it('close of a non-empty balance is rejected (it would destroy tokens)', async () => {
    await expectError(
      token.actions.close(['alice', SYMBOL]).send('alice'),
      assertMsg('Cannot close because the balance is not zero.'),
    );
  });

  it('a failed action changes nothing', async () => {
    const before = { alice: tokenBalance(token, 'alice'), supply: tokenStat(token).supply };
    await assert.rejects(token.actions.transfer(['alice', 'bob', tkn(999_999_999), '']).send('alice'));
    assert.equal(tokenBalance(token, 'alice'), before.alice);
    assert.equal(tokenBalance(token, 'bob'), 0n);
    assert.equal(tokenStat(token).supply, before.supply);
  });
});
