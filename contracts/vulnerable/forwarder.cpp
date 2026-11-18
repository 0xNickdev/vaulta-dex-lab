// forwarder.cpp — TEST-ONLY attacker helper. NEVER DEPLOY THIS CONTRACT.
//
// Used by "attack B: forwarded notification" in tests/attacks.test.mjs.
//
// The attacker deploys this on his own account. When that account receives
// any token transfer, the contract passes the notification on to the account
// named in the memo. The forwarded copy still says
//   get_first_receiver() == <the real token contract>
// because a forwarded notification keeps its original sender. So a vault that
// checks only get_first_receiver(), and not `to`, takes it for a deposit.

#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>

#include <string>

class [[eosio::contract("forwarder")]] forwarder : public eosio::contract {
public:
   using contract::contract;

   // Does nothing. CDT generates no ABI for a contract without actions, and
   // the emulator needs an ABI to deploy the contract.
   [[eosio::action]]
   void noop() {}

   [[eosio::on_notify("*::transfer")]]
   void on_transfer(const eosio::name& from, const eosio::name& to,
                    const eosio::asset& quantity, const std::string& memo) {
      // Forward only transfers that came in to this account.
      if (to != get_self()) {
         return;
      }
      // The memo holds the victim's account name, e.g. "vault".
      require_recipient(eosio::name(memo));
   }
};
