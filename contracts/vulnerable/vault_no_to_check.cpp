// vault_no_to_check.cpp — DELIBERATELY VULNERABLE. NEVER DEPLOY THIS CONTRACT.
//
// A copy of contracts/vault/vault.cpp with exactly one protection removed,
// used only by the attack tests in the VeRT emulator.
//
// BUG:    on_transfer() does not check `to == get_self()`.
// ATTACK: the attacker sends REAL tokens from his account to his own contract;
//         that contract forwards the notification to the vault with
//         require_recipient(). The vault receives nothing but credits a deposit,
//         which the attacker then withdraws from other users' tokens.
// FIX:    `if (to != get_self()) return;` in on_transfer().
// TEST:   tests/attacks.test.mjs, "attack B: forwarded notification"
//
// The place of the bug is marked with "BUG:" below. `diff` this file against
// contracts/vault/vault.cpp to see the whole difference.

#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>

#include <string>

using eosio::asset;
using eosio::check;
using eosio::extended_asset;
using eosio::name;
using eosio::same_payer;
using eosio::symbol;
using eosio::symbol_code;

class [[eosio::contract("vault_no_to_check")]] vault : public eosio::contract {
public:
   using contract::contract;

   // ---------------------------------------------------------------- admin

   // Adds a token to the allow-list: "symbol `sym` is accepted, but only
   // when it comes from the token contract `contract`".
   [[eosio::action]]
   void addtoken(const name& contract, const symbol& sym) {
      // Only the vault account itself. Otherwise an attacker would simply
      // allow-list his own fake token contract.
      require_auth(get_self());

      check(is_account(contract), "token contract account does not exist");
      check(sym.is_valid(), "invalid symbol");

      tokens_table tokens(get_self(), get_self().value);
      // One contract per symbol code. To point "TKN" at another contract the
      // admin must remove the old entry first, which makes the change explicit.
      check(tokens.find(sym.code().raw()) == tokens.end(), "symbol is already allow-listed");

      tokens.emplace(get_self(), [&](auto& row) {
         row.sym      = sym;
         row.contract = contract;
      });
   }

   // Removes a token from the allow-list. New deposits of it are rejected.
   // Existing balances are NOT touched and can still be withdrawn: withdraw()
   // does not look at the allow-list, so delisting never traps user funds.
   [[eosio::action]]
   void rmtoken(const symbol_code& code) {
      require_auth(get_self());

      tokens_table tokens(get_self(), get_self().value);
      auto it = tokens.find(code.raw());
      check(it != tokens.end(), "symbol is not allow-listed");
      tokens.erase(it);
   }

   // -------------------------------------------------------------- deposit

   // Runs when ANY contract executes an action named `transfer` and names the
   // vault as a recipient of the notification. The "*" means "any contract",
   // so everything in the arguments is attacker-controlled until checked.
   [[eosio::on_notify("*::transfer")]]
   void on_transfer(const name& from, const name& to, const asset& quantity, const std::string& memo) {
      // Our own payout from withdraw() also notifies us (we are `from`).
      // It is not a deposit, so ignore it.
      if (from == get_self()) {
         return;
      }

      // BUG: nobody checks that the tokens were sent TO the vault. The safe
      // vault has here:
      //   if (to != get_self()) { return; }
      // Without it a notification about a transfer between two other
      // accounts, forwarded to us with require_recipient(), counts as a
      // deposit.

      tokens_table tokens(get_self(), get_self().value);
      auto listed = tokens.find(quantity.symbol.code().raw());
      // Rejecting (instead of silently ignoring) reverts the whole transfer,
      // so a user cannot lose an unsupported token by sending it here.
      check(listed != tokens.end(), "token is not allow-listed");

      // get_first_receiver() is the contract that really executed `transfer`.
      // Anyone can deploy a contract with a token called "TKN" and transfer
      // it to us; the symbol alone proves nothing. Stops the "fake token"
      // attack.
      check(get_first_receiver() == listed->contract, "transfer is not from the allow-listed token contract");

      // The real token contract already validated the quantity, but this
      // handler must stay safe even if the admin allow-lists a sloppy token.
      check(quantity.symbol == listed->sym, "symbol precision mismatch");
      check(quantity.is_valid(), "invalid quantity");
      check(quantity.amount > 0, "deposit must be positive");

      add_balance(from, extended_asset{quantity, listed->contract});
   }

   // ------------------------------------------------------------- withdraw

   // Sends `quantity` from the owner's vault balance back to the owner.
   // `quantity` is an extended_asset: amount + symbol + token contract,
   // e.g. {"quantity": "1.0000 TKN", "contract": "token"}.
   [[eosio::action]]
   void withdraw(const name& owner, const extended_asset& quantity) {
      // Only the owner can take the owner's money. Stops the
      // "withdraw somebody else's balance" attack.
      require_auth(owner);

      check(quantity.quantity.is_valid(), "invalid quantity");
      // A negative amount would INCREASE the balance in sub_balance().
      check(quantity.quantity.amount > 0, "must withdraw positive quantity");

      // Update our own books first, pay second (checks-effects-interactions).
      sub_balance(owner, quantity);

      // The payout always goes to `owner`; there is no free `to` argument
      // that a phishing site could point somewhere else.
      eosio::action(
         eosio::permission_level{get_self(), "active"_n},
         quantity.contract,
         "transfer"_n,
         std::make_tuple(get_self(), owner, quantity.quantity, std::string("vault withdraw"))
      ).send();
   }

   // --------------------------------------------------------------- tables

   // Allow-list. Scope = the vault account, key = symbol code.
   struct [[eosio::table]] token_row {
      symbol sym;      // code + precision, e.g. "4,TKN"
      name   contract; // the only contract this symbol is accepted from

      uint64_t primary_key() const { return sym.code().raw(); }
   };
   typedef eosio::multi_index<"tokens"_n, token_row> tokens_table;

   // User balances. Scope = the user account.
   //
   // A balance is identified by token contract AND symbol code, never by the
   // symbol alone: "TKN" of contract A and "TKN" of contract B are different
   // tokens. That pair is 128 bits and a primary key is only 64, so the row
   // gets a plain counter as the primary key and the pair goes into a
   // secondary index.
   struct [[eosio::table]] balance_row {
      uint64_t       id;
      extended_asset balance; // quantity + token contract

      uint64_t  primary_key() const { return id; }
      uint128_t by_token() const { return token_key(balance.contract, balance.quantity.symbol.code()); }
   };
   typedef eosio::multi_index<
      "balances"_n, balance_row,
      eosio::indexed_by<"bytoken"_n, eosio::const_mem_fun<balance_row, uint128_t, &balance_row::by_token>>
   > balances_table;

   // High 64 bits: contract name. Low 64 bits: symbol code.
   static uint128_t token_key(const name& contract, const symbol_code& code) {
      return (static_cast<uint128_t>(contract.value) << 64) | code.raw();
   }

private:
   void add_balance(const name& owner, const extended_asset& value) {
      balances_table balances(get_self(), owner.value);
      auto by_token = balances.get_index<"bytoken"_n>();
      auto it = by_token.find(token_key(value.contract, value.quantity.symbol.code()));

      if (it == by_token.end()) {
         // RAM payer = the vault itself. This code runs inside a notification,
         // and the chain forbids a notified contract to bill RAM to anybody
         // else: the sender authorized the token contract, not us. The cost
         // of that choice is in docs/THREATS.md (dust deposits from many
         // accounts make the vault pay for many rows).
         balances.emplace(get_self(), [&](auto& row) {
            row.id      = balances.available_primary_key();
            row.balance = value;
         });
      } else {
         // `asset += asset` aborts on int64 overflow and on a symbol
         // mismatch, so the sum can never wrap around.
         by_token.modify(it, same_payer, [&](auto& row) {
            row.balance.quantity += value.quantity;
         });
      }
   }

   void sub_balance(const name& owner, const extended_asset& value) {
      balances_table balances(get_self(), owner.value);
      auto by_token = balances.get_index<"bytoken"_n>();
      auto it = by_token.find(token_key(value.contract, value.quantity.symbol.code()));

      check(it != by_token.end(), "no balance for this token");
      // Same code, other precision: "1 TKN" must not be read as "1.0000 TKN".
      check(it->balance.quantity.symbol == value.quantity.symbol, "symbol precision mismatch");
      // Without this the balance goes negative and the user is paid with
      // other users' deposits.
      check(it->balance.quantity.amount >= value.quantity.amount, "overdrawn balance");

      if (it->balance.quantity.amount == value.quantity.amount) {
         // Do not keep zero rows: the vault pays for their RAM, and an empty
         // row is useless to everyone.
         by_token.erase(it);
      } else {
         by_token.modify(it, same_payer, [&](auto& row) {
            row.balance.quantity -= value.quantity;
         });
      }
   }
};
