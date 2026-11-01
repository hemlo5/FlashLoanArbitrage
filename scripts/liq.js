const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const TOKEN_A_ADDRESS = "0x3082cc23568ea640225c2467653db90e9250aaa0"; // RDNT on Arbitrum
const TOKEN_B_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH on Arbitrum
const UNISWAP_V3_POOL_ADDRESS = "0x446bf9748b4ea044dd759d9b9311c70491df8f29"; // Uniswap V3 RDNT/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0x3bfb1ac033ff0ae278be0583fccc900fbd9382c6"; // SushiSwap V2 RDNT/WETH
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0xe6a4c5A9cD57a0CC57C0f01407288A8E1404e487";//0x78Cf4E17820CE72ac6e2Cd55f194938bfcc7FEBb
const BORROW_VALUE_USD = 10; // Desired borrow amount in USD for TOKEN_A
const ARBITRAGE_THRESHOLD = 0.00000007;
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // WETH/USD on Arbitrum
const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault on Arbitrum

const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router
const SUSHISWAP_V2_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap V2 Router

// ========== ABI DEFINITIONS ==========
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const V2_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(uint256 amountAForLiquidity, uint256 amountBForLiquidity, uint256 amountAForArbitrage, bool direction, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 feeUniswap, uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) external",
  "event LiquidityProvided(uint256 amountA, uint256 amountB, uint256 liquidity)",
  "event ArbitrageExecuted(uint256 profitA, uint256 profitB, bool success)",
  "event LiquidityWithdrawn(uint256 amountA, uint256 amountB)",
  "event FlashLoanRepaid(uint256 amountA, uint256 amountB)",
  "event ProfitSent(address indexed receiver, uint256 amountA, uint256 amountB)",
  "event TokenBalanceAdjusted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
  "event SwapExecuted(address indexed dexRouter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event TransactionStep(string currentStep, string nextStep, string completedSteps)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const VAULT_ABI = [
  "function getProtocolFeesCollector() view returns (address)"
];

const FEE_COLLECTOR_ABI = [
  "function getFlashLoanFeePercentage() view returns (uint256)"
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)"
];

const tokenAmountArgs = {
  "LiquidityProvided": ["amountA", "amountB"],
  "ArbitrageExecuted": ["profitA", "profitB"],
  "LiquidityWithdrawn": ["amountA", "amountB"],
  "FlashLoanRepaid": ["amountA", "amountB"],
  "ProfitSent": ["amountA", "amountB"],
  "TokenBalanceAdjusted": ["amountIn", "amountOut"],
  "SwapExecuted": ["amountIn", "amountOut"]
};

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, flashLoanArbitrage, chainlinkTokenBUsd;
let tokenA, tokenB;
let uniswapIsTokenAFirst, sushiswapIsTokenAFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0;
let cachedTokenAUsdPrice = 0, cachedTokenBUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedFlashloanFeePercentage;
const swapEventTimestamps = {};
let highestPriceDiff = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let cumulativePnLInTokenB = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 2;
let currentNonce;

// ========== HELPER FUNCTIONS ==========

function formatTokenAmount(amount, tokenAddress) {
  const formatted = ethers.formatUnits(amount, 18);
  let usdPrice;
  if (tokenAddress.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase()) {
    usdPrice = cachedTokenAUsdPrice;
  } else if (tokenAddress.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase()) {
    usdPrice = cachedTokenBUsdPrice;
  } else {
    return formatted;
  }
  const usdValue = Number(formatted) * usdPrice;
  return `${formatted} (≈$${usdValue.toFixed(2)} USD)`;
}

// ========== CORE FUNCTIONS ==========

