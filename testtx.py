import requests
from decimal import Decimal

class TokenConverter:
    # Mapping of token symbols to CoinGecko IDs
    TOKEN_IDS = {
        "RDNT": "radiant-capital",
        "WETH": "ethereum",        # WETH is pegged to ETH
        "ARB": "arbitrum"          # ARB governance token
    }

    # Decimals for each token
    DECIMALS = {
        "RDNT": 18,
        "WETH": 18,
        "ARB": 18
    }

    def __init__(self, raw_amount: str, token_symbol: str):
        """Initialize with raw amount (as string) and token symbol."""
        self.raw_amount = raw_amount
        self.token_symbol = token_symbol.upper()
        if self.token_symbol not in self.TOKEN_IDS:
            raise ValueError(f"Unsupported token: {self.token_symbol}")
        self.decimals = self.DECIMALS[self.token_symbol]

    def fetch_usd_price(self) -> Decimal:
        """Fetch current USD price from CoinGecko."""
        token_id = self.TOKEN_IDS[self.token_symbol]
        url = (
            f"https://api.coingecko.com/api/v3/simple/price"
            f"?ids={token_id}&vs_currencies=usd"
        )
        resp = requests.get(url)
        resp.raise_for_status()
        price = resp.json()[token_id]["usd"]
        return Decimal(str(price))

    def to_token_amount(self) -> Decimal:
        """Convert raw integer amount to human-readable token amount."""
        return Decimal(self.raw_amount) / (Decimal(10) ** self.decimals)

    def to_usd(self) -> Decimal:
        """Convert raw token amount to USD value."""
        token_amount = self.to_token_amount()
        usd_price = self.fetch_usd_price()
        return token_amount * usd_price

    def display(self) -> None:
        """Print token amount and USD value."""
        amt = self.to_token_amount()
        val = self.to_usd()
        print(f"Token Amount: {amt} {self.token_symbol}")
        print(f"USD Value:   ${val:.2f}")

    def usd(self) -> Decimal:
        """Return the USD value (Decimal)."""
        return self.to_usd()


if __name__ == "__main__":
    # # Example for RDNT
    rdnt_raw_amount = "369448049429593368131"
    rdnt_converter = TokenConverter(rdnt_raw_amount, "RDNT")
    rdnt_converter.display()
    # tokensborrowedB = "325666237856964130515"
    
    # arb_converter_B = TokenConverter(tokensborrowedB, "ARB")
    # print("\nARB Example B:")
    # arb_converter_B.display()

    # # Example for WETH
    weth_raw_amount = "277530000000000"
    weth_converter = TokenConverter(weth_raw_amount, "WETH")
    weth_converter.display()

    
    # # Single raw amount example
    # tokensborrowedB = "3297035794004889252"
    
    # arb_converter_B = TokenConverter(tokensborrowedB, "ARB")
    # print("\nARB Example B:")
    # arb_converter_B.display()
