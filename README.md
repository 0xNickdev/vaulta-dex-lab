# vaulta-dex-lab

A learning lab: how to **write, test and attack** C++ smart contracts for Vaulta
(formerly EOS / Antelope).

This is not a product or a library. It is a small set of contracts that shows
three typical vault vulnerabilities and the exact line of code that closes each
one. Every attack is a working test: it **successfully drains** the vulnerable
version and is **rejected** by the safe one.

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

Final `npm test` summary: **66 tests, 66 passed, 0 failed.**

---

## Security

Three vulnerabilities, one per file. Each has a pair of tests: the attack
**succeeds** against the broken version and is **rejected** by the real `vault`.

| Attack | Vulnerable file | Test | Protecting line in `contracts/vault/vault.cpp` |
|--------|-----------------|------|------------------------------------------------|
| **A. Fake token.** The attacker deploys their own token contract with the same `TKN` symbol and "deposits" it. If the vault looks only at the symbol, it credits the deposit and the attacker withdraws the victim's **real** tokens. | `vulnerable/vault_no_first_receiver.cpp` | `attacks.test.mjs` → `attack A: fake token` | `check(get_first_receiver() == listed->contract, ...)` in `on_transfer` checks **which contract** actually executed `transfer`. |
| **B. Forwarded notification.** The attacker moves tokens between their own accounts; their forwarder contract relays the notification to the vault with `require_recipient`. `get_first_receiver()` is still the real token. | `vulnerable/vault_no_to_check.cpp` | `attacks.test.mjs` → `attack B: forwarded notification` | `if (to != get_self()) return;` in `on_transfer` credits only what was sent **to us**. |
| **C. Withdrawal without authorization.** `owner` is just an argument. Without a signature check anyone calls `withdraw(victim, attacker, amount)` and takes someone else's funds. | `vulnerable/vault_no_auth.cpp` | `attacks.test.mjs` → `attack C: withdraw without authorization` | `require_auth(owner);` is the first line of `withdraw`. |

The detailed threat model for token and vault is in
[`docs/THREATS.md`](docs/THREATS.md).

### Deploying the safe vault (for reference; not done in this lab)

`withdraw` pays out with an **inline transfer** on behalf of `vault@active`. For
the network to allow that, the contract account must add `vault@eosio.code` to
its `active` permission:

```bash
cleos set account permission vault active --add-code
```

In tests the emulator does the same: the `deploy()` helper calls VeRT with
`enableInline: true` (which adds `<account>@eosio.code`). The test
`vault: withdraw → fails without eosio.code` shows that without this permission
the withdrawal fails and balances do not change.

---

## Limitations

What is deliberately **not** done (this is a learning lab, not an exchange):

- **No liquidity pool / swap (DEX) yet.** Despite the name there is no swap,
  price or AMM so far, only custody and withdrawal.
- **No gateway / bridge between chains.**
- **No automated audit** (no static analyzer, wasm fuzzing or formal
  verification): checks come only from hand-written tests.
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
  vulnerable/
    vault_no_first_receiver.cpp       vulnerability A
    vault_no_to_check.cpp             vulnerability B
    vault_no_auth.cpp                 vulnerability C
    forwarder.cpp                     attacker helper (tests only)
tests/
  helpers/chain.mjs                   shared helpers on top of VeRT
  token.test.mjs                      token unit tests
  token.invariant.test.mjs            invariant: sum of balances == supply
  vault.test.mjs                      vault unit tests
  vault.invariant.test.mjs            invariant: sum of deposits == vault balance
  attacks.test.mjs                    three attacks x (succeeds on broken / rejected by safe)
scripts/
  build.sh                            compile all contracts in Docker
  check-build.mjs                     check that build/ is ready (before npm test)
docker/Dockerfile                     compiler image: ubuntu 22.04 + CDT 4.1.1
docs/THREATS.md                       threat model (token + vault)
```