const connectWebSocket = async () => {
  wsProvider = new ethers.WebSocketProvider(process.env.ARBITRUM_WS_RPC_URL);

  wsProvider.websocket.on("close", (code) => {
    console.error(`WebSocket closed (${code}). Reconnecting...`);
    setTimeout(connectWebSocket, 3000);
  });

  wsProvider.websocket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    wsProvider.websocket.close();
  });

  try {
    await wsProvider.getNetwork();
    console.log("✅ WebSocket connected");
  } catch (error) {
    console.error("WebSocket connection failed:", error.message);
    return;
  }

  uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
  sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const balancerVault = new ethers.Contract(BALANCER_VAULT_ADDRESS, VAULT_ABI, wsProvider);

  try {
    const [uniToken0, uniToken1, sushiToken0, sushiToken1] = await Promise.all([
      uniswapV3Pool.token0(),
      uniswapV3Pool.token1(),
      sushiswapV2Pool.token0(),
      sushiswapV2Pool.token1()
    ]);
    console.log(`Uniswap token0: ${uniToken0}, token1: ${uniToken1}`);
    console.log(`SushiSwap token0: ${sushiToken0}, token1: ${sushiToken1}`);
    uniswapIsTokenAFirst = uniToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
    sushiswapIsTokenAFirst = sushiToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
    console.log(`Uniswap isTokenAFirst: ${uniswapIsTokenAFirst}`);
    console.log(`SushiSwap isTokenAFirst: ${sushiswapIsTokenAFirst}`);
  } catch (error) {
    console.error("Failed to fetch pool token details:", error.message);
    return;
  }

  try {
    cachedUniswapFee = await uniswapV3Pool.fee();
    cachedSushiSwapFee = 3000; // Fixed 0.3% for SushiSwap V2
    const feeCollectorAddress = await balancerVault.getProtocolFeesCollector();
    const feeCollector = new ethers.Contract(feeCollectorAddress, FEE_COLLECTOR_ABI, wsProvider);
    cachedFlashloanFeePercentage = await feeCollector.getFlashLoanFeePercentage();
    const feePercentage = Number(cachedFlashloanFeePercentage) / 1e18;
    console.log(`Uniswap V3 Pool Fee: ${cachedUniswapFee} (${(Number(cachedUniswapFee) / 1e6) * 100}%)`);
    console.log(`SushiSwap V2 Pool Fee: ${cachedSushiSwapFee} (0.3%)`);
    console.log(`Balancer Flashloan Fee: ${feePercentage * 100}%`);

    tokenA = new ethers.Contract(TOKEN_A_ADDRESS, ERC20_ABI, wsProvider);
    tokenB = new ethers.Contract(TOKEN_B_ADDRESS, ERC20_ABI, wsProvider);
  } catch (error) {
    console.error("Failed to fetch fees or premium:", error.message);
    return;
  }

  // Fetch initial prices before updating USD prices
  try {
    const { freshPriceUni, freshPriceSushi } = await fetchFreshPrices();
    cachedUniswapPrice = freshPriceUni;
    cachedSushiSwapPrice = freshPriceSushi;
  } catch (error) {
    console.error("Initial price fetch failed:", error.message);
  }

  await updateTokenBUsdPrice();
  updateTokenAUsdPrice(); // Now uses cachedUniswapPrice and cachedTokenBUsdPrice

  await updateFeeData();
  checkArbitrage("Initial");
  setupEventListeners();

  await logAvailableBorrowAmounts();

  setInterval(updateFeeData, 10000);
  setInterval(updateTokenAUsdPrice, 10000);
  setInterval(updateTokenBUsdPrice, 10000);
};

const logAvailableBorrowAmounts = async () => {
  try {
    const [tokenABalance, tokenBBalance] = await Promise.all([
      tokenA.balanceOf(BALANCER_VAULT_ADDRESS),
      tokenB.balanceOf(BALANCER_VAULT_ADDRESS)
    ]);
    const tokenABalanceFormatted = ethers.formatUnits(tokenABalance, 18);
    const tokenBBalanceFormatted = ethers.formatUnits(tokenBBalance, 18);
    console.log(`Available to borrow from Balancer Vault:
- TOKEN_A: ${tokenABalanceFormatted}
- TOKEN_B: ${tokenBBalanceFormatted}`);
  } catch (error) {
    console.error("Failed to fetch available borrow amounts:", error.message);
  }
};

const updateTokenAUsdPrice = () => {
  if (cachedUniswapPrice && cachedTokenBUsdPrice) {
    cachedTokenAUsdPrice = cachedUniswapPrice * cachedTokenBUsdPrice;
    console.log(`💵 Updated TOKEN_A/USD price: ${cachedTokenAUsdPrice}`);
  } else {
    console.log("Skipping TOKEN_A/USD price update: missing data");
  }
};

