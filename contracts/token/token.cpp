// token.cpp — a standard fungible token for Vaulta (Antelope).
//
// This is a re-implementation of the `eosio.token` logic from
// AntelopeIO/reference-contracts (MIT License,
// Copyright (c) 2021-2022 EOS Network Foundation (ENF) and its contributors,
// based upon EOSIO/eosio-contracts, Copyright (c) 2017-2019 block.one and
// its contributors):
// https://github.com/AntelopeIO/reference-contracts/tree/main/contracts/eosio.token
//
// The checks and error messages are kept the same as in the reference so that
// wallets and other contracts see the behaviour they expect. The actions
// `issuefixed` and `setmaxsupply` of the reference are left out to keep the
// lab small. The comments are new: they explain WHY each check exists.
//
// Data model (two tables):
//   stat     scope = symbol code   one row per token: supply, max_supply, issuer
//   accounts scope = owner account one row per token the owner holds: balance

#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>

#include <string>

using eosio::asset;
using eosio::check;
using eosio::name;
using eosio::same_payer;
using eosio::symbol;
using std::string;

class [[eosio::contract("token")]] token : public eosio::contract {
public:
   using contract::contract;

   // Registers a new token. Only the contract account itself may do this,
   // otherwise anyone could squat on symbols such as "EOS" or "USDT".
   [[eosio::action]]
   void create(const name& issuer, const asset& maximum_supply) {
      require_auth(get_self());

      auto sym = maximum_supply.symbol;
      // is_valid() rejects a malformed symbol and an amount outside
      // +/-(2^62 - 1). That bound is what keeps later additions from
      // overflowing int64.
      check(maximum_supply.is_valid(), "invalid supply");
      check(maximum_supply.amount > 0, "max-supply must be positive");

      stats statstable(get_self(), sym.code().raw());
      auto existing = statstable.find(sym.code().raw());
      // The key is the symbol CODE only ("TKN"), without precision, so
      // "4,TKN" and "8,TKN" cannot both exist in one contract.
      check(existing == statstable.end(), "token with symbol already exists");

      statstable.emplace(get_self(), [&](auto& s) {
         s.supply.symbol = maximum_supply.symbol; // amount starts at 0
         s.max_supply    = maximum_supply;
         s.issuer        = issuer;
      });
   }

   // Mints new tokens to the issuer. To give them to somebody else the issuer
   // then calls `transfer`.
   [[eosio::action]]
   void issue(const name& to, const asset& quantity, const string& memo) {
      auto sym = quantity.symbol;
      check(sym.is_valid(), "invalid symbol name");
      // Memo is stored in the blockchain history; the limit stops spam.
      check(memo.size() <= 256, "memo has more than 256 bytes");

      stats statstable(get_self(), sym.code().raw());
      auto existing = statstable.find(sym.code().raw());
      check(existing != statstable.end(), "token with symbol does not exist, create token before issue");
      const auto& st = *existing;
      check(to == st.issuer, "tokens can only be issued to issuer account");

      // The issuer is read from the table, never from an action argument:
      // an argument is chosen by the caller, the table row is not.
      require_auth(st.issuer);
      check(quantity.is_valid(), "invalid quantity");
      // Without this a negative "issue" would be a hidden burn, and a zero
      // one would be free spam.
      check(quantity.amount > 0, "must issue positive quantity");

      // Same code but different precision ("1.0 TKN" vs "1.0000 TKN") would
      // let the caller scale the amount by powers of ten.
      check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");
      // Supply cap. Written as a subtraction on purpose: `supply + quantity`
      // could overflow, `max_supply - supply` cannot (both are in range and
      // supply <= max_supply).
      check(quantity.amount <= st.max_supply.amount - st.supply.amount, "quantity exceeds available supply");

      statstable.modify(st, same_payer, [&](auto& s) {
         s.supply += quantity;
      });

      add_balance(st.issuer, quantity, st.issuer);
   }

   // Burns tokens held by the issuer and lowers the supply.
   [[eosio::action]]
   void retire(const asset& quantity, const string& memo) {
      auto sym = quantity.symbol;
      check(sym.is_valid(), "invalid symbol name");
      check(memo.size() <= 256, "memo has more than 256 bytes");

      stats statstable(get_self(), sym.code().raw());
      auto existing = statstable.find(sym.code().raw());
      check(existing != statstable.end(), "token with symbol does not exist");
      const auto& st = *existing;

      // Only the issuer may burn, and only from its own balance
      // (see sub_balance below), so nobody's tokens can be destroyed by
      // somebody else.
      require_auth(st.issuer);
      check(quantity.is_valid(), "invalid quantity");
      check(quantity.amount > 0, "must retire positive quantity");

      check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");

      statstable.modify(st, same_payer, [&](auto& s) {
         s.supply -= quantity;
      });

      sub_balance(st.issuer, quantity);
   }

