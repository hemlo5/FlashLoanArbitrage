const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const ARB_ADDRESS = "0x539bde0d7dbd336b79148aa742883198bbf60342"; // ARB on Arbitrum
const WETH_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH on Arbitrum
const UNISWAP_V3_POOL_ADDRESS = "0x59d72ddb29da32847a4665d08ffc8464a7185fae"; // Uniswap V3 ARB/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0xb7e50106a5bd3cf21af210a755f9c8740890a8c9"; // SushiSwap V2 ARB/WETH
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x98A652b3beB8508d6bfa62E464732DBdC69394A2";
const BORROW_VALUE_USD = 10; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 0.76;
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_ETH_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Chainlink ETH/USD on Arbitrum
const AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Aave V3 Pool on Arbitrum

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
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address token, uint256 amount, bool direction, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 fee1, uint24 fee2) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const AAVE_POOL_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint256)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, flashLoanArbitrage, chainlinkEthUsd;
let uniswapIsARBFirst, sushiswapIsARBFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0;
let cachedWethUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedFlashloanPremium;
const swapEventTimestamps = {};
let highestPriceDiff = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let cumulativePnLInWETH = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 2;

// ========== CORE FUNCTIONS ==========

/** Connect to WebSocket and initialize contracts */
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
  chainlinkEthUsd = new ethers.Contract(CHAINLINK_ETH_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, wsProvider);

  try {
    const [uniToken0, uniToken1, sushiToken0, sushiToken1] = await Promise.all([
      uniswapV3Pool.token0(),
      uniswapV3Pool.token1(),
      sushiswapV2Pool.token0(),
      sushiswapV2Pool.token1()
    ]);
    console.log(`Uniswap token0: ${uniToken0}, token1: ${uniToken1}`);
    console.log(`SushiSwap token0: ${sushiToken0}, token1: ${sushiToken1}`);
    uniswapIsARBFirst = uniToken0.toLowerCase() === ARB_ADDRESS.toLowerCase();
    sushiswapIsARBFirst = sushiToken0.toLowerCase() === ARB_ADDRESS.toLowerCase();
    console.log(`Uniswap isARBFirst: ${uniswapIsARBFirst}`);
    console.log(`SushiSwap isARBFirst: ${sushiswapIsARBFirst}`);
  } catch (error) {
    console.error("Failed to fetch pool token details:", error.message);
    return;
  }

  try {
    cachedUniswapFee = await uniswapV3Pool.fee();
    cachedSushiSwapFee = 3000; // For V2 pairs, fees are usually fixed (e.g., 0.30% = 3000 in basis points)
    cachedFlashloanPremium = await aavePool.FLASHLOAN_PREMIUM_TOTAL();
    console.log(`Uniswap V3 Pool Fee: ${cachedUniswapFee} (${(Number(cachedUniswapFee) / 1e6) * 100}%)`);
    console.log(`SushiSwap V2 Pool Fee (assumed): ${cachedSushiSwapFee} (${(cachedSushiSwapFee / 1e6) * 100}%)`);
    console.log(`Aave Flashloan Premium: ${cachedFlashloanPremium} bps (${Number(cachedFlashloanPremium) / 10000}%)`);
  } catch (error) {
    console.error("Failed to fetch fees or premium:", error.message);
    return;
  }

  await updateWethUsdPrice();
  try {
    const { freshPriceUni, freshPriceSushi } = await fetchFreshPrices();
    cachedUniswapPrice = freshPriceUni;
    cachedSushiSwapPrice = freshPriceSushi;
  } catch (error) {
    console.error("Initial price fetch failed:", error.message);
  }

  await updateFeeData();
  checkArbitrage("Initial");
  setupEventListeners();

  setInterval(updateFeeData, 10000);
  setInterval(updateWethUsdPrice, 60000);
};

/** Update WETH/USD price from Chainlink */
const updateWethUsdPrice = async () => {
  try {
    const price = await chainlinkEthUsd.latestAnswer();
    const decimals = Number(await chainlinkEthUsd.decimals());
    cachedWethUsdPrice = Number(price) / 10 ** decimals;
    console.log(`💵 Updated WETH/USD price: ${cachedWethUsdPrice}`);
  } catch (error) {
    console.error("Failed to update WETH/USD price:", error.message);
  }
};

