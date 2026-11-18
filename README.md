# vaulta-dex-lab

A learning lab: how to **write, test and attack** C++ smart contracts for Vaulta
(formerly EOS / Antelope).

This is not a product or a library. It is a small set of contracts (a token, a
vault and a two-token swap pool) that shows seven typical vulnerabilities and
the exact line of code that closes each one. Every attack is a working test: it
**succeeds** against the vulnerable version and is **rejected** by the safe one.

---

## What is inside

| Contract | File | Purpose |
|----------|------|---------|
| `token` | `contracts/token/token.cpp` | Standard token (like `eosio.token`): `create`, `issue`, `transfer`, `retire`, `open`, `close`. |
| `vault` | `contracts/vault/vault.cpp` | Safe vault: deposit by incoming transfer, withdrawal to the owner. |
| `vault_no_first_receiver` | `contracts/vulnerable/` | Vulnerable copy of vault: the `get_first_receiver()` check is removed. |
| `vault_no_to_check` | `contracts/vulnerable/` | Vulnerable copy of vault: the `to == get_self()` check is removed. |
| `vault_no_auth` | `contracts/vulnerable/` | Vulnerable copy of vault: `require_auth(owner)` is removed from `withdraw`. |
| `forwarder` | `contracts/vulnerable/` | Attacker's helper contract (tests only). |
| `pool` | `contracts/pool/pool.cpp` | Safe constant-product AMM pool for two tokens: swap, add / remove liquidity. |
| `pool_no_min_out` | `contracts/vulnerable/` | Vulnerable copy of pool: `min_out` is not enforced. |
| `pool_round_up` | `contracts/vulnerable/` | Vulnerable copy of pool: the swap output is rounded up. |
| `pool_no_min_liquidity` | `contracts/vulnerable/` | Vulnerable copy of pool: no locked minimum liquidity, whole deposits go into the reserves. |
| `pool_balance_reserves` | `contracts/vulnerable/` | Vulnerable copy of pool: reserves are read from the real token balance. |

> **Important:** everything in `contracts/vulnerable/` is broken on purpose and
> exists only for tests in the emulator. These contracts **must never be
> deployed anywhere**.

