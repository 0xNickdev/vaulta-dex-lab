// pool.cpp — a minimal two-token constant-product AMM pool for Vaulta (Antelope).
//
// One contract account = one pool for one pair of tokens (A and B).
//
// How it is used:
//   1. The admin (the contract account itself) configures the pool once:
//        init(token_a, token_b, fee_bps)
//   2. Swap: a plain token transfer to the pool with the memo
//        swap:<min_out>
//      where <min_out> is the smallest acceptable output, as a whole number
//      of the smallest units of the OTHER token ("1.2345 TKB" = 12345).
//      The pool pays the output back to the sender in the same transaction.
//   3. Add liquidity, in two steps:
//        a) transfer token A and token B to the pool, each with the memo
//             deposit
//           (the pool only records them in the `deposits` table);
//        b) addliquidity(owner, min_shares) turns the deposits into pool
//           shares at the current pool ratio. What does not fit the ratio
//           stays in `deposits`.
//   4. remliquidity(owner, shares, min_a, min_b) burns shares and pays out
//      the matching part of both reserves.
//   5. withdrawdep(owner) returns deposits that were not turned into shares.
//
// Any other memo is rejected, which reverts the transfer: nobody can lose
// tokens by sending them here with a typo.
//
// The reserves are NUMBERS IN THE `pool` TABLE. The pool never looks at its
// real token balance: that balance also holds users' pending deposits, and
// anyone can change it with a transfer.
//
// Rounding rule: every division rounds in favour of the pool (payouts and
// minted shares round down, amounts taken from a depositor round up).
//
// Deployment note: payouts are inline `transfer`s signed as pool@active, so
// the pool account must add `pool@eosio.code` to its `active` permission.
//
// Invariants the tests check:
//   - reserve_a * reserve_b never decreases across a swap;
//   - reserves + all pending deposits == the pool's real token balance;
//   - total_shares == sum of users' shares + MIN_LIQUIDITY.

#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>

#include <string>

using eosio::asset;
using eosio::check;
using eosio::extended_asset;
using eosio::extended_symbol;
using eosio::name;
using eosio::same_payer;

class [[eosio::contract("pool")]] pool : public eosio::contract {
public:
   using contract::contract;

   // 10000 basis points = 100%. A fee of 30 means 0.30%.
   static constexpr int64_t BPS = 10000;

   // The admin cannot set a fee above 1%. Without a bound a careless or
   // malicious `init` could take (almost) the whole input of every swap.
   static constexpr uint16_t MAX_FEE_BPS = 100;

   // Shares that are minted on the first deposit but belong to nobody, so
   // they can never be burned (Uniswap v2 does the same). Total shares can
   // therefore never drop back to a handful of units, which is what the
   // "first depositor" share-inflation attack needs.
   static constexpr int64_t MIN_LIQUIDITY = 1000;

   // Upper bound for each reserve: 2^57 - 1 units.
   // Why: the swap formula multiplies reserve * amount * 10000. With both
   // factors below 2^57 that is below 2^57 * 2^57 * 2^14 = 2^128, so it
   // provably fits in uint128_t and can never wrap around.
   static constexpr int64_t MAX_RESERVE = (1LL << 57) - 1;

   // ---------------------------------------------------------------- admin

   // Configures the pool. Works exactly once.
   // A token is given as symbol + contract, e.g.
   //   {"sym": "4,TKA", "contract": "token"}
   [[eosio::action]]
   void init(const extended_symbol& token_a, const extended_symbol& token_b, uint16_t fee_bps) {
      // Only the pool account itself. Otherwise the first caller would pick
      // the tokens (for example his own fake token) and the fee.
      require_auth(get_self());

      pool_table pools(get_self(), get_self().value);
      // No second init: changing tokens or fee under existing liquidity
      // would let the admin re-price everybody's shares.
      check(pools.find(0) == pools.end(), "pool is already initialized");

      check(token_a.get_symbol().is_valid() && token_b.get_symbol().is_valid(), "invalid symbol");
      check(is_account(token_a.get_contract()) && is_account(token_b.get_contract()),
            "token contract account does not exist");
      // A token is contract + symbol code. The same code on two different
      // contracts is fine; the same code on the same contract is one token.
      check(token_a.get_contract() != token_b.get_contract() ||
            token_a.get_symbol().code() != token_b.get_symbol().code(),
            "the two tokens must be different");
      check(fee_bps <= MAX_FEE_BPS, "fee is above the maximum of 100 basis points");

      pools.emplace(get_self(), [&](auto& row) {
         row.reserve_a    = extended_asset(0, token_a);
         row.reserve_b    = extended_asset(0, token_b);
         row.fee_bps      = fee_bps;
         row.total_shares = 0;
      });
   }