const updateTokenBUsdPrice = async () => {
  try {
    const price = await chainlinkTokenBUsd.latestAnswer();
    const decimals = Number(await chainlinkTokenBUsd.decimals());
    cachedTokenBUsdPrice = Number(price) / 10 ** decimals;
    console.log(`💵 Updated TOKEN_B/USD price: ${cachedTokenBUsdPrice}`);
  } catch (error) {
    console.error("Failed to update TOKEN_B/USD price:", error.message);
  }
};

const updateFeeData = async () => {
  try {
    cachedFeeData = await wsProvider.getFeeData();
    console.log("⛽ Gas Update - Base:", ethers.formatUnits(cachedFeeData.gasPrice, "gwei"), "Gwei");
  } catch (error) {
    console.error("Gas update failed:", error.message);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("1", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      maxFeePerGas: ethers.parseUnits("2", "gwei")
    };
  }
};

const calculateV3Price = (sqrtPriceX96, isARBFirst) => {
  const decimalsARB = 18;
  const decimalsWETH = 18;
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2;
  const price = isARBFirst 
    ? priceRatio * 10 ** (decimalsARB - decimalsWETH)
    : (1 / priceRatio) * 10 ** (decimalsWETH - decimalsARB);
  console.log(`Calculated price: ${price} (isARBFirst: ${isARBFirst})`);
  return price;
};

const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = BigInt(reserves.reserve0.toString());
  const reserve1 = BigInt(reserves.reserve1.toString());
  const priceBigInt = isTokenAFirst ? (reserve1 * BigInt(1e18)) / reserve0 : (reserve0 * BigInt(1e18)) / reserve1;
  const price = Number(priceBigInt) / 1e18;
  console.log(`Calculated V2 price: ${price} (isTokenAFirst: ${isTokenAFirst})`);
  return price;
};

const fetchAndLogPrices = async (context = "general") => {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const [slot0Uni, reservesSushi] = await Promise.all([
        uniswapV3Pool.slot0(),
        sushiswapV2Pool.getReserves()
      ]);

      const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsTokenAFirst);
      const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsTokenAFirst);
      const priceDiff = Math.abs(freshPriceUni - freshPriceSushi);
      const timestamp = Date.now();

      const logMessage = `⭕ (${context}): Uniswap=${freshPriceUni.toFixed(18)}, SushiSwap=${freshPriceSushi.toFixed(18)}, PriceDiff=${priceDiff.toFixed(18)} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync("logs/time.txt", logMessage);
      return { freshPriceUni, freshPriceSushi, priceDiff };
    } catch (err) {
      console.error(`Fetch prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        fs.appendFileSync("logs/time.txt", `Failed after ${maxRetries} attempts: ${err.message}\n`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

const fetchFreshPrices = async () => {
  try {
    const slot0Uni = await uniswapV3Pool.slot0();
    const reservesSushi = await sushiswapV2Pool.getReserves();
    const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsTokenAFirst);
    const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsTokenAFirst);
    console.log(`Fresh UniswapV3 price: ${freshPriceUni}`);
    console.log(`Fresh SushiSwapV2 price: ${freshPriceSushi}`);
    return { freshPriceUni, freshPriceSushi };
  } catch (error) {
    console.error("Initial price fetch failed:", error.message);
    throw error;
  }
};

const setupEventListeners = () => {
  uniswapV3Pool.removeAllListeners("Swap");
  sushiswapV2Pool.removeAllListeners("Swap");

  uniswapV3Pool.on("Swap", (_, __, ___, ____, sqrtPriceX96) => {
    const price = calculateV3Price(sqrtPriceX96, uniswapIsTokenAFirst);
    cachedUniswapPrice = price;
    if (cachedTokenBUsdPrice) {
      cachedTokenAUsdPrice = price * cachedTokenBUsdPrice;
      console.log(`💵 Updated TOKEN_A/USD price on swap: ${cachedTokenAUsdPrice}`);
    }
    swapEventTimestamps["Uniswap"] = Date.now();
    console.log(`🔄 [UniswapV3] Swap event at TOKEN_A Price: ${price}`);
    checkArbitrage("Uniswap");
  });

  sushiswapV2Pool.on("Swap", async () => {
    try {
      const reserves = await sushiswapV2Pool.getReserves();
      const price = calculateV2Price(reserves, sushiswapIsTokenAFirst);
      cachedSushiSwapPrice = price;
      swapEventTimestamps["SushiSwap"] = Date.now();
      console.log(`🔄 [SushiSwapV2] Swap event updated TOKEN_A Price: ${price}`);
      checkArbitrage("SushiSwap");
    } catch (error) {
      console.error("Error updating SushiSwap price:", error.message);
    }
  });
};