/** Update gas fee data */
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

/** Calculate ARB/WETH price from sqrtPriceX96 (Uniswap V3) */
const calculateV3Price = (sqrtPriceX96, isWETHFirst) => {
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const priceRatio = sqrtPrice * sqrtPrice; // token1 per token0 in smallest units
  let price;

  if (isWETHFirst) {
    // WETH (token0), USDT (token1)
    price = priceRatio * 1e12; // USDT per WETH
  } else {
    // USDT (token0), WETH (token1)
    price = (1 / priceRatio) * 1e-12; // USDT per WETH
  }

  console.log(`Uniswap V3 price: ${price} USDT per WETH`);
  return price;
};
/** Calculate WETH/USDT price from SushiSwap V2 reserves */
/** Calculate USDT per WETH price from SushiSwap V2 reserves */
const calculateV2Price = (reserves, isWETHFirst) => {
  const reserve0 = Number(reserves.reserve0);
  const reserve1 = Number(reserves.reserve1);
  let price;

  if (isWETHFirst) {
    // WETH (token0), USDT (token1)
    price = (reserve1 / reserve0) * 1e12; // USDT per WETH
  } else {
    // USDT (token0), WETH (token1)
    price = (reserve0 / reserve1) * 1e12; // USDT per WETH
  }

  console.log(`SushiSwap V2 price: ${price} USDT per WETH`);
  return price;
};

/** Fetch price from specified DEX */
const fetchPriceFromDex = async (dexName) => {
  if (dexName === "Uniswap") {
    try {
      const slot0 = await uniswapV3Pool.slot0();
      const price = calculateV3Price(slot0.sqrtPriceX96, uniswapIsARBFirst);
      console.log(`Fetched Uniswap V3 price: ${price}`);
      return price;
    } catch (error) {
      console.error(`Failed to fetch Uniswap V3 price: ${error.message}`);
      return null;
    }
  } else if (dexName === "SushiSwap") {
    try {
      const reserves = await sushiswapV2Pool.getReserves();
      const price = calculateV2Price(reserves, sushiswapIsARBFirst);
      console.log(`Fetched SushiSwap V2 price: ${price}`);
      return price;
    } catch (error) {
      console.error(`Failed to fetch SushiSwap V2 price: ${error.message}`);
      return null;
    }
  } else {
    console.error(`Unknown DEX: ${dexName}`);
    return null;
  }
};

/** Robust function to fetch and log prices from both DEXes in parallel */
const fetchAndLogPrices = async (context = "general") => {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const [slot0Uni, reservesSushi] = await Promise.all([
        uniswapV3Pool.slot0(),
        sushiswapV2Pool.getReserves()
      ]);

      const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsARBFirst);
      const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsARBFirst);
      const priceDiff = Math.abs(freshPriceUni - freshPriceSushi);
      const timestamp = Date.now();

      const logMessage = `⭕Double check (${context}): Uniswap=${freshPriceUni.toFixed(18)}, SushiSwap=${freshPriceSushi.toFixed(18)}, PriceDiff=${priceDiff.toFixed(18)} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync("time.txt", logMessage);
      return { freshPriceUni, freshPriceSushi, priceDiff };
    } catch (err) {
      console.error(`Fetch and log prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        const errorMessage = `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`;
        console.error(errorMessage);
        fs.appendFileSync("time.txt", errorMessage);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

/** Original fetchFreshPrices for initialization */
const fetchFreshPrices = async () => {
  try {
    const slot0Uni = await uniswapV3Pool.slot0();
    const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsARBFirst);
    const reservesSushi = await sushiswapV2Pool.getReserves();
    const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsARBFirst);
    console.log(`Fresh UniswapV3 price: ${freshPriceUni}`);
    console.log(`Fresh SushiSwapV2 price: ${freshPriceSushi}`);
    return { freshPriceUni, freshPriceSushi };
  } catch (error) {
    console.error("Failed to fetch fresh prices during initialization:", error.message);
    throw error;
  }
};