   // ------------------------------------------------------ incoming tokens

   // Runs when ANY contract executes an action named `transfer` and names the
   // pool as a recipient of the notification. Everything in the arguments is
   // attacker-controlled until checked.
   [[eosio::on_notify("*::transfer")]]
   void on_transfer(const name& from, const name& to, const asset& quantity, const std::string& memo) {
      // Our own payouts also notify us (we are `from`). Not a deposit.
      if (from == get_self()) {
         return;
      }

      // The tokens must actually have been sent TO the pool. A notification
      // forwarded with require_recipient() has some other `to`. Stops the
      // "forwarded notification" attack.
      if (to != get_self()) {
         return;
      }

      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);
      check(p != pools.end(), "pool is not initialized");

      // get_first_receiver() is the contract that really executed `transfer`.
      // A token is accepted only when BOTH the contract and the full symbol
      // (code and precision) match the configuration. The symbol alone
      // proves nothing: anyone can deploy a contract with a token called
      // "TKA". Stops the "fake token" attack.
      const bool is_a = get_first_receiver() == p->reserve_a.contract &&
                        quantity.symbol == p->reserve_a.quantity.symbol;
      const bool is_b = get_first_receiver() == p->reserve_b.contract &&
                        quantity.symbol == p->reserve_b.quantity.symbol;
      // Rejecting (instead of ignoring) reverts the whole transfer, so a user
      // cannot lose an unsupported token by sending it here.
      check(is_a || is_b, "not a pool token: contract and symbol must match the pool configuration");

      // The real token contract already validated the quantity, but this
      // handler must stay safe even if the admin configured a sloppy token.
      check(quantity.is_valid(), "invalid quantity");
      check(quantity.amount > 0, "amount must be positive");