const calculateLoanAmount = () => {
  if (!cachedTokenAUsdPrice) {
    throw new Error("TOKEN_A/USD price not available");
  }
  const tokenAAmountFloat = BORROW_VALUE_USD / cachedTokenAUsdPrice;
  const loanAmount = ethers.parseUnits(tokenAAmountFloat.toFixed(18), 18);
  console.log(`Calculated loan amount: ${ethers.formatUnits(loanAmount, 18)} TOKEN_A for ${BORROW_VALUE_USD} USD at price ${cachedTokenAUsdPrice} USD/TOKEN_A`);
  return loanAmount;
};

const calculateMinAmountsOut = (amountAForArbitrage, direction, priceSushi, priceUni) => {
  const amountInFloat = Number(ethers.formatUnits(amountAForArbitrage, 18));
  const sushiFee = 0.00003;
  const sushiSlippage = 0.2 * sushiFee;
  const priceDiff = 0.005;
  const priceDiffSlippage = 0.2 * priceDiff;
  const uniFee = 0.003;

  let minAmountOut1, minAmountOut2;

  if (direction) {
    const expectedOut1Float = amountInFloat * priceSushi * (1 - sushiFee);
    const slippageAdjustedOut1 = expectedOut1Float * (1 - sushiSlippage);
    minAmountOut1 = ethers.parseUnits(slippageAdjustedOut1.toFixed(18), 18);

    const expectedOut2FloatNoFee = slippageAdjustedOut1 / priceUni;
    const appreciation = expectedOut2FloatNoFee * priceDiff * (1 - priceDiffSlippage);
    const expectedOut2Float = expectedOut2FloatNoFee * (1 - uniFee) + appreciation;
    minAmountOut2 = ethers.parseUnits(expectedOut2Float.toFixed(18), 18);
  } else {
    const expectedOut1Float = amountInFloat * priceUni * (1 - uniFee);
    const slippageAdjustedOut1 = expectedOut1Float * (1 - priceDiffSlippage);
    minAmountOut1 = ethers.parseUnits(slippageAdjustedOut1.toFixed(18), 18);

    const expectedOut2FloatNoFee = slippageAdjustedOut1 / priceSushi;
    const appreciation = expectedOut2FloatNoFee * priceDiff * (1 - priceDiffSlippage);
    const expectedOut2Float = expectedOut2FloatNoFee * (1 - sushiFee) + appreciation;
    minAmountOut2 = ethers.parseUnits(expectedOut2Float.toFixed(18), 18);
  }

  return { minAmountOut1, minAmountOut2 };
};