/** Set up swap event listeners for price updates */
const setupEventListeners = () => {
  uniswapV3Pool.removeAllListeners("Swap");
  sushiswapV2Pool.removeAllListeners("Swap");

  uniswapV3Pool.on("Swap", async (_, __, ___, ____, sqrtPriceX96) => {
    const priceFromEvent = calculateV3Price(sqrtPriceX96, uniswapIsARBFirst);
    cachedUniswapPrice = priceFromEvent;
    swapEventTimestamps["Uniswap"] = Date.now();
    console.log(`🔄 [UniswapV3] Swap event at ARB Price: ${priceFromEvent}`);

    // Fetch price again to verify accuracy
    const fetchedPrice = await fetchPriceFromDex("Uniswap");
    if (fetchedPrice !== null) {
      console.log(`Verified Uniswap V3 price: ${fetchedPrice}`);
      if (Math.abs(fetchedPrice - priceFromEvent) > 1e-18) {
        console.warn(`Price discrepancy detected: Event price ${priceFromEvent}, Fetched price ${fetchedPrice}`);
      }
    }

    checkArbitrage("Uniswap");
  });

  sushiswapV2Pool.on("Swap", async () => {
    try {
      const reserves = await sushiswapV2Pool.getReserves();
      const price = calculateV2Price(reserves, sushiswapIsARBFirst);
      cachedSushiSwapPrice = price;
      swapEventTimestamps["SushiSwap"] = Date.now();
      console.log(`🔄 [SushiSwapV2] Swap event updated ARB Price: ${price}`);

      // Fetch price again to verify accuracy
      const fetchedPrice = await fetchPriceFromDex("SushiSwap");
      if (fetchedPrice !== null) {
        console.log(`Verified SushiSwap V2 price: ${fetchedPrice}`);
        if (Math.abs(fetchedPrice - price) > 1e-18) {
          console.warn(`Price discrepancy detected: Calculated price ${price}, Fetched price ${fetchedPrice}`);
        }
      }

      checkArbitrage("SushiSwap");
    } catch (error) {
      console.error("Error updating SushiSwap V2 price from event:", error.message);
    }
  });
};

/** Calculate loan amount in ARB based on USD value */
const calculateLoanAmount = (targetPrice) => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price not available for loan calculation");
    throw new Error("WETH/USD price not available");
  }
  const borrowValueWeth = BORROW_VALUE_USD / cachedWethUsdPrice;
  const ARBAmountFloat = borrowValueWeth / targetPrice;
  const ARBAmountStr = ARBAmountFloat.toFixed(18);
  const loanAmount = ethers.parseUnits(ARBAmountStr, 18);
  const loanAmountUSD = ARBAmountFloat * targetPrice * cachedWethUsdPrice;
  console.log(`Calculated loan amount: ${ethers.formatUnits(loanAmount, 18)} ARB (≈$${loanAmountUSD.toFixed(2)} USD)`);
  return loanAmount;
};

