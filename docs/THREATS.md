# Threat model: token, vault and pool

A short threat model for the three contracts in this lab: `token`, `vault` and
`pool`. It covers only what is actually in the code; gateways, routers and
bridges are out of scope (they do not exist, see "Limitations" in the README).
Token and vault come first; the pool has its own section at the end.

---

## Assets (what we protect)

- **Token balances**: rows in the `accounts` table of the `token` contract.
  Whoever owns the row owns the tokens.
- **Total supply**: the row in the `stat` table. Invariant: the sum of all
  balances == supply.
- **Vault deposits**: rows in the `balances` table of the `vault` contract.
  Invariant: for every token the sum of deposits == the vault's balance in the
  token contract (the vault is always fully backed).
- **RAM of the vault account**: the vault pays for users' balance rows; this is
  a consumable resource and it is a target too.

## Actors

- **Issuer**: issues the token. Trusted within their own token (can issue and
  retire within the cap) but must have no power over other holders' balances.
- **User**: holds tokens, deposits and withdraws. Trusts only themselves.
- **Vault admin**: the vault contract account itself; maintains the token
  allow-list.
- **Attacker**: any account on the network. Can deploy contracts, send any
  transfers and sign transactions with their own key. **Cannot** forge someone
  else's signature.

## Trust boundaries

- The arguments of any action are chosen by the caller. They **must not** be
  trusted until a signature (`require_auth`) and/or table data has been checked.
- The `on_notify("*::transfer")` handler fires on a `transfer` of **any**
  contract. Until `from`, `to`, `get_first_receiver()` and the allow-list are
  checked, everything in the notification is under the attacker's control.
- A notification can be forwarded (`require_recipient`), so "I received a
  notification" does not mean "I received tokens".
- A contract can bill RAM only to an account that authorized the action. Inside
  a notification the vault cannot bill RAM to the sender.

---

## Threat → protection → test: token

| # | Threat | Protection in code | Test |
|---|--------|--------------------|------|
| T1 | A foreign account creates your token / squats the symbol | `require_auth(get_self())` in `create` | `token: create needs the contract account` |
| T2 | Someone other than the issuer issues tokens | `require_auth(st.issuer)`; the issuer is read from the table, not from an argument | `token: issue needs the issuer` |
| T3 | Transfer of someone else's tokens | `require_auth(from)` in `transfer` | `token: transfer needs the sender` |
| T4 | Negative or zero amount (hidden theft or spam) | `check(quantity.amount > 0, ...)` in issue/retire/transfer | `token: negative transfer is rejected`, `zero transfer is rejected` |
| T5 | Precision bypass: `1.0 TKN` instead of `1.0000 TKN` | `check(quantity.symbol == st.supply.symbol, ...)` | `token: transfer with the wrong precision is rejected` |
| T6 | Issuing above the cap | `check(quantity.amount <= max_supply - supply, ...)` (subtraction, so it cannot overflow) | `token: issue above the supply cap is rejected` |
| T7 | Balance going negative (tokens out of thin air) | `check(from.balance.amount >= value.amount, ...)` in `sub_balance` | `token: transfer more than the balance is rejected` |
| T8 | Overflow when adding balances | `asset += asset` aborts on int64 overflow | covered by the `token: invariant` test |
| T9 | `close` on a non-empty row destroys tokens and breaks supply | `check(it->balance.amount == 0, ...)` | `token: close of a non-empty balance is rejected` |
| T10 | An arbitrary sequence of operations breaks the invariant | all the checks above together | `token: invariant` (fast-check, sum of balances == supply) |

## Threat → protection → test: vault

| # | Threat | Protection in code | Test |
|---|--------|--------------------|------|
| V1 | **Fake token**: an attacker's contract with the same symbol "deposits" | `check(get_first_receiver() == listed->contract, ...)` in `on_transfer` | `attack A: fake token` (succeeds on the broken copy, rejected by the safe one) |
| V2 | **Forwarded notification**: a forwarder sends `require_recipient(vault)` on someone else's transfer | `if (to != get_self()) return;` in `on_transfer` | `attack B: forwarded notification` |
| V3 | **Withdrawing someone else's funds**: `withdraw(victim, ...)` without the victim's signature | `require_auth(owner)` in `withdraw` | `attack C: withdraw without authorization` |
| V4 | Deposit of a token that is not allowed (or a user losing tokens) | `check(listed != tokens.end(), ...)` reverts the whole transaction instead of silently ignoring it | `vault: a token that is not allow-listed is rejected` |
| V5 | "Symbol vs contract" confusion: `TKN` from two different contracts gets mixed | the balance key is the (contract, symbol) pair in the `by_token` secondary index | `vault: same symbol from two token contracts` |
| V6 | Overdrawing / negative amount | `check(amount > 0)` + `check(balance >= amount)` in `sub_balance` | `vault: zero and negative amounts are rejected`, `more than the balance is rejected` |
| V7 | Precision bypass on withdrawal: `30 TKN` read as `0.0030 TKN` | `check(symbol == value.symbol, ...)` in `sub_balance` | `vault: the wrong precision is rejected` |
| V8 | Withdrawal does not work without `eosio.code` → stuck funds | documented; inline transfer from `vault@active` | `vault: fails without eosio.code ...` |
| V9 | Zero-balance rows accumulate vault RAM | `sub_balance` erases the row when it reaches zero | `vault: withdrawing everything deletes the row` |
| V10 | Deposits and the vault's real balance drift apart | all the checks above | `vault: invariant` (sum of deposits == vault balance) |