const checkArbitrage = (dex) => {
  if (shouldStop) {
    console.log("Bot stopped due to stop condition.");
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`Bot stopped: Reached max transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    sushiswapV2Pool.removeAllListeners("Swap");
    wsProvider.websocket.close();
    return;
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("Max executing transactions reached.");
    return;
  }

  if (!cachedUniswapPrice || !cachedSushiSwapPrice) {
    console.log("Price data missing - Uniswap:", cachedUniswapPrice, "SushiSwap:", cachedSushiSwapPrice);
    return;
  }

  const priceDiff = Math.abs(cachedUniswapPrice - cachedSushiSwapPrice);
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;

  if (priceDiff > ARBITRAGE_THRESHOLD) {
    fetchAndLogPrices("opportunity_detected");
    setTimeout(() => fetchAndLogPrices("2s_after_opportunity"), 2000);

    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity started at ${arbOpportunityStartTime}`);
    }
    arbitrageCount++;
    console.log(`🚨 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)}`);
    const direction = cachedSushiSwapPrice > cachedUniswapPrice;
    console.log(`Direction: ${direction ? "SushiSwap -> Uniswap" : "Uniswap -> SushiSwap"}`);

    const amountAForArbitrage = calculateLoanAmount();
    const { minAmountOut1, minAmountOut2 } = calculateMinAmountsOut(
      amountAForArbitrage,
      direction,
      cachedSushiSwapPrice,
      cachedUniswapPrice
    );

    const minAmountOut1USD = Number(ethers.formatUnits(minAmountOut1, 18)) * cachedTokenBUsdPrice;
    const minAmountOut2USD = Number(ethers.formatUnits(minAmountOut2, 18)) * cachedTokenAUsdPrice;
    console.log(`Arbitrage Opportunity Detected:
- Min Amount Out 1: ${ethers.formatUnits(minAmountOut1, 18)} TOKEN_B (≈$${minAmountOut1USD.toFixed(2)} USD)
- Min Amount Out 2: ${ethers.formatUnits(minAmountOut2, 18)} TOKEN_A (≈$${minAmountOut2USD.toFixed(2)} USD)`);

    logAvailableBorrowAmounts();
    executePresignedArbitrage(direction, swapEventTimestamps[dex] || Date.now(), amountAForArbitrage, minAmountOut1, minAmountOut2);
  } else {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now() - arbOpportunityStartTime;
      console.log(`😟 Arbitrage vanished after ${vanishTime} ms.`);
      fs.appendFileSync("logs/time.txt", `Opportunity lasted: ${vanishTime} ms, pricediff: ${priceDiff.toFixed(10)}\n`);
      arbOpportunityStartTime = null;
    }
    console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} | Count: ${arbitrageCount}`);
  }
};

const logTransactionDetails = (serial, txHash, direction, loanAmount, profitInTokenB, gasCostInTokenB, swapFeeUniswap, swapFeeSushiSwap, netPnL, cumulativePnL, txStatus, error = null, amountOut1, amountOut2) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const tokenAUsdPrice = cachedTokenAUsdPrice;
  const tokenBUsdPrice = cachedTokenBUsdPrice;
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * tokenAUsdPrice;
  const profitUSD = profitInTokenB * tokenBUsdPrice;
  const gasCostUSD = gasCostInTokenB * tokenBUsdPrice;
  const swapFeeUniswapUSD = swapFeeUniswap * tokenBUsdPrice;
  const swapFeeSushiSwapUSD = swapFeeSushiSwap * tokenBUsdPrice;
  const netPnLUSD = netPnL * tokenBUsdPrice;
  const cumulativePnLUSD = cumulativePnL * tokenBUsdPrice;

  const amountOut1USD = direction ? Number(ethers.formatUnits(amountOut1, 18)) * tokenBUsdPrice : Number(ethers.formatUnits(amountOut1, 18)) * tokenAUsdPrice;
  const amountOut2USD = direction ? Number(ethers.formatUnits(amountOut2, 18)) * tokenAUsdPrice : Number(ethers.formatUnits(amountOut2, 18)) * tokenBUsdPrice;

  const logMessage = `