/** Check for arbitrage opportunities */
const checkArbitrage = (dex) => {
  if (shouldStop) {
    console.log("Bot stopped due to stop loss condition.");
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`Bot stopped: Reached maximum arbitrage transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    sushiswapV2Pool.removeAllListeners("Swap");
    wsProvider.websocket.close();
    return;
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("Max executing transactions reached, waiting for completion.");
    return;
  }

  if (!cachedUniswapPrice || !cachedSushiSwapPrice) {
    console.log("Price data missing - Uniswap:", cachedUniswapPrice, "SushiSwap:", cachedSushiSwapPrice);
    return;
  }

  const priceDiff = Math.abs(cachedUniswapPrice - cachedSushiSwapPrice);
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;

  if (priceDiff > ARBITRAGE_THRESHOLD) {
    (async () => {
      await fetchAndLogPrices("opportunity_detected");
      setTimeout(async () => {
        await fetchAndLogPrices("2s_after_opportunity");
      }, 2000);
    })();

    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity started at ${arbOpportunityStartTime}`);
    }
    arbitrageCount++;
    console.log(`🚨 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
    console.log(`Uniswap: 1 ARB = ${cachedUniswapPrice} WETH (≈$${(cachedUniswapPrice * cachedWethUsdPrice).toFixed(6)} USD)`);
    console.log(`SushiSwap: 1 ARB = ${cachedSushiSwapPrice} WETH (≈$${(cachedSushiSwapPrice * cachedWethUsdPrice).toFixed(6)} USD)`);
    const direction = cachedSushiSwapPrice > cachedUniswapPrice;
    console.log(`Direction: ${direction ? "SushiSwap -> Uniswap" : "Uniswap -> SushiSwap"}`);
    // executePresignedArbitrage(direction, swapEventTimestamps[dex] || Date.now());
  } else {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now() - arbOpportunityStartTime;
      console.log(`ℹ️ Arbitrage vanished after ${vanishTime} ms.`);
      fs.appendFileSync("time.txt", `Opportunity lasted: ${vanishTime} ms, pricediff: ${priceDiff.toFixed(10)}\n`);
      arbOpportunityStartTime = null;
    }
    console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)}) | Count: ${arbitrageCount}`);
  }
};

/** Log transaction details to p&l.txt with USD values */
const logTransactionDetails = (serial, txHash, direction, loanAmount, profitInWETH, gasCostInWETH, swapFeeUniswap, swapFeeSushiSwap, netPnL, cumulativePnL, txStatus, error = null) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const arbUsdPrice = cachedUniswapPrice * cachedWethUsdPrice;
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * arbUsdPrice;
  const profitUSD = profitInWETH * cachedWethUsdPrice;
  const gasCostUSD = gasCostInWETH * cachedWethUsdPrice;
  const swapFeeUniswapUSD = swapFeeUniswap * cachedWethUsdPrice;
  const swapFeeSushiSwapUSD = swapFeeSushiSwap * cachedWethUsdPrice;
  const netPnLUSD = netPnL * cachedWethUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedWethUsdPrice;

  const logMessage = `
Timestamp: ${timestamp}
Transaction #${serial}
Status: ${statusText}
Transaction Hash: ${txHash || 'N/A'}
Direction: ${direction ? "SushiSwap -> Uniswap" : "Uniswap -> SushiSwap"}
Loan Amount: ${ethers.formatUnits(loanAmount, 18)} ARB (≈$${loanAmountUSD.toFixed(2)} USD)
Profit (before gas and swap fees): ${profitInWETH.toFixed(18)} WETH (≈$${profitUSD.toFixed(2)} USD)
Gas Cost: ${gasCostInWETH.toFixed(18)} WETH (≈$${gasCostUSD.toFixed(2)} USD)
Uniswap V3 Swap Fee: ${swapFeeUniswap.toFixed(18)} WETH (≈$${swapFeeUniswapUSD.toFixed(2)} USD)
SushiSwap V2 Swap Fee: ${swapFeeSushiSwap.toFixed(18)} WETH (≈$${swapFeeSushiSwapUSD.toFixed(2)} USD)
Net PnL: ${netPnL.toFixed(18)} WETH (≈$${netPnLUSD.toFixed(2)} USD)
Cumulative PnL: ${cumulativePnL.toFixed(18)} WETH (≈$${cumulativePnLUSD.toFixed(2)} USD)${errorMessage}
--------------------------------------------------
`;
  fs.appendFileSync("p&l.txt", logMessage);
};

