import math
from scipy.optimize import minimize_scalar

def get_pool_price(a_reserve, b_reserve):
    return b_reserve / a_reserve

def swap(token_in_amount, token_in_reserve, token_out_reserve, fee=0.003):
    amount_in_with_fee = token_in_amount * (1 - fee)
    new_token_in_reserve = token_in_reserve + amount_in_with_fee
    new_token_out_reserve = token_out_reserve * token_in_reserve / new_token_in_reserve
    amount_out = token_out_reserve - new_token_out_reserve
    return amount_out, new_token_in_reserve, new_token_out_reserve

def arbitrage_profit(x, a1, b1, a2, b2, fee=0.003):
    amount_in_with_fee = x * (1 - fee) 
    a_out = (a2 * amount_in_with_fee) / (b2 + amount_in_with_fee)
    amount_in_with_fee2 = a_out * (1 - fee)
    b_out = (b1 * amount_in_with_fee2) / (a1 + amount_in_with_fee2)
    return b_out - x

def find_max_profit_x(a1, b1, a2, b2, fee=0.003):
    result = minimize_scalar(
        lambda x: -arbitrage_profit(x, a1, b1, a2, b2, fee),
        bounds=(0.001, b2 * 0.5),
        method='bounded'
    )
    return result.x, -result.fun

def simulate():
    a_price_usd = 1
    b_price_usd = 5

    # Set this to True to use optimizer, False to use manual B input
    use_auto_optimal_b = True

    # Manual override (used only if use_auto_optimal_b = False)
    manual_b_in = 10

    # Initial DEX states
    dex1 = {'A': 1000, 'B': 200}
    dex2 = {'A': 1010, 'B': 198.01}

    print("Before LP or Arbitrage:")
    print("DEX1 price A in B:", get_pool_price(dex1['A'], dex1['B']))
    print("DEX2 price A in B:", get_pool_price(dex2['A'], dex2['B']))

    # 💧 Add Liquidity to DEX2 (you provide 99% of new pool)
    user_a = dex2['A'] * 0
    user_b = dex2['B'] * 0
    dex2['A'] += user_a
    dex2['B'] += user_b

    user_lp_share = user_a / dex2['A']

    print(f"\nProvided LP: {user_a:.2f} A and {user_b:.2f} B")
    print(f"Your LP Share in DEX2: {user_lp_share * 100:.2f}%")

    # ✅ Decide how much B to borrow
    if use_auto_optimal_b:
        max_x, max_profit = find_max_profit_x(
            dex1['A'], dex1['B'],
            dex2['A'], dex2['B']
        )
        b_in = max_x
        print(f"\n✅ Optimal B (X) to swap into DEX2 for max profit: {max_x:.6f} B")
        print(f"✅ Maximum Arbitrage Profit (before LP impact): {max_profit:.6f} B")
    else:
        b_in = manual_b_in
        print(f"\n⚙️ Using manually set B input: {b_in:.6f} B")

    # 🌀 Perform Arbitrage
    a_out_dex2, dex2['B'], dex2['A'] = swap(b_in, dex2['B'], dex2['A'], fee=0.003)
    b_out_dex1, dex1['A'], dex1['B'] = swap(a_out_dex2, dex1['A'], dex1['B'], fee=0.003)

    # 🧾 Withdraw LP
    user_withdraw_a = dex2['A'] * user_lp_share
    user_withdraw_b = dex2['B'] * user_lp_share
    final_lp_value_usd = user_withdraw_a * a_price_usd + user_withdraw_b * b_price_usd
    original_lp_value_usd = user_a * a_price_usd + user_b * b_price_usd
    lp_delta = final_lp_value_usd - original_lp_value_usd

    print("\nAfter Arbitrage:")
    print("DEX1 Reserves:", dex1)
    print("Token A Price: ", dex1['B'] / dex1['A'], "  Token B Price: ", dex1['A'] / dex1['B'])
    print("DEX2 Reserves:", dex2)
    print("Token A Price: ", dex2['B'] / dex2['A'], "  Token B Price: ", dex2['A'] / dex2['B'])

    print(f"\nArbitrage Result: {b_in:.6f} B → {a_out_dex2:.6f} A → {b_out_dex1:.6f} B")
    print(f"✅ Net Arbitrage Gain: {b_out_dex1 - b_in:.6f} B")

    print(f"\nLP Withdrawal: {user_withdraw_a:.2f} A, {user_withdraw_b:.2f} B")
    print(f"LP Final Value (USD): ${final_lp_value_usd:.2f}")
    print(f"LP Original Value (USD): ${original_lp_value_usd:.2f}")
    print(f"✅ LP Gain/Loss (USD): ${lp_delta:.2f}")

    # 🎯 Total USD profit
    total_profit_usd = lp_delta + ((b_out_dex1 - b_in) * b_price_usd)
    print(f"\n💰 TOTAL NET PROFIT (LP + Arbitrage): ${total_profit_usd:.2f}")

simulate() 