Timestamp: ${timestamp}
Transaction #${serial}
Status: ${statusText}
Transaction Hash: ${txHash || 'N/A'}
Direction: ${direction ? "SushiSwap -> Uniswap" : "Uniswap -> SushiSwap"}
Loan Amount: ${ethers.formatUnits(loanAmount, 18)} TOKEN_A (≈$${loanAmountUSD.toFixed(2)} USD)
Profit: ${profitInTokenB.toFixed(18)} TOKEN_B (≈$${profitUSD.toFixed(2)} USD)
Gas Cost: ${gasCostInTokenB.toFixed(18)} TOKEN_B (≈$${gasCostUSD.toFixed(2)} USD)
Uniswap Swap Fee: ${swapFeeUniswap.toFixed(18)} TOKEN_B (≈$${swapFeeUniswapUSD.toFixed(2)} USD)
SushiSwap Swap Fee: ${swapFeeSushiSwap.toFixed(18)} TOKEN_B (≈$${swapFeeSushiSwapUSD.toFixed(2)} USD)
Net PnL: ${netPnL.toFixed(18)} TOKEN_B (≈$${netPnLUSD.toFixed(2)} USD)
Cumulative PnL: ${cumulativePnL.toFixed(18)} TOKEN_B (≈$${cumulativePnLUSD.toFixed(2)} USD)
Amount Out 1: ${ethers.formatUnits(amountOut1, 18)} ${direction ? 'TOKEN_B' : 'TOKEN_A'} (≈$${amountOut1USD.toFixed(2)} USD)
Amount Out 2: ${ethers.formatUnits(amountOut2, 18)} ${direction ? 'TOKEN_A' : 'TOKEN_B'} (≈$${amountOut2USD.toFixed(2)} USD)${errorMessage}
--------------------------------------------------
`;
  fs.appendFileSync("logs/p&l.txt", logMessage);
};

const executePresignedArbitrage = async (direction, startTime, amountAForArbitrage, minAmountOut1, minAmountOut2) => {
  executingTransactions++;
  console.log(`Transaction started. Executing transactions: ${executingTransactions}`);
  let loanAmount;

  try {
    const detectionTime = Date.now();
    console.log("Starting arbitrage execution for transaction #" + arbitrageCount);

    const reserves = await sushiswapV2Pool.getReserves();
    let R_A, R_B;
    if (sushiswapIsTokenAFirst) {
      R_A = BigInt(reserves.reserve0.toString());
      R_B = BigInt(reserves.reserve1.toString());
    } else {
      R_A = BigInt(reserves.reserve1.toString());
      R_B = BigInt(reserves.reserve0.toString());
    }
    console.log(`Current reserves: R_A = ${ethers.formatUnits(R_A, 18)} TOKEN_A, R_B = ${ethers.formatUnits(R_B, 18)} TOKEN_B`);

    const FACTOR = BigInt(99);
    const amountAForLiquidity = R_A * FACTOR;
    const amountBForLiquidity = R_B * FACTOR;
    console.log(`amountAForLiquidity = ${ethers.formatUnits(amountAForLiquidity, 18)} TOKEN_A`);
    console.log(`amountBForLiquidity = ${ethers.formatUnits(amountBForLiquidity, 18)} TOKEN_B`);

    loanAmount = amountAForArbitrage;
    console.log(`amountAForArbitrage = ${ethers.formatUnits(amountAForArbitrage, 18)} TOKEN_A`);

    console.log(`minAmountOut1: ${ethers.formatUnits(minAmountOut1, 18)} TOKEN_B`);
    console.log(`minAmountOut2: ${ethers.formatUnits(minAmountOut2, 18)} TOKEN_A`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 45);
    const feeUniswap = cachedUniswapFee;
    const tokenAUSDPrice = Math.round(cachedTokenAUsdPrice * 1e8); // Scale to 8 decimals
    const tokenBUSDPrice = Math.round(cachedTokenBUsdPrice * 1e8); // Scale to 8 decimals
    console.log(`Passing USD prices: RDNT=${tokenAUSDPrice}, WETH=${tokenBUSDPrice}`);
    minAmountOut1=0
    minAmountOut2=0
    const txData = flashLoanArbitrage.interface.encodeFunctionData(
      "executeArbitrage",
      [
        amountAForLiquidity,
        amountBForLiquidity,
        amountAForArbitrage,
        direction,
        minAmountOut1,
        minAmountOut2,
        deadline,
        feeUniswap,
        tokenAUSDPrice,
        tokenBUSDPrice
      ]
    );
    const encodeTime = Date.now();

    let nonce = currentNonce;
    console.log(`Using nonce: ${nonce}`);

    const fetchedFeeData = cachedFeeData;
    if (!fetchedFeeData) {
      throw new Error("Fee data unavailable");
    }
    console.log(`Fetched fee data: ${JSON.stringify(fetchedFeeData, (key, value) => typeof value === 'bigint' ? value.toString() : value)}`);
    const baseFeePerGas = fetchedFeeData.lastBaseFeePerGas || fetchedFeeData.gasPrice;
    const suggestedMaxPriorityFeePerGas = fetchedFeeData.maxPriorityFeePerGas || fetchedFeeData.gasPrice;
    const reasonableTip = fetchedFeeData.maxPriorityFeePerGas * 2n;
    const buffer = ethers.parseUnits("0.1", "gwei");
    let maxFeePerGas = baseFeePerGas + reasonableTip + buffer;
    const suggestedMaxFeePerGas = fetchedFeeData.maxFeePerGas || (baseFeePerGas + suggestedMaxPriorityFeePerGas);
    if (maxFeePerGas < suggestedMaxFeePerGas) maxFeePerGas = suggestedMaxFeePerGas;

    console.log(`baseFeePerGas: ${ethers.formatUnits(baseFeePerGas, "gwei")} Gwei`);
    console.log(`suggestedMaxPriorityFeePerGas: ${ethers.formatUnits(suggestedMaxPriorityFeePerGas, "gwei")} Gwei`);
    console.log(`reasonableTip: ${ethers.formatUnits(reasonableTip, "gwei")} Gwei`);
    console.log(`buffer: ${ethers.formatUnits(buffer, "gwei")} Gwei`);
    console.log(`maxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);
    console.log(`suggestedMaxFeePerGas: ${ethers.formatUnits(suggestedMaxFeePerGas, "gwei")} Gwei`);

    const tx = {
      to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      data: txData,
      nonce: nonce,
      chainId: 42161,
      type: 2,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: reasonableTip,
      gasLimit: 2000000n
    };

    console.log("Transaction object defined");
    const signedTx = await signer.signTransaction(tx);
    console.log(`Transaction signed at: ${Date.now()}`);
    const signTime = Date.now();

    const txHash = await httpProvider.send("eth_sendRawTransaction", [signedTx]);
    console.log(`⚡ TX Sent: ${txHash}`);
    currentNonce++;
    const sendTime = Date.now();

    const receipt = await httpProvider.waitForTransaction(txHash);
    const confirmTime = Date.now();

    const timingLog = `Arbitrage #${arbitrageCount} timings:
- Detection to encode: ${encodeTime - detectionTime} ms
- Encode to sign: ${signTime - encodeTime} ms
- Sign to send: ${sendTime - signTime} ms
- Send to confirm: ${confirmTime - sendTime} ms
- Total: ${confirmTime - detectionTime} ms
`;
    console.log(timingLog);
    fs.appendFileSync("logs/timings.txt", timingLog + "\n");

    if (receipt) {
      console.log(`Transaction status: ${receipt.status}`);
      console.log("📜 Transaction Events:");
      for (const log of receipt.logs) {
        try {
          const parsedLog = flashLoanArbitrage.interface.parseLog(log);
          console.log(`  Event: ${parsedLog.name}`);
          const args = parsedLog.args;
          if (parsedLog.name === "SwapExecuted" || parsedLog.name === "TokenBalanceAdjusted") {
            const tokenIn = args.tokenIn;
            const tokenOut = args.tokenOut;
            for (const [key, value] of Object.entries(args)) {
              if (key === "amountIn") {
                console.log(`    ${key}: ${formatTokenAmount(value, tokenIn)}`);
              } else if (key === "amountOut") {
                console.log(`    ${key}: ${formatTokenAmount(value, tokenOut)}`);
              } else {
                console.log(`    ${key}: ${value.toString()}`);
              }
            }
          } else if (tokenAmountArgs[parsedLog.name]) {
            for (const [key, value] of Object.entries(args)) {
              if (tokenAmountArgs[parsedLog.name].includes(key)) {
                let tokenAddress;
                if (key.includes("A")) {
                  tokenAddress = TOKEN_A_ADDRESS;
                } else if (key.includes("B")) {
                  tokenAddress = TOKEN_B_ADDRESS;
                } else {
                  tokenAddress = null;
                }
                if (tokenAddress) {
                  console.log(`    ${key}: ${formatTokenAmount(value, tokenAddress)}`);
                } else {
                  console.log(`    ${key}: ${value.toString()}`);
                }
              } else {
                console.log(`    ${key}: ${value.toString()}`);
              }
            }
          } else {
            for (const [key, value] of Object.entries(args)) {
              console.log(`    ${key}: ${value.toString()}`);
            }
          }
        } catch (e) {
          // Skip logs not from our contract
        }
      }

      if (receipt.status === 1) {
        let amountOut1 = ethers.parseUnits("0", 18);
        let amountOut2 = ethers.parseUnits("0", 18);
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "SwapExecuted") {
              const { dexRouter, amountOut } = parsedLog.args;
              if (dexRouter.toLowerCase() === UNISWAP_V3_ROUTER_ADDRESS.toLowerCase()) {
                amountOut1 = amountOut;
              } else if (dexRouter.toLowerCase() === SUSHISWAP_V2_ROUTER_ADDRESS.toLowerCase()) {
                amountOut2 = amountOut;
              }
            } else if (parsedLog.name === "ArbitrageExecuted") {
              console.log(`ArbitrageExecuted - Success: ${parsedLog.args.success}`);
            }
          } catch (e) {
            // Skip logs not from our contract
          }
        }

        const gasUsed = receipt.gasUsed;
        const effectiveGasPrice = receipt.effectiveGasPrice || cachedFeeData.gasPrice;
        const gasCostInWei = gasUsed * effectiveGasPrice;
        const gasCostInTokenB = Number(ethers.formatUnits(gasCostInWei, 18));

        const loanAmountInTokenB = Number(ethers.formatUnits(amountAForArbitrage, 18)) * cachedUniswapPrice;
        const swapFeeUniswap = loanAmountInTokenB * (Number(cachedUniswapFee) / 1e6);
        const swapFeeSushiSwap = loanAmountInTokenB * (Number(cachedSushiSwapFee) / 1e6);

        const profitInTokenB = 0; // Placeholder, update with actual profit if available
        const netPnL = profitInTokenB - gasCostInTokenB;
        cumulativePnLInTokenB += netPnL;

        logTransactionDetails(
          arbitrageCount,
          receipt.transactionHash,
          direction,
          amountAForArbitrage,
          profitInTokenB,
          gasCostInTokenB,
          swapFeeUniswap,
          swapFeeSushiSwap,
          netPnL,
          cumulativePnLInTokenB,
          receipt.status,
          null,
          amountOut1,
          amountOut2
        );
        checkStopCondition();
      }
    }
  } catch (error) {
    console.error("Execution failed:", error.message);
    console.log("Error stack:", error.stack);
    console.log(`Error details: ${JSON.stringify(error, (key, value) => typeof value === 'bigint' ? value.toString() : value)}`);
    logTransactionDetails(
      arbitrageCount,
      null,
      direction,
      loanAmount || ethers.parseUnits("0", 18),
      0,
      0,
      0,
      0,
      0,
      cumulativePnLInTokenB,
      0,
      error.message,
      ethers.parseUnits("0", 18),
      ethers.parseUnits("0", 18)
    );
    if (error.message.includes("nonce")) {
      currentNonce = await signer.provider.getTransactionCount(signer.address, "pending");
      console.log(`Resynced nonce: ${currentNonce}`);
    }
  } finally {
    executingTransactions--;
    console.log(`Transaction completed. Executing transactions: ${executingTransactions}`);
    if (executingTransactions === 0) {
      checkArbitrage("PostTransaction");
    }
  }
};