---

## Residual risks (accepted deliberately)

- **Dust / RAM griefing.** A notification handler cannot bill RAM to the sender
  (the network forbids it), so the **vault itself** pays for a new balance row
  (`add_balance` in `vault.cpp`). An attacker can therefore send micro-deposits
  from many accounts and make the vault pay for RAM. In production this is
  closed with a minimum deposit amount, an "the user first `open`s their own
  row and pays for it" model, or a RAM deposit. It is **not implemented** here
  and **not covered** by a test: the VeRT 2.1.1 emulator does not model RAM.
  This is a stated limitation, not an oversight.
- **Trust in the allow-list admin.** The vault admin can add a bad token (for
  example with the wrong precision). The vault defends against that on input
  (`symbol precision mismatch`), but a fully malicious token contract in the
  allow-list is out of scope: adding a token requires
  `require_auth(get_self())`, so it is a trusted action.
- **Contract upgrade.** Replacing the vault/token code (via `setcode`) is not
  considered here; in production it is a separate trust boundary (who holds the
  keys of the contract account).

---

# Pool

`contracts/pool/pool.cpp`: one constant-product pool for two tokens.

## Assets (what we protect)

- **Reserves**: `reserve_a` and `reserve_b` in the `pool` table. They belong
  to the liquidity providers, in proportion to their shares.
- **Shares**: rows in the `shares` table, plus `total_shares`. A share is a
  claim on both reserves. Invariant: `total_shares` == sum of all rows +
  the locked `MIN_LIQUIDITY`.
- **Pending deposits**: rows in the `deposits` table. They belong to the
  depositor and are **not** liquidity.
- **Backing**: for each token, reserve + all pending deposits == the pool
  account's balance in the token contract.
- **The price a trader was promised**: the output of a swap must not be worse
  than the `min_out` the trader signed.
- **RAM of the pool account**: the pool pays for `deposits` rows.

## Actors

- **Pool admin**: the pool contract account. Calls `init` once.
- **Liquidity provider (LP)**: deposits both tokens, holds shares.
- **Trader**: swaps one token for the other.
- **Attacker**: any account. Can be a trader and an LP at once, can deploy
  contracts, can be the very first depositor, and (on a real network) can get
  his transactions placed immediately before and after a victim's.

## Trust boundaries specific to the pool

- **The memo is user input.** It selects the operation and carries a number.
  It is parsed strictly (exact match, exact prefix, digits only, length
  bound); anything else reverts.
- **The pool's real token balance is not trusted as state.** Anybody can
  increase it with a transfer, and it mixes reserves with other users'
  deposits. All pricing uses the table.
- **The price inside the pool is attacker-movable.** Whoever trades moves it.
  Each user protects himself with his own limit (`min_out`, `min_shares`,
  `min_a` / `min_b`); the pool only promises to honour that limit.
- **Payouts are inline transfers to an account the pool does not control.**
  The receiver may be a contract that reacts to the notification. All table
  updates therefore happen before the payout.
- **The two token contracts are trusted** to behave like the standard token
  (see residual risks). They are chosen by the admin in `init`.

## Threat → protection → test: pool

Unit tests are in `tests/pool.test.mjs`, attacks in
`tests/pool.attacks.test.mjs`.

