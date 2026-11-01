from testtx import TokenConverter

# Your list of prompts
ques = [
    'A Amt A for Liquidity : ',
    'B Amt B for Liquidity : ',
    'A Amt A for Arbitrage : ',
    'B Min AmtOut 1 : ',
    'A Token A borrowed : ',
    'B Token B borrowed : ',
    'A Actual Liquidity A Added : ',
    'B Actual Liquidity B Added : ',
    'B Amt Received Swap 1 : ',
    'A Amt Received Swap 2 : '
]

# Save the ques list to mahalogs.py


quesvals = {}
quesvalsusd = {}

for prompt in ques:
    inp = input(prompt)
    quesvals[prompt] = inp
    # convert using the first character of the prompt as token symbol
    converter = TokenConverter(inp, prompt[0])
    quesvalsusd[prompt] = converter.usd()

with open('mahalogs.py', 'w') as f:
    f.write('quesvals = ' + repr(quesvals) + '\n')
    f.write('quesvalsusd = ' + repr(quesvalsusd) + '\n')
    
print("\nResults:")
for prompt in ques:
    print(f"{prompt}  Input: {quesvals[prompt]}  USD Value: {quesvalsusd[prompt]}")