const checkStopCondition = () => {
  if (cachedTokenBUsdPrice === 0) {
    console.error("TOKEN_B/USD price is zero, cannot check stop condition");
    return;
  }
  const stopLossTokenB = STOP_LOSS_USD / cachedTokenBUsdPrice;
  if (cumulativePnLInTokenB <= -stopLossTokenB) {
    console.log(`Net PnL ${cumulativePnLInTokenB} TOKEN_B ≤ -${stopLossTokenB} TOKEN_B. Stopping bot.`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    sushiswapV2Pool.removeAllListeners("Swap");
    wsProvider.websocket.close();
  }
};

// ========== INITIALIZATION ==========
(async () => {
  try {
    httpProvider = new ethers.JsonRpcProvider(process.env.ARBITRUM_HTTP_RPC_URL);
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    console.log("Signer address:", signer.address);
    currentNonce = await signer.provider.getTransactionCount(signer.address, "pending");
    console.log(`Initialized nonce: ${currentNonce}`);

    flashLoanArbitrage = new ethers.Contract(
      FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      FLASHLOAN_ARBITRAGE_ABI,
      signer
    );
    console.log("Flashloan contract initialized at:", FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS);

    await connectWebSocket();
  } catch (error) {
    console.error("Initialization failed:", error.message);
  }
})().catch(console.error);