      // The memo selects the operation. Exact match or exact prefix only.
      if (memo == "deposit") {
         add_deposit(from, is_a, quantity);
      } else if (memo.rfind("swap:", 0) == 0) { // memo starts with "swap:"
         swap(from, is_a, quantity.amount, parse_min_out(memo));
      } else {
         // Reverting returns the tokens. Crediting an unknown memo to
         // "somebody" would be guessing with other people's money.
         check(false, "unknown memo: use 'deposit' or 'swap:<min_out>'");
      }
   }

   // ------------------------------------------------------------ liquidity

   // Turns the owner's pending deposits into pool shares.
   // `min_shares`: the smallest number of shares the owner accepts.
   [[eosio::action]]
   void addliquidity(const name& owner, int64_t min_shares) {
      // Only the owner decides when his deposits become liquidity.
      require_auth(owner);
      // Mandatory, so a caller cannot skip the protection by accident.
      check(min_shares > 0, "min_shares must be positive");

      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);
      check(p != pools.end(), "pool is not initialized");

      deposits_table deposits(get_self(), get_self().value);
      auto dep = deposits.find(owner.value);
      check(dep != deposits.end() && dep->a.amount > 0 && dep->b.amount > 0,
            "deposit both tokens first");

      const int64_t a  = dep->a.amount;
      const int64_t b  = dep->b.amount;
      const int64_t ra = p->reserve_a.quantity.amount;
      const int64_t rb = p->reserve_b.quantity.amount;

      int64_t shares; // credited to the owner
      int64_t minted; // added to total_shares
      int64_t used_a; // moved from the deposit into the reserves
      int64_t used_b;

      if (p->total_shares == 0) {
         // First deposit: the depositor sets the price, everything is used.
         // shares = sqrt(a * b). a, b <= 2^62, so a * b fits in uint128_t.
         const int64_t total = isqrt(static_cast<uint128_t>(a) * b);
         // MIN_LIQUIDITY shares are locked forever (see the constant).
         check(total > MIN_LIQUIDITY, "initial liquidity is too small");
         shares = total - MIN_LIQUIDITY;
         minted = total;
         used_a = a;
         used_b = b;
      } else {
         // Later deposits get shares in proportion to what they add,
         // measured by the token of which they bring LESS (so nobody is
         // paid for the excess). Rounded down: in favour of the pool.
         // ra, rb > 0 here because total_shares > 0 (no division by zero).
         const uint128_t by_a = mul_div(a, p->total_shares, ra);
         const uint128_t by_b = mul_div(b, p->total_shares, rb);
         shares = to_amount(by_a < by_b ? by_a : by_b);
         check(shares > 0, "deposit is too small to mint a share");
         minted = shares;

         // Take exactly what these shares cost, rounded UP (in favour of the
         // pool); the rest stays in the owner's deposit and is NOT donated
         // to the pool. used <= deposit always holds: shares <= a * S / ra
         // means shares * ra / S <= a, and `a` is a whole number.
         used_a = to_amount(mul_div_up(shares, ra, p->total_shares));
         used_b = to_amount(mul_div_up(shares, rb, p->total_shares));
      }

      // The owner's slippage limit: the pool ratio may have moved between
      // signing and execution.
      check(shares >= min_shares, "shares are less than min_shares");
      // Keeps the swap math inside 128 bits (see MAX_RESERVE).
      check(ra + used_a <= MAX_RESERVE && rb + used_b <= MAX_RESERVE, "reserve limit exceeded");

      pools.modify(p, same_payer, [&](auto& row) {
         row.reserve_a.quantity.amount += used_a;
         row.reserve_b.quantity.amount += used_b;
         row.total_shares              += minted;
      });

      if (dep->a.amount == used_a && dep->b.amount == used_b) {
         deposits.erase(dep); // no empty rows
      } else {
         deposits.modify(dep, same_payer, [&](auto& row) {
            row.a.amount -= used_a;
            row.b.amount -= used_b;
         });
      }

      shares_table shares_tbl(get_self(), get_self().value);
      auto sh = shares_tbl.find(owner.value);
      if (sh == shares_tbl.end()) {
         // The owner signed this action, so the owner pays for his own row.
         shares_tbl.emplace(owner, [&](auto& row) {
            row.owner  = owner;
            row.shares = shares;
         });
      } else {
         shares_tbl.modify(sh, same_payer, [&](auto& row) {
            row.shares += shares;
         });
      }
   }

   // Burns `shares` of the owner and pays out the matching part of both
   // reserves. `min_a` / `min_b` are the smallest payouts the owner accepts;
   // zero is allowed here (unlike min_out in a swap): the owner always gets
   // his exact proportion of both reserves, and the limits only pin down the
   // mix of A and B.
   [[eosio::action]]
   void remliquidity(const name& owner, int64_t shares, const asset& min_a, const asset& min_b) {
      // Only the owner can burn the owner's shares.
      require_auth(owner);
      // A negative number would INCREASE the owner's shares below.
      check(shares > 0, "shares must be positive");

      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);
      check(p != pools.end(), "pool is not initialized");

      // "5 TKA" must not be read as "0.0005 TKA".
      check(min_a.symbol == p->reserve_a.quantity.symbol && min_b.symbol == p->reserve_b.quantity.symbol,
            "min_a / min_b symbol mismatch");
      check(min_a.amount >= 0 && min_b.amount >= 0, "min_a and min_b must not be negative");

      shares_table shares_tbl(get_self(), get_self().value);
      auto sh = shares_tbl.find(owner.value);
      // Without this the balance goes negative and the owner is paid with
      // other providers' liquidity.
      check(sh != shares_tbl.end() && sh->shares >= shares, "not enough shares");

      // out = shares * reserve / total_shares, rounded down (in favour of
      // the pool). total_shares > 0 because the owner holds shares.
      // The owner never holds the locked MIN_LIQUIDITY, so out < reserve
      // and a reserve can never be emptied.
      const int64_t out_a = to_amount(mul_div(shares, p->reserve_a.quantity.amount, p->total_shares));
      const int64_t out_b = to_amount(mul_div(shares, p->reserve_b.quantity.amount, p->total_shares));
      check(out_a >= min_a.amount && out_b >= min_b.amount, "output is less than min_a / min_b");

      // Update our own books first, pay second (checks-effects-interactions).
      pools.modify(p, same_payer, [&](auto& row) {
         row.reserve_a.quantity.amount -= out_a;
         row.reserve_b.quantity.amount -= out_b;
         row.total_shares              -= shares;
      });
      if (sh->shares == shares) {
         shares_tbl.erase(sh);
      } else {
         shares_tbl.modify(sh, same_payer, [&](auto& row) {
            row.shares -= shares;
         });
      }

      // Payouts always go to `owner`; there is no free `to` argument.
      pay(owner, extended_asset(out_a, p->reserve_a.get_extended_symbol()), "pool remove liquidity");
      pay(owner, extended_asset(out_b, p->reserve_b.get_extended_symbol()), "pool remove liquidity");
   }

   // Returns the owner's pending deposits (both tokens, everything).
   // Does not depend on the pool state, so deposits can never get stuck.
   [[eosio::action]]
   void withdrawdep(const name& owner) {
      // Only the owner can take the owner's deposits.
      require_auth(owner);

      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);
      check(p != pools.end(), "pool is not initialized");

      deposits_table deposits(get_self(), get_self().value);
      auto dep = deposits.find(owner.value);
      check(dep != deposits.end(), "no deposits to withdraw");

      const asset a = dep->a;
      const asset b = dep->b;
      // Erase first, pay second (checks-effects-interactions).
      deposits.erase(dep);

      pay(owner, extended_asset(a, p->reserve_a.contract), "pool withdraw deposit");
      pay(owner, extended_asset(b, p->reserve_b.contract), "pool withdraw deposit");
   }

   // --------------------------------------------------------------- tables

   // The whole pool state: one row with primary key 0.
   // Scope = the pool account.
   struct [[eosio::table]] pool_row {
      extended_asset reserve_a;    // token A: contract + symbol + reserve
      extended_asset reserve_b;    // token B: contract + symbol + reserve
      uint16_t       fee_bps;      // swap fee in basis points, stays in the pool
      int64_t        total_shares; // all users' shares + the locked MIN_LIQUIDITY

      uint64_t primary_key() const { return 0; }
   };
   typedef eosio::multi_index<"pool"_n, pool_row> pool_table;

   // Tokens sent with the memo "deposit" and not yet turned into shares.
   // They belong to `owner`, NOT to the pool: they are not part of the
   // reserves. Scope = the pool account, key = owner.
   struct [[eosio::table]] deposit_row {
      name  owner;
      asset a;
      asset b;

      uint64_t primary_key() const { return owner.value; }
   };
   typedef eosio::multi_index<"deposits"_n, deposit_row> deposits_table;

   // Liquidity provider shares. Scope = the pool account, key = owner.
   // The locked MIN_LIQUIDITY has no row: nobody owns it.
   struct [[eosio::table]] share_row {
      name    owner;
      int64_t shares;

      uint64_t primary_key() const { return owner.value; }
   };
   typedef eosio::multi_index<"shares"_n, share_row> shares_table;

   // ----------------------------------------------------------------- math

   // Output of a swap, constant-product formula with the fee taken from the
   // input:
   //
   //                 reserve_out * amount_in * (10000 - fee)
   //   out = -------------------------------------------------------
   //          reserve_in * 10000 + amount_in * (10000 - fee)
   //
   // - All intermediate values are uint128_t. The caller guarantees
   //   amount_in, reserve_in, reserve_out <= MAX_RESERVE (2^57), so the
   //   numerator is below 2^128 and nothing can wrap around.
   // - All multiplications come BEFORE the single division. Dividing early
   //   (for example fee = amount_in * fee_bps / 10000 first) would round the
   //   fee of a small trade down to zero.
   // - The division rounds DOWN: the trader gets slightly less, never more.
   //   That is what makes reserve_a * reserve_b never decrease.
   // - reserve_in > 0 (checked by the caller), so the divisor is not zero.
   static int64_t get_amount_out(int64_t amount_in, int64_t reserve_in, int64_t reserve_out, uint16_t fee_bps) {
      const uint128_t in_after_fee = static_cast<uint128_t>(amount_in) * (BPS - fee_bps);
      const uint128_t numerator    = static_cast<uint128_t>(reserve_out) * in_after_fee;
      const uint128_t denominator  = static_cast<uint128_t>(reserve_in) * BPS + in_after_fee;
      return to_amount(numerator / denominator);
   }

   // Integer square root: the largest r with r * r <= n.
   // Newton's method: start with a guess that is too big and repeat
   // x = (x + n / x) / 2. The guesses only go down, and the loop stops at
   // the first one that would not go down any more, which is the answer.
   // Used for n <= 2^124, so `x + 1` and `x + n / x` cannot overflow.
   static int64_t isqrt(uint128_t n) {
      if (n == 0) {
         return 0;
      }
      uint128_t x = n;
      uint128_t y = (x + 1) / 2;
      while (y < x) {
         x = y;
         y = (x + n / x) / 2;
      }
      return to_amount(x);
   }

   // a * b / c, rounded down. The caller guarantees a, b <= 2^62 (so the
   // product fits in uint128_t) and c > 0.
   static uint128_t mul_div(int64_t a, int64_t b, int64_t c) {
      return static_cast<uint128_t>(a) * b / c;
   }

   // a * b / c, rounded up.
   static uint128_t mul_div_up(int64_t a, int64_t b, int64_t c) {
      return (static_cast<uint128_t>(a) * b + (c - 1)) / c;
   }

   // Narrows a 128-bit result to a token amount. A plain cast would silently
   // drop the high bits; this aborts instead.
   static int64_t to_amount(uint128_t value) {
      check(value <= static_cast<uint128_t>(asset::max_amount), "math overflow: result does not fit a token amount");
      return static_cast<int64_t>(value);
   }