/** Execute arbitrage transaction with USD logging */
const executePresignedArbitrage = async (direction, startTime) => {
  executingTransactions++;
  console.log(`Transaction started. Executing transactions: ${executingTransactions}`);
  let loanAmount;
  try {
    console.log("Starting arbitrage execution for transaction #" + arbitrageCount);

    const targetPrice = direction ? cachedSushiSwapPrice : cachedUniswapPrice;
    if (!targetPrice) {
      console.error("Target price unavailable:", targetPrice);
      throw new Error("Target price unavailable");
    }
    console.log(`Target price: ${targetPrice}`);

    try {
      loanAmount = calculateLoanAmount(targetPrice);
    } catch (error) {
      console.error("Loan amount calculation failed:", error.message);
      throw error;
    }

    const arbUsdPrice = cachedUniswapPrice * cachedWethUsdPrice;

    const uniswapFeeFactor = 1 - Number(cachedUniswapFee) / 1e6;
    const sushiswapFeeFactor = 1 - Number(cachedSushiSwapFee) / 1e6;
    let feeFactorFirst, feeFactorSecond;
    if (direction) {
      feeFactorFirst = sushiswapFeeFactor;
      feeFactorSecond = uniswapFeeFactor;
    } else {
      feeFactorFirst = uniswapFeeFactor;
      feeFactorSecond = sushiswapFeeFactor;
    }
    console.log(`Fee factors - First: ${feeFactorFirst}, Second: ${feeFactorSecond}`);

    const slippageTolerance = 0.10;
    let minAmountOut1, minAmountOut2, expectedARBFloat;

    if (direction) {
      const priceFirst = cachedSushiSwapPrice;
      const priceSecond = cachedUniswapPrice;
      console.log(`Prices - SushiSwap: ${priceFirst}, Uniswap: ${priceSecond}`);

      const expectedWETHFloat = Number(ethers.formatUnits(loanAmount, 18)) * priceFirst * feeFactorFirst;
      const expectedWETH = ethers.parseUnits(expectedWETHFloat.toFixed(18), 18);
      minAmountOut1 = (expectedWETH * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;

      expectedARBFloat = expectedWETHFloat / priceSecond * feeFactorSecond;
      const expectedARB = ethers.parseUnits(expectedARBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedARB * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;
    } else {
      const priceFirst = cachedUniswapPrice;
      const priceSecond = cachedSushiSwapPrice;
      console.log(`Prices - Uniswap: ${priceFirst}, SushiSwap: ${priceSecond}`);

      const expectedWETHFloat = Number(ethers.formatUnits(loanAmount, 18)) * priceFirst * feeFactorFirst;
      const expectedWETH = ethers.parseUnits(expectedWETHFloat.toFixed(18), 18);
      minAmountOut1 = (expectedWETH * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;

      expectedARBFloat = expectedWETHFloat / priceSecond * feeFactorSecond;
      const expectedARB = ethers.parseUnits(expectedARBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedARB * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;
    }

    const premiumRate = Number(cachedFlashloanPremium) / 10000;
    const totalDebtFloat = Number(ethers.formatUnits(loanAmount, 18)) * (1 + premiumRate);
    const totalDebt = ethers.parseUnits(totalDebtFloat.toFixed(18), 18);
    const expectedFinalAmount = ethers.parseUnits(expectedARBFloat.toFixed(18), 18);

    const minAmountOut1WETH = ethers.formatUnits(minAmountOut1, 18);
    const minAmountOut1USD = Number(minAmountOut1WETH) * cachedWethUsdPrice;
    console.log(`minAmountOut1: ${minAmountOut1WETH} WETH (≈$${minAmountOut1USD.toFixed(2)} USD)`);

    const minAmountOut2ARB = ethers.formatUnits(minAmountOut2, 18);
    const minAmountOut2USD = Number(minAmountOut2ARB) * arbUsdPrice;
    console.log(`minAmountOut2: ${minAmountOut2ARB} ARB (≈$${minAmountOut2USD.toFixed(2)} USD)`);

    const expectedFinalAmountARB = expectedARBFloat.toFixed(18);
    const expectedFinalAmountUSD = expectedARBFloat * arbUsdPrice;
    console.log(`Expected final amount: ${expectedFinalAmountARB} ARB (≈$${expectedFinalAmountUSD.toFixed(2)} USD)`);

    const totalDebtARB = ethers.formatUnits(totalDebt, 18);
    const totalDebtUSD = Number(totalDebtARB) * arbUsdPrice;
    console.log(`Total debt: ${totalDebtARB} ARB (≈$${totalDebtUSD.toFixed(2)} USD)`);

    const deadline = Math.floor(Date.now() / 1000) + 45;
    const feeFirst = direction ? cachedSushiSwapFee : cachedUniswapFee;
    const feeSecond = direction ? cachedUniswapFee : cachedSushiSwapFee;

    let txData;
    try {
      txData = flashLoanArbitrage.interface.encodeFunctionData(
        "executeArbitrage",
        [ARB_ADDRESS, loanAmount, direction, minAmountOut1, minAmountOut2, deadline, feeFirst, feeSecond]
      );
      console.log(`Encoded tx data: ${txData}`);
    } catch (error) {
      console.error("Failed to encode transaction data:", error.message);
      throw error;
    }

    let nonce;
    try {
      nonce = await signer.provider.getTransactionCount(signer.address, "pending");
      console.log(`Using nonce: ${nonce}`);
    } catch (error) {
      console.error("Failed to fetch nonce:", error.message);
      throw error;
    }

    const fetchedFeeData = cachedFeeData;
    if (!fetchedFeeData) {
      console.error("Fee data unavailable");
      throw new Error("Fee data unavailable");
    }
    const baseFeePerGas = fetchedFeeData.lastBaseFeePerGas || fetchedFeeData.gasPrice;
    const suggestedMaxPriorityFeePerGas = fetchedFeeData.maxPriorityFeePerGas || fetchedFeeData.gasPrice;
    const reasonableTip = (suggestedMaxPriorityFeePerGas * 11n) / 10n;
    const buffer = ethers.parseUnits("0.1", "gwei");
    let maxFeePerGas = baseFeePerGas + reasonableTip + buffer;
    const suggestedMaxFeePerGas = fetchedFeeData.maxFeePerGas || (baseFeePerGas + suggestedMaxPriorityFeePerGas);
    if (maxFeePerGas < suggestedMaxFeePerGas) maxFeePerGas = suggestedMaxFeePerGas;

    console.log(`Priority Fee: ${ethers.formatUnits(reasonableTip, "gwei")} Gwei`);
    console.log(`Max Fee Per Gas: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);

    const tx = {
      from: signer.address,
      to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      data: txData,
      nonce: nonce,
      chainId: 42161n,
      type: 2,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: reasonableTip,
      gasLimit: 1000000n
    };

    console.log("Transaction object prepared:", JSON.stringify(tx, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value, 2));

    const signingStart = Date.now();
    let signedTx;
    try {
      signedTx = await signer.signTransaction(tx);
      console.log(`Signed transaction: ${signedTx}`);
    } catch (signError) {
      console.error("Failed to sign transaction:", signError.message);
      throw new Error(`Signing failed: ${signError.message}`);
    }
    const signingLatency = Date.now() - signingStart;
    console.log(`Signed in ${signingLatency} ms`);

    const sendStart = Date.now();
    let txHash;
    try {
      txHash = await httpProvider.send("eth_sendRawTransaction", [signedTx]);
      if (!txHash || !txHash.startsWith("0x")) {
        console.error("Invalid transaction hash received:", txHash);
        throw new Error(`Invalid transaction hash: ${txHash}`);
      }
      console.log(`⚡ TX Sent: ${txHash}`);
    } catch (sendError) {
      console.error("Failed to send transaction:", sendError.message);
      throw new Error(`Transaction submission failed: ${sendError.message}`);
    }
    const submissionLatency = Date.now() - sendStart;
    console.log(`Submission latency: ${submissionLatency} ms`);

    const totalLatency = Date.now() - startTime;
    console.log(`⏱️ Total latency: ${totalLatency} ms`);

    let receipt;
    try {
      receipt = await httpProvider.waitForTransaction(txHash);
      if (!receipt) {
        console.error("Transaction receipt is null for hash:", txHash);
        throw new Error("No receipt received");
      }
      console.log(`Transaction receipt received - Status: ${receipt.status}`);
      console.log("Receipt:", JSON.stringify(receipt, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    } catch (waitError) {
      console.error("Failed to wait for transaction confirmation:", waitError.message);
      throw new Error(`Confirmation wait failed: ${waitError.message}`);
    }

    if (receipt) {
      if (!receipt.transactionHash) {
        console.log("Receipt keys:", Object.keys(receipt));
      }
      console.log(`📜 Transaction logs for TX: ${receipt.transactionHash || 'unknown'}`);
      console.log("Number of logs:", receipt.logs.length);

      if (receipt.logs.length === 0) {
        console.log("No logs emitted before revert.");
      } else {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            console.log(`Event: ${parsedLog.name}`);
            parsedLog.fragment.inputs.forEach((input, index) => {
              const argName = input.name || `arg${index}`;
              let argValue = parsedLog.args[index];
              argValue = typeof argValue === 'bigint' ? argValue.toString() : argValue.toString();
              console.log(`  ${argName}: ${argValue}`);
            });
          } catch (e) {
            console.log("Log skipped (not from contract):", log);
          }
        }
      }

      let profitInARB = 0n;
      let success = false;
      if (receipt.status === 1) {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "ArbitrageExecuted") {
              profitInARB = parsedLog.args.profit;
              success = parsedLog.args.success;
              console.log(`ArbitrageExecuted event - Profit: ${ethers.formatUnits(profitInARB, 18)} ARB, Success: ${success}`);
              if (success) break;
            }
          } catch (e) {
            // Not our event, skip
          }
        }
      } else {
        console.log(`Transaction failed with status: ${receipt.status}`);
      }

      const sellPrice = direction ? cachedSushiSwapPrice : cachedUniswapPrice;
      const profitInWETH = Number(ethers.formatUnits(profitInARB, 18)) * sellPrice;
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice || cachedFeeData.gasPrice;
      const gasCostInWei = gasUsed * effectiveGasPrice;
      const gasCostInWETH = Number(ethers.formatUnits(gasCostInWei, 18));

      const loanAmountInWETH = Number(ethers.formatUnits(loanAmount, 18)) * cachedUniswapPrice;
      const swapFeeUniswap = loanAmountInWETH * (Number(cachedUniswapFee) / 1e6);
      const swapFeeSushiSwap = loanAmountInWETH * (Number(cachedSushiSwapFee) / 1e6);

      const netPnL = profitInWETH - gasCostInWETH;
      cumulativePnLInWETH += netPnL;

      logTransactionDetails(
        arbitrageCount,
        receipt.transactionHash,
        direction,
        loanAmount,
        profitInWETH,
        gasCostInWETH,
        swapFeeUniswap,
        swapFeeSushiSwap,
        netPnL,
        cumulativePnLInWETH,
        receipt.status
      );
      checkStopCondition();
    }

    fs.appendFileSync("time.txt", `Arbitrage #${arbitrageCount}: Total latency ${totalLatency} ms, signing ${signingLatency} ms, submission ${submissionLatency} ms\n`);
  } catch (error) {
    console.error("Execution failed for transaction #" + arbitrageCount + ":", error.message);
    const timestamp = new Date().toISOString();
    const logMessage = `
Timestamp: ${timestamp}
Transaction #${arbitrageCount}
Status: Failed to send
Error: ${error.message}
--------------------------------------------------
`;
    fs.appendFileSync("p&l.txt", logMessage);
    logTransactionDetails(
      arbitrageCount,
      null,
      direction,
      loanAmount || 0n,
      0,
      0,
      0,
      0,
      0,
      cumulativePnLInWETH,
      0,
      error.message
    );
  } finally {
    executingTransactions--;
    console.log(`Transaction completed. Executing transactions: ${executingTransactions}`);
    if (executingTransactions === 0) {
      checkArbitrage("PostTransaction");
    }
  }
};

/** Check stop-loss condition dynamically */
const checkStopCondition = () => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price is zero, cannot check stop condition");
    return;
  }
  const stopLossWeth = STOP_LOSS_USD / cachedWethUsdPrice;
  if (cumulativePnLInWETH <= -stopLossWeth) {
    console.log(`Net PnL ${cumulativePnLInWETH} WETH (≈$${cumulativePnLInWETH * cachedWethUsdPrice} USD) ≤ -${stopLossWeth} WETH (≈$${STOP_LOSS_USD} USD). Stopping bot.`);
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