   // Moves tokens between two accounts.
   [[eosio::action]]
   void transfer(const name& from, const name& to, const asset& quantity, const string& memo) {
      check(from != to, "cannot transfer to self");
      // The core check: only the owner of the tokens can move them.
      require_auth(from);
      // A typo in `to` would otherwise send tokens to an account nobody owns.
      check(is_account(to), "to account does not exist");
      auto sym = quantity.symbol.code();
      stats statstable(get_self(), sym.raw());
      const auto& st = statstable.get(sym.raw());

      // Notify both sides. If `from` or `to` is a contract, its
      // on_notify("*::transfer") handler runs with a copy of this action.
      // This is how the vault learns about a deposit.
      require_recipient(from);
      require_recipient(to);

      check(quantity.is_valid(), "invalid quantity");
      // A negative amount would move tokens in the opposite direction,
      // i.e. steal from `to`.
      check(quantity.amount > 0, "must transfer positive quantity");
      check(quantity.symbol == st.supply.symbol, "symbol precision mismatch");
      check(memo.size() <= 256, "memo has more than 256 bytes");

      // Who pays RAM for a new balance row of `to`? The receiver, if it
      // signed the transaction; otherwise the sender. A contract can bill RAM
      // only to an account that authorized the action.
      auto payer = has_auth(to) ? to : from;

      sub_balance(from, quantity);
      add_balance(to, quantity, payer);
   }

   // Creates an empty balance row for `owner`, paid by `ram_payer`.
   // Lets a receiver (or a service) pay the RAM instead of the first sender.
   [[eosio::action]]
   void open(const name& owner, const symbol& symbol, const name& ram_payer) {
      // The payer must agree to pay.
      require_auth(ram_payer);

      check(is_account(owner), "owner account does not exist");

      auto sym_code_raw = symbol.code().raw();
      stats statstable(get_self(), sym_code_raw);
      const auto& st = statstable.get(sym_code_raw, "symbol does not exist");
      // Otherwise a row with the wrong precision could be planted and later
      // balance arithmetic for that owner would be done in the wrong units.
      check(st.supply.symbol == symbol, "symbol precision mismatch");

      accounts acnts(get_self(), owner.value);
      auto it = acnts.find(sym_code_raw);
      if (it == acnts.end()) {
         acnts.emplace(ram_payer, [&](auto& a) {
            a.balance = asset{0, symbol};
         });
      }
   }

   // Deletes an empty balance row and frees its RAM.
   [[eosio::action]]
   void close(const name& owner, const symbol& symbol) {
      require_auth(owner);
      accounts acnts(get_self(), owner.value);
      auto it = acnts.find(symbol.code().raw());
      check(it != acnts.end(), "Balance row already deleted or never existed. Action won't have any effect.");
      // Erasing a non-empty row would destroy tokens without lowering the
      // supply, which breaks the invariant "sum of balances == supply".
      check(it->balance.amount == 0, "Cannot close because the balance is not zero.");
      acnts.erase(it);
   }

   // One balance per (owner, symbol code). The owner is the table scope.
   struct [[eosio::table]] account {
      asset balance;

      uint64_t primary_key() const { return balance.symbol.code().raw(); }
   };

   // One row per token. The symbol code is both the scope and the key.
   struct [[eosio::table]] currency_stats {
      asset supply;
      asset max_supply;
      name  issuer;

      uint64_t primary_key() const { return supply.symbol.code().raw(); }
   };

   typedef eosio::multi_index<"accounts"_n, account>      accounts;
   typedef eosio::multi_index<"stat"_n, currency_stats>   stats;

private:
   void sub_balance(const name& owner, const asset& value) {
      accounts from_acnts(get_self(), owner.value);

      const auto& from = from_acnts.get(value.symbol.code().raw(), "no balance object found");
      // Without this the balance would go negative: tokens out of thin air.
      check(from.balance.amount >= value.amount, "overdrawn balance");

      // The owner authorized the action, so it takes over the RAM of its row.
      // A row with balance 0 is kept on purpose (the reference does the same);
      // the owner frees it with `close`.
      from_acnts.modify(from, owner, [&](auto& a) {
         a.balance -= value;
      });
   }

   void add_balance(const name& owner, const asset& value, const name& ram_payer) {
      accounts to_acnts(get_self(), owner.value);
      auto to = to_acnts.find(value.symbol.code().raw());
      if (to == to_acnts.end()) {
         to_acnts.emplace(ram_payer, [&](auto& a) {
            a.balance = value;
         });
      } else {
         // `asset += asset` aborts on overflow and on different symbols, so
         // no manual overflow check is needed here.
         to_acnts.modify(to, same_payer, [&](auto& a) {
            a.balance += value;
         });
      }
   }
};
