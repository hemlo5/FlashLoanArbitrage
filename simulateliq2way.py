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
    fee = 0.003

    # Initial DEX states
    dex1 = {'A': 1000, 'B': 200}
    dex2 = {'A': 1010, 'B': 198.01}

    print("\n🔍 Initial State:")
    print(f"DEX1 Reserves → A: {dex1['A']} | B: {dex1['B']}")
    print(f"DEX2 Reserves → A: {dex2['A']} | B: {dex2['B']}")
    print(f"DEX1 Price (A/B): {get_pool_price(dex1['A'], dex1['B']):.6f}")
    print(f"DEX2 Price (A/B): {get_pool_price(dex2['A'], dex2['B']):.6f}")

    # 💧 Provide Liquidity (99%)
    user1_a = dex1['A'] * 99
    user1_b = dex1['B'] * 99
    dex1['A'] += user1_a
    dex1['B'] += user1_b
    user_lp_share1 = user1_a / dex1['A']

    user2_a = dex2['A'] * 99
    user2_b = dex2['B'] * 99
    dex2['A'] += user2_a
    dex2['B'] += user2_b
    user_lp_share2 = user2_a / dex2['A']

    print(f"\n💧 LP Added:")
    print(f"DEX1: +{user1_a} A | +{user1_b} B")
    print(f"DEX2: +{user2_a} A | +{user2_b} B")
    print(f"New DEX1 Reserves: A: {dex1['A']} | B: {dex1['B']}")
    print(f"New DEX2 Reserves: A: {dex2['A']} | B: {dex2['B']}")
    print(f"LP Share: DEX1 = {user_lp_share1*100:.2f}% | DEX2 = {user_lp_share2*100:.2f}%")

    # ✅ Arbitrage plan
    max_x, max_profit = find_max_profit_x(dex1['A'], dex1['B'], dex2['A'], dex2['B'], fee)
    b_in = max_x
    print(f"\n🔁 Arbitrage Opportunity:")
    print(f"Swap {b_in:.6f} B → DEX2 → A → DEX1 → B")
    print(f"Expected Arbitrage Profit: {max_profit:.6f} B")

    # 🔄 Perform Arbitrage
    print(f"\n🔁 Executing Arbitrage:")
    print(f"Step 1: Swap {b_in:.6f} B on DEX2 for A")
    a_out_dex2, dex2['B'], dex2['A'] = swap(b_in, dex2['B'], dex2['A'], fee=fee)
    print(f"Received: {a_out_dex2:.6f} A | New DEX2 Reserves: A = {dex2['A']:.6f}, B = {dex2['B']:.6f}")

    print(f"Step 2: Swap {a_out_dex2:.6f} A on DEX1 for B")
    b_out_dex1, dex1['A'], dex1['B'] = swap(a_out_dex2, dex1['A'], dex1['B'], fee=fee)
    print(f"Received: {b_out_dex1:.6f} B | New DEX1 Reserves: A = {dex1['A']:.6f}, B = {dex1['B']:.6f}")

    # 💼 LP Withdrawal
    user1_final_a = dex1['A'] * user_lp_share1
    user1_final_b = dex1['B'] * user_lp_share1
    user2_final_a = dex2['A'] * user_lp_share2
    user2_final_b = dex2['B'] * user_lp_share2

    user1_initial_value = user1_a * a_price_usd + user1_b * b_price_usd
    user1_final_value = user1_final_a * a_price_usd + user1_final_b * b_price_usd
    user2_initial_value = user2_a * a_price_usd + user2_b * b_price_usd
    user2_final_value = user2_final_a * a_price_usd + user2_final_b * b_price_usd

    print("\n🏦 LP Withdrawal:")
    print(f"DEX1 LP: A = {user1_final_a:.6f} | B = {user1_final_b:.6f}")
    print(f"DEX2 LP: A = {user2_final_a:.6f} | B = {user2_final_b:.6f}")
    print(f"DEX1 Value: Start = ${user1_initial_value:.2f} → End = ${user1_final_value:.2f}")
    print(f"DEX2 Value: Start = ${user2_initial_value:.2f} → End = ${user2_final_value:.2f}")

    # 📊 Totals
    arbitrage_profit_usd = (b_out_dex1 - b_in) * b_price_usd
    total_lp_profit_usd = (user1_final_value - user1_initial_value) + (user2_final_value - user2_initial_value)
    total_profit_usd = total_lp_profit_usd + arbitrage_profit_usd

    print("\n📈 Summary:")
    print(f"Arbitrage: {b_in:.6f} B → {a_out_dex2:.6f} A → {b_out_dex1:.6f} B")
    print(f"Net Arbitrage Profit: {(b_out_dex1 - b_in):.6f} B = ${arbitrage_profit_usd:.2f}")
    print(f"LP Value Change: ${total_lp_profit_usd:.2f}")
    print(f"💰 TOTAL NET PROFIT: ${total_profit_usd:.2f}")

simulate()
