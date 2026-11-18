# Threat model: token and vault

A short threat model for the two contracts in this lab, `token` and `vault`. It
covers only what is actually in the code; gateways, pools and bridges are out of
scope (they do not exist yet, see "Limitations" in the README).

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