| # | Threat | Protection in code | Test |
|---|--------|--------------------|------|
| P1 | **Sandwich**: the attacker trades right before and right after a victim's swap | `check(min_out > 0, ...)` and `check(out >= min_out, ...)` in `swap`; the limit is mandatory | `attack D: sandwich` |
| P2 | **Rounding in the trader's favour**: dust trades are paid more than they are worth | `get_amount_out` divides once, last, rounding down; `check(out > 0, ...)` | `attack E: rounding`; `pool: invariants` (a) |
| P3 | **First depositor / share inflation**: a share is made so expensive that a victim's deposit rounds down | `MIN_LIQUIDITY` locked on the first deposit; `addliquidity` takes only what the minted shares cost (`mul_div_up`), the rest stays in `deposits` | `attack F: first depositor` |
| P4 | **Pricing against the real balance**: pending deposits or donated tokens are treated as liquidity | reserves are read from and written to the `pool` table only | `attack G: reserves from balance` |
| P5 | Fake token contract with a pool token's symbol | `get_first_receiver() == reserve.contract && quantity.symbol == reserve.quantity.symbol` in `on_transfer` | `pool: a fake token contract with the right symbol is rejected` |
| P6 | Forwarded notification credited as a deposit or executed as a swap | `if (to != get_self()) return;` | `pool: a forwarded notification (to != pool) is ignored` |
| P7 | Wrong symbol or precision (`1.00 TKA` read as `0.0100 TKA`) | the full symbol (code + precision) is compared, not only the code | `pool: a third token ... is rejected`, `the wrong precision is rejected` |
| P8 | Tokens lost through a typo in the memo | unknown memo → `check(false, ...)`, the transfer reverts | `pool: an unknown memo reverts the transfer` |
| P9 | Memo number tricks: sign, spaces, overflow, `swap:0` | `parse_min_out`: 1 to 18 digits only; `min_out > 0` | `pool: a malformed swap memo is rejected`, `min_out = 0 is rejected` |
| P10 | Overflow in the swap math with large reserves | `uint128_t` intermediates; `MAX_RESERVE` = 2^57 - 1 enforced on every reserve increase; `to_amount` checks every narrowing | `pool math: near-maximum reserves`, `a reserve above MAX_RESERVE is rejected` |
| P11 | Division by zero on an empty pool | `check(total_shares > 0, "pool has no liquidity")` in `swap`; reserves can never be emptied because the locked shares cannot be burned | `pool: is rejected while the pool has no liquidity`; `pool: invariants` (reserves > 0) |
| P12 | Burning someone else's shares, or more than owned; taking someone else's deposit | `require_auth(owner)`; `check(sh->shares >= shares, ...)`; `check(shares > 0, ...)` | `pool: remliquidity needs the owner`, `more shares than owned is rejected`, `withdrawdep needs the owner`, "steal" steps in `pool: invariants` |
| P13 | Admin changes tokens or fee under existing liquidity; excessive fee | `init` works once; `fee_bps <= MAX_FEE_BPS` (1%) | `pool: init cannot be called twice`, `accepts a fee of 0 and of exactly 100 basis points, rejects 101` |
| P14 | Somebody else initializes the pool with his own token | `require_auth(get_self())` in `init` | `pool: init needs the pool account` |
| P15 | Re-entrancy through the payout notification | tables are updated before `pay()`; the pool's own outgoing transfers are ignored (`from == get_self()`) | covered by design; every payout test runs through this path |
| P16 | Deposits stuck in the pool | `withdrawdep` depends on nothing but the owner's row; a failed `addliquidity` leaves the deposit untouched | `pool: a deposit too small for one share is rejected and stays withdrawable`; full exit in `pool: invariants` |
| P17 | Any sequence of operations breaks backing, share accounting or share value | all of the above together | `pool: invariants` (fast-check) |

## Residual risks (accepted deliberately)

- **The pool price is not an oracle.** Anybody with enough tokens can move
  the price inside one transaction or one block and move it back, paying only
  the fee. A contract that reads `reserve_a / reserve_b` from this pool to
  value collateral or to settle anything can be robbed that way. The pool has
  no time-weighted price (TWAP) and must not be used as a price source.
- **Sandwich within the user's own tolerance.** `min_out` bounds the loss, it
  does not remove it: an attacker can still take whatever lies between the
  fair output and the user's limit. A user who sends `swap:1` has switched
  the protection off himself; the contract can force the limit to be present,
  not to be sensible. The same holds for `min_shares` in `addliquidity`.
- **Admin trust in `init`.** The admin picks the two token contracts and the
  fee, once. A malicious or broken token contract (one that can mint to
  itself, freeze transfers, charge a fee on transfer or change balances
  without a transfer) breaks the pool: the table reserves would no longer
  match what the pool holds. `init` also does not check the precision against
  the token contract; a wrong precision makes every transfer revert (nothing
  is lost, but the pool has to be redeployed).
- **Contract upgrade.** Whoever holds the pool account's keys can replace the
  code and take everything. Not addressed here.
- **Dust / RAM griefing.** As in the vault, a `deposits` row created inside a
  notification is paid for by the pool. Many accounts sending 1-unit deposits
  make the pool pay for many rows. A minimum deposit would close this; it is
  not implemented, and VeRT cannot show the cost. (`shares` rows are paid by
  their owner, who signs `addliquidity`.)
- **The first depositor chooses the price.** A first deposit at an absurd
  ratio is corrected by arbitrage at the depositor's expense, but until then
  the pool quotes that price. A first deposit that puts one reserve at
  `MAX_RESERVE` blocks further deposits and swaps in that direction until
  someone trades the other way.
- **Locked dust.** The reserves behind `MIN_LIQUIDITY` (at least 1000 units'
  worth, paid by the first depositor) and all rounding remainders stay in the
  pool forever. This is the price of the protection, not a leak.
- **Tokens that reach the pool without a `transfer` notification** (for
  example a token contract whose `issue` credits the pool directly) are not
  accounted for and cannot be recovered. Nobody else loses anything.
- **The pool account cannot receive any other token by transfer**: every
  incoming transfer of a token that is not A or B is reverted, by design.
- **LP risks that are not bugs**: impermanent loss, and no share transfer.