private:
   // Parses "swap:<min_out>". <min_out> must be 1 to 18 decimal digits and
   // nothing else: no sign, no spaces, no dot. 18 digits is below 2^62, so
   // the number always fits and the loop below cannot overflow.
   static int64_t parse_min_out(const std::string& memo) {
      const size_t prefix = 5; // length of "swap:"
      check(memo.size() > prefix && memo.size() <= prefix + 18,
            "bad swap memo: use 'swap:<min_out>', min_out = 1 to 18 digits");
      int64_t value = 0;
      for (size_t i = prefix; i < memo.size(); ++i) {
         check(memo[i] >= '0' && memo[i] <= '9',
               "bad swap memo: use 'swap:<min_out>', min_out = 1 to 18 digits");
         value = value * 10 + (memo[i] - '0');
      }
      return value;
   }

   void add_deposit(const name& owner, bool is_a, const asset& quantity) {
      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);

      deposits_table deposits(get_self(), get_self().value);
      auto dep = deposits.find(owner.value);
      if (dep == deposits.end()) {
         // RAM payer = the pool itself: inside a notification a contract
         // cannot bill RAM to anybody else. The cost of that choice (dust
         // deposits from many accounts) is in docs/THREATS.md.
         deposits.emplace(get_self(), [&](auto& row) {
            row.owner = owner;
            row.a     = asset(0, p->reserve_a.quantity.symbol);
            row.b     = asset(0, p->reserve_b.quantity.symbol);
            (is_a ? row.a : row.b) = quantity;
         });
      } else {
         // `asset += asset` aborts on overflow and on a symbol mismatch.
         deposits.modify(dep, same_payer, [&](auto& row) {
            (is_a ? row.a : row.b) += quantity;
         });
      }
   }

   // Swaps `amount_in` of one pool token for the other and pays `from`.
   // The tokens have already arrived (this runs inside the notification).
   void swap(const name& from, bool a_in, int64_t amount_in, int64_t min_out) {
      pool_table pools(get_self(), get_self().value);
      auto p = pools.find(0);

      // Also guarantees reserve_in > 0, so the formula cannot divide by zero.
      check(p->total_shares > 0, "pool has no liquidity");

      const extended_asset& in_side  = a_in ? p->reserve_a : p->reserve_b;
      const extended_asset& out_side = a_in ? p->reserve_b : p->reserve_a;
      const int64_t reserve_in  = in_side.quantity.amount;
      const int64_t reserve_out = out_side.quantity.amount;

      // Checked BEFORE the math: it bounds amount_in, which keeps the
      // formula inside 128 bits (see MAX_RESERVE).
      check(amount_in <= MAX_RESERVE - reserve_in, "reserve limit exceeded");

      const int64_t out = get_amount_out(amount_in, reserve_in, reserve_out, p->fee_bps);

      // A trade that rounds down to nothing would take the input for free.
      check(out > 0, "output amount is zero");
      // The pool can never pay out a whole reserve (the price would be
      // undefined afterwards).
      check(out < reserve_out, "output must be less than the reserve");

      // Slippage protection. Transactions are public before they execute,
      // so an attacker can trade just before the user to move the price and
      // trade back just after (a "sandwich"). The user's limit makes the
      // user's swap fail instead. It is mandatory: "swap:0" would switch
      // the protection off.
      check(min_out > 0, "min_out must be positive");
      check(out >= min_out, "output is less than min_out");

      // Update our own books first, pay second (checks-effects-interactions).
      pools.modify(p, same_payer, [&](auto& row) {
         (a_in ? row.reserve_a : row.reserve_b).quantity.amount += amount_in;
         (a_in ? row.reserve_b : row.reserve_a).quantity.amount -= out;
      });

      pay(from, extended_asset(out, out_side.get_extended_symbol()), "pool swap");
   }

   // Inline token transfer from the pool to `to`. Zero amounts are skipped:
   // a token contract rejects a zero transfer, and that must not block the
   // other half of a two-token payout.
   void pay(const name& to, const extended_asset& value, const std::string& memo) {
      if (value.quantity.amount == 0) {
         return;
      }
      eosio::action(
         eosio::permission_level{get_self(), "active"_n},
         value.contract,
         "transfer"_n,
         std::make_tuple(get_self(), to, value.quantity, memo)
      ).send();
   }
};