`token` is a re-implementation of the logic in
[AntelopeIO/reference-contracts](https://github.com/AntelopeIO/reference-contracts)
(`eosio.token`, MIT license; copyright 2021–2022 EOS Network Foundation and
contributors, based on EOSIO/eosio-contracts, copyright 2017–2019 block.one).
The checks and error messages are kept as in the original; comments were added
to explain **why** each check exists. Attribution is in the header of
`token.cpp`.

---

## Verified tool versions

Everything below was actually run (macOS, arm64).

| Tool | Version | Used for |
|------|---------|----------|
| Antelope CDT (`cdt-cpp`) | **4.1.1** | compiling contracts, inside Docker |
| Docker | 28.4.0 | running the compiler container |
| Node.js | **24.4.1** (≥ 20 required) | running tests |
| `@vaulta/vert` (VeRT emulator) | **2.1.1** | running contracts without a blockchain |
| `@wharfkit/antelope` | 1.2.0 (comes as a VeRT dependency) | serialization in tests |
| `fast-check` | **4.10.2** | property tests (invariants) |

Exact versions are pinned in `package.json` (`--save-exact`).

### Why compilation runs in Docker

CDT is published only for `amd64`, while this Mac is `arm64`. So `cdt-cpp` runs
in a container with `--platform linux/amd64` (Docker Desktop emulates it). The
tests, in contrast, run on the host in Node: the VeRT emulator does not need the
compiler, only the finished `.wasm` + `.abi` files.

---

## Build and test from a clean clone

You need **Docker Desktop** (running) and **Node.js ≥ 20**.

```bash
# 1. test dependencies
npm install

# 2. compile all contracts to build/<name>/<name>.wasm + .abi
#    If the compiler image does not exist yet, the script builds it from
#    docker/Dockerfile (ubuntu:22.04 + CDT 4.1.1). The first image build under
#    amd64 emulation is slow.
npm run build

# 3. run all tests (compiles nothing; if build/ is empty it fails with a clear
#    message)
npm test
```

If Docker is not running, `npm run build` says so. You can start it with:

```bash
open -a Docker   # then wait for the daemon to come up
```

You can supply your own compiler image through an environment variable:

```bash
CDT_IMAGE=<your-image-with-cdt-cpp> npm run build
```

Final `npm test` summary: **127 tests, 127 passed, 0 failed.**

---

## How the pool works

One contract account is one pool for one pair of tokens, A and B. There is no
router and no multi-pool logic.

| What | How | Notes |
|------|-----|-------|
| Configure | action `init(token_a, token_b, fee_bps)` | Pool account only, exactly once. A token is `{"sym": "4,TKA", "contract": "token"}`. Fee at most 100 basis points (1%). |
| Swap | token transfer to the pool, memo `swap:<min_out>` | `<min_out>` = 1 to 18 digits, the smallest acceptable output in the **smallest units** of the other token (`1.2345 TKB` → `12345`). Must be positive. The output is paid back in the same transaction. |
| Deposit | token transfer to the pool, memo `deposit` | Only recorded in the `deposits` table. Still the sender's money, not liquidity. |
| Add liquidity | action `addliquidity(owner, min_shares)` | Turns the owner's deposits into shares at the current pool ratio. Whatever does not fit the ratio **stays in `deposits`**. |
| Remove liquidity | action `remliquidity(owner, shares, min_a, min_b)` | Burns shares, pays out both tokens. |
| Take deposits back | action `withdrawdep(owner)` | Returns everything in the owner's `deposits` row. |

Any other memo **reverts the transfer**, so tokens sent with a typo come back.

Tables (all in the scope of the pool account):

- `pool`: one row. `reserve_a`, `reserve_b` (token contract + symbol + amount),
  `fee_bps`, `total_shares`.
- `deposits`: per owner, pending `a` and `b`.
- `shares`: per owner, liquidity shares. There is no separate LP token.

Design rules, each one commented at its line in `pool.cpp`:

- **Reserves are numbers in the table.** The pool never reads its own token
  balance: the balance also holds pending deposits, and anybody can change it.
- **Swap formula**
  `out = reserve_out * in * (10000 - fee) / (reserve_in * 10000 + in * (10000 - fee))`,
  computed in `uint128_t`, all multiplications before the one division.
- **Every division rounds in favour of the pool**: swap output, minted shares
  and liquidity payouts round down; the amount taken from a depositor rounds up.
- **Reserves are capped at 2^57 - 1 units** (`MAX_RESERVE`). `asset` allows
  2^62, but `reserve * amount * 10000` must fit in 128 bits, and
  2^57 · 2^57 · 2^14 = 2^128 is the largest size for which that is certain.
  2^57 units is about 14 trillion tokens at 4 decimals.
- **First deposit** mints `sqrt(a * b)` shares (integer square root written by
  hand, Newton's method) and locks `MIN_LIQUIDITY` = 1000 of them forever.
  **Later deposits** mint `min(a * S / Ra, b * S / Rb)`.
- **Checks, effects, interactions**: tables are updated before any inline
  payout.

Why liquidity is added in two steps: a pool needs both tokens at once, and a
notification handler sees only one transfer. A router contract would hide
that; this lab keeps the two steps visible instead.

---

## Security

Seven vulnerabilities. Each has a pair of tests: the attack **succeeds**
against the broken version and is **rejected** (or is harmless) on the safe
contract.

### Vault

| Attack | Vulnerable file | Test | Protecting line in `contracts/vault/vault.cpp` |
|--------|-----------------|------|------------------------------------------------|
| **A. Fake token.** The attacker deploys their own token contract with the same `TKN` symbol and "deposits" it. If the vault looks only at the symbol, it credits the deposit and the attacker withdraws the victim's **real** tokens. | `vulnerable/vault_no_first_receiver.cpp` | `attacks.test.mjs` → `attack A: fake token` | `check(get_first_receiver() == listed->contract, ...)` in `on_transfer` checks **which contract** actually executed `transfer`. |
| **B. Forwarded notification.** The attacker moves tokens between their own accounts; their forwarder contract relays the notification to the vault with `require_recipient`. `get_first_receiver()` is still the real token. | `vulnerable/vault_no_to_check.cpp` | `attacks.test.mjs` → `attack B: forwarded notification` | `if (to != get_self()) return;` in `on_transfer` credits only what was sent **to us**. |
| **C. Withdrawal without authorization.** `owner` is just an argument. Without a signature check anyone calls `withdraw(victim, attacker, amount)` and takes someone else's funds. | `vulnerable/vault_no_auth.cpp` | `attacks.test.mjs` → `attack C: withdraw without authorization` | `require_auth(owner);` is the first line of `withdraw`. |

### Pool

Tests are in `tests/pool.attacks.test.mjs`; amounts below are the ones the
tests assert.

| Attack | Vulnerable file | Test | Protecting line in `contracts/pool/pool.cpp` |
|--------|-----------------|------|----------------------------------------------|
| **D. Sandwich.** The attacker buys just before the victim's swap and sells just after it. Pool 1000 / 1000; the victim sells 100 TKA and was quoted 90.6610 TKB. Front-run by 300 TKA he receives **54.8299 TKB**; the attacker ends **+40.2549 TKA**. | `vulnerable/pool_no_min_out.cpp` | `attack D: sandwich` | `check(min_out > 0, ...)` and `check(out >= min_out, ...)` in `swap`. On the safe pool the victim's swap reverts with `output is less than min_out` and the attacker is left **-1.3845 TKA** (two fees). |
| **E. Rounding.** The output is rounded up, so a trade worth 0.00997 units is paid 1 unit. Pool 10000 TKA / 100 TKB: 50 one-unit trades and one sale turn 50 units of TKA into 4986 (**+0.4936 TKA**), and `reserve_a * reserve_b` drops every time. | `vulnerable/pool_round_up.cpp` | `attack E: rounding` | `return to_amount(numerator / denominator);` in `get_amount_out` (round down), plus `check(out > 0, "output amount is zero")`. On the safe pool every dust trade reverts. |
| **F. First depositor.** The attacker mints 1 share for 1 unit of each token, then makes two off-ratio deposits that mint 3 more shares while pushing 4000 of each token into the reserves. The victim's 1999.9999 of each rounds down to 1 share; the attacker leaves **+799.9999 of each token**, taken from the victim. | `vulnerable/pool_no_min_liquidity.cpp` | `attack F: first depositor` | `check(total > MIN_LIQUIDITY, ...)` / `shares = total - MIN_LIQUIDITY;` and `used_a = to_amount(mul_div_up(shares, ra, p->total_shares));` in `addliquidity`. On the safe pool the 1-unit first deposit fails with `initial liquidity is too small`, and the same deposits afterwards cost the victim nothing. |
| **G. Reserves from the balance.** A victim has 9000 TKB in `deposits`, not yet liquidity. The pool's real reserves are 1000 / 1000, but the vulnerable pool prices against its balance of 10000 TKB: for 1000 TKA the attacker gets **4992.4887 TKB instead of 499.2488**, and the victim's `withdrawdep` fails with `overdrawn balance`. | `vulnerable/pool_balance_reserves.cpp` | `attack G: reserves from balance` | `const int64_t reserve_in = in_side.quantity.amount;` / `reserve_out = out_side.quantity.amount;` in `swap` (the table, not the balance). |

Two honest notes about attack F:

- **The classic "donation" form does not apply to this design**, with or
  without the minimum liquidity. In Uniswap v2 the attacker inflates a share
  by transferring tokens straight to the pair. Here reserves are table
  numbers: a transfer with no valid memo is reverted, and a transfer with
  `deposit` remains the sender's own withdrawable deposit. The second half of
  attack G's safe test asserts exactly that.
- So `pool_no_min_liquidity.cpp` removes **two** protections, not one (both
  are marked `BUG:`): the locked minimum, and "take from the depositor only
  what the minted shares cost". The second one is what replaces the donation:
  it is how a bare Uniswap-v2 `mint` behaves when called without a router.
  In the safe pool the exact-cost rule is the main protection and
  `MIN_LIQUIDITY` is defence in depth (it also keeps one share cheap, so
  deposits are not forced into huge indivisible steps).

Things the pool protects that have no vulnerable copy (see the unit tests in
`tests/pool.test.mjs`): fake token contract, wrong symbol or precision,
forwarded notification, malformed or unknown memo, double `init`, fee above
the bound, burning more shares than owned, reserves above `MAX_RESERVE`.

`tests/pool.invariant.test.mjs` runs random sequences of all operations by
three users and checks after every step: (a) a swap never decreases
`reserve_a * reserve_b`; (b) reserves + pending deposits == the pool's real
balance in each token; (c) `total_shares` == users' shares + the locked
minimum; (d) the value of one share (`reserve_a * reserve_b / total_shares²`)
never decreases; (e) no tokens appear or vanish; (f) a rejected operation
changes nothing. At the end everybody exits and every exit must succeed.
`tests/pool.math.test.mjs` compares swap outputs and the square root with an
independent BigInt implementation, including reserves near the maximum.

The detailed threat model is in [`docs/THREATS.md`](docs/THREATS.md).

### Deploying the safe vault or pool (for reference; not done in this lab)

`withdraw` pays out with an **inline transfer** on behalf of `vault@active`. For
the network to allow that, the contract account must add `vault@eosio.code` to
its `active` permission:

```bash
cleos set account permission vault active --add-code
```

In tests the emulator does the same: the `deploy()` helper calls VeRT with
`enableInline: true` (which adds `<account>@eosio.code`). The test
`vault: withdraw → fails without eosio.code` shows that without this permission
the withdrawal fails and balances do not change. The pool needs the same
permission for its swap, `remliquidity` and `withdrawdep` payouts; the test
`pool: ... fails without eosio.code and changes nothing` shows it for a swap.

---

## Limitations

What is deliberately **not** done (this is a learning lab, not an exchange):

- **One pool per contract account, no router.** No multi-hop swaps, no
  "swap exact output", no separate LP token (shares cannot be transferred),
  no price oracle (TWAP), no protocol fee, no way to change the fee after
  `init`.
- **No gateway / bridge between chains.**
- **No automated audit tool** (no static analyzer, wasm fuzzing or formal
  verification): checks come only from hand-written tests and a manual
  attacker review.
- **No testnet or mainnet deployment.** Everything lives in the VeRT emulator on
  the host. There are no keys, secrets or network calls (other than downloading
  npm packages and the .deb when building the image).
- **The token is trimmed** compared with reference-contracts: no `issuefixed`
  or `setmaxsupply`, to keep the example small.

What **could not be verified by this test suite** (limits of the VeRT 2.1.1
emulator, not of the contracts):

- VeRT does not model **RAM, CPU and NET** as resources. So the "dust" attack
  (an attacker sends micro-deposits from thousands of accounts and the vault
  pays RAM for every row) cannot be shown by a test; it is only described in
  `docs/THREATS.md`. The RAM payer choice in the code is deliberate and
  commented (`add_balance` in `vault.cpp`).
- VeRT has no `linkauth`, and its `require_auth` accepts only `active`/`owner`.
  So scenarios with fine-grained custom permissions are not tested.
- VeRT has **no mempool, blocks or transaction ordering**. The sandwich
  (attack D) is simulated by sending the three transactions in the attacker's
  order from the test. How an attacker obtains that order on a real network
  (watching pending transactions, colluding with a block producer) is not
  modelled, and neither is "everything happens inside one block".
- Two defensive checks in the pool's `on_transfer` (`invalid quantity`,
  `amount must be positive`) and `output must be less than the reserve` in
  `swap` cannot be reached with the standard token contract, which rejects
  such transfers first, so no test triggers them.
- `asset` arithmetic overflow is covered by logic (`asset += asset` aborts on
  int64 overflow) but is not driven to a real overflow in a test: that would
  need amounts outside the valid symbol range, which are cut off earlier by
  `is_valid()`.

---

## Layout

```
contracts/
  token/token.cpp                     safe token (eosio.token)
  vault/vault.cpp                     safe vault
  pool/pool.cpp                       safe constant-product pool
  vulnerable/
    vault_no_first_receiver.cpp       vulnerability A
    vault_no_to_check.cpp             vulnerability B
    vault_no_auth.cpp                 vulnerability C
    forwarder.cpp                     attacker helper (tests only)
    pool_no_min_out.cpp               vulnerability D
    pool_round_up.cpp                 vulnerability E
    pool_no_min_liquidity.cpp         vulnerability F
    pool_balance_reserves.cpp         vulnerability G
tests/
  helpers/chain.mjs                   shared helpers on top of VeRT
  helpers/pool.mjs                    pool setup, table readers, BigInt reference math
  token.test.mjs                      token unit tests
  token.invariant.test.mjs            invariant: sum of balances == supply
  vault.test.mjs                      vault unit tests
  vault.invariant.test.mjs            invariant: sum of deposits == vault balance
  attacks.test.mjs                    three vault attacks x (succeeds on broken / rejected by safe)
  pool.test.mjs                       pool unit tests (every action and memo path)
  pool.attacks.test.mjs               four pool attacks x (succeeds on broken / rejected by safe)
  pool.invariant.test.mjs             pool invariants over random operation sequences
  pool.math.test.mjs                  swap output and sqrt against a BigInt reference
scripts/
  build.sh                            compile all contracts in Docker
  check-build.mjs                     check that build/ is ready (before npm test)
docker/Dockerfile                     compiler image: ubuntu 22.04 + CDT 4.1.1
docs/THREATS.md                       threat model (token + vault + pool)
```
