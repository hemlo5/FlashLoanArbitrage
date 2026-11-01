const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"; // WBNB on BSC
const BUSD_ADDRESS = "0xe9e7cea3dedca5984780bafc599bd69add087d56"; // BUSD on BSC
const UNISWAP_V3_POOL_ADDRESS = "0xdb2177fee5b0ebdc7b8038cb70f3964bb6d14143"; // Placeholder: Uniswap V3 WBNB/BUSD pool on BSC (replace with actual address if a fork exists)
const PANWBNBSWAP_V2_PAIR_ADDRESS = "0x58f876857a02d6762e0101bb5c46a8c1ed44dc16"; // Placeholder: PanWBNBSwap V2 WBNB/BUSD pair on BSC (replace with actual address)
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x26C1B0ac65B0320375bf112a6357addebA2b7471"; // Placeholder: Update to your deployed contract address on BSC
const BORROW_VALUE_USD = 10; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 2;
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_BUSD_USD_ADDRESS = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"; // Chainlink BNB/USD on BSC
const FLASHLOAN_PROVIDER_ADDRESS = "0x6807dc923806fE8Fd134338EABCA509979a7e0cB"; // Placeholder: Flashloan provider on BSC (e.g., Venus or custom contract)

// ========== ABI DEFINITIONS ==========
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Sync(uint112 reserve0, uint112 reserve1)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address token, uint256 amount, bool direction, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 fee1, uint24 fee2) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const FLASHLOAN_PROVIDER_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint256)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, panWBNBswapV2Pair, flashLoanArbitrage, chainlinkBUSDUsd;
let uniswapIsWBNBFirst, panWBNBswapIsWBNBFirst;
let cachedUniswapPrice = 0, cachedPanWBNBswapPrice = 0;
let cachedBUSDUsdPrice = 0;
let cachedUniswapFee, cachedFlashloanPremium;
const swapEventTimestamps = {};
let highestPriceDiff = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let cumulativePnLInBUSD = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 2;

// ========== CORE FUNCTIONS ==========

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
  wsProvider = new ethers.WebSocketProvider(process.env.BSC_WS_RPC_URL);

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
    console.log("✅ WebSocket connected to BSC");
  } catch (error) {
    console.error("WebSocket connection failed:", error.message);
    return;
  }

  uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
  panWBNBswapV2Pair = new ethers.Contract(PANWBNBSWAP_V2_PAIR_ADDRESS, V2_PAIR_ABI, wsProvider);
  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkBUSDUsd = new ethers.Contract(CHAINLINK_BUSD_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const flashloanProvider = new ethers.Contract(FLASHLOAN_PROVIDER_ADDRESS, FLASHLOAN_PROVIDER_ABI, wsProvider);

  try {
    const [uniToken0, uniToken1, panWBNBToken0, panWBNBToken1] = await Promise.all([
      uniswapV3Pool.token0(),
      uniswapV3Pool.token1(),
      panWBNBswapV2Pair.token0(),
      panWBNBswapV2Pair.token1()
    ]);
    console.log(`Uniswap V3 token0: ${uniToken0}, token1: ${uniToken1}`);
    console.log(`PanWBNBSwap V2 token0: ${panWBNBToken0}, token1: ${panWBNBToken1}`);
    uniswapIsWBNBFirst = uniToken0.toLowerCase() === WBNB_ADDRESS.toLowerCase();
    panWBNBswapIsWBNBFirst = panWBNBToken0.toLowerCase() === WBNB_ADDRESS.toLowerCase();
    console.log(`Uniswap isWBNBFirst: ${uniswapIsWBNBFirst}`);
    console.log(`PanWBNBSwap isWBNBFirst: ${panWBNBswapIsWBNBFirst}`);
  } catch (error) {
    console.error("Failed to fetch pool/pair token details:", error.message);
    return;
  }

  try {
    cachedUniswapFee = await uniswapV3Pool.fee();
    cachedFlashloanPremium = await flashloanProvider.FLASHLOAN_PREMIUM_TOTAL();
    console.log(`Uniswap V3 Pool Fee: ${cachedUniswapFee} (${(Number(cachedUniswapFee) / 1e6) * 100}%)`);
    console.log(`Flashloan Premium: ${cachedFlashloanPremium} bps (${Number(cachedFlashloanPremium) / 10000}%)`);
    // PanWBNBSwap V2 has a fixed fee of 0.25%
    console.log(`PanWBNBSwap V2 Fee: 0.25% (fixed)`);
  } catch (error) {
    console.error("Failed to fetch fees or premium:", error.message);
    return;
  }

  await updateBUSDUsdPrice();
  try {
    const { freshPriceUni, freshPricePanWBNB } = await fetchFreshPrices();
    cachedUniswapPrice = freshPriceUni;
    cachedPanWBNBswapPrice = freshPricePanWBNB;
  } catch (error) {
    console.error("Initial price fetch failed:", error.message);
  }

  await updateFeeData();
  checkArbitrage("Initial");
  setupEventListeners();

  setInterval(updateFeeData, 10000);
  setInterval(updateBUSDUsdPrice, 60000);
};

/** Update BUSD/USD price from Chainlink */
const updateBUSDUsdPrice = async () => {
  try {
    const price = await chainlinkBUSDUsd.latestAnswer();
    const decimals = Number(await chainlinkBUSDUsd.decimals());
    cachedBUSDUsdPrice = Number(price) / 10 ** decimals;
    console.log(`💵 Updated BUSD/USD price: ${cachedBUSDUsdPrice}`);
  } catch (error) {
    console.error("Failed to update BUSD/USD price:", error.message);
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

/** Set up swap and sync event listeners for price updates */
const setupEventListeners = () => {
  uniswapV3Pool.removeAllListeners("Swap");
  panWBNBswapV2Pair.removeAllListeners("Sync");

  uniswapV3Pool.on("Swap", (_, __, ___, ____, sqrtPriceX96) => {
    const price = calculateV3Price(sqrtPriceX96, uniswapIsWBNBFirst);
    cachedUniswapPrice = price;
    swapEventTimestamps["Uniswap"] = Date.now();
    console.log(`🔄 [UniswapV3] Swap event at WBNB Price: ${price} BUSD`);
    checkArbitrage("Uniswap");
  });

  panWBNBswapV2Pair.on("Sync", (reserve0, reserve1) => {
    const price = calculateV2Price(reserve0, reserve1, panWBNBswapIsWBNBFirst);
    cachedPanWBNBswapPrice = price;
    swapEventTimestamps["PanWBNBSwap"] = Date.now();
    console.log(`🔄 [PanWBNBSwapV2] Sync event at WBNB Price: ${price} BUSD`);
    checkArbitrage("PanWBNBSwap");
  });
};

/** Calculate WBNB/BUSD price from sqrtPriceX96 for V3 */
const calculateV3Price = (sqrtPriceX96, isWBNBFirst) => {
  const decimalsWBNB = 18;
  const decimalsBUSD = 18;
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2;
  const price = isWBNBFirst 
    ? priceRatio * 10 ** (decimalsWBNB - decimalsBUSD)
    : (1 / priceRatio) * 10 ** (decimalsBUSD - decimalsWBNB);
  console.log(`Calculated V3 price: ${price} (isWBNBFirst: ${isWBNBFirst})`);
  return price;
};

/** Calculate WBNB/BUSD price from reserves for V2 */
const calculateV2Price = (reserve0, reserve1, isWBNBFirst) => {
  if (isWBNBFirst) {
    return Number(reserve1) / Number(reserve0);
  } else {
    return Number(reserve0) / Number(reserve1);
  }
};

/** Calculate loan amount in WBNB based on USD value */
const calculateLoanAmount = (targetPrice) => {
  if (cachedBUSDUsdPrice === 0) {
    console.error("BUSD/USD price not available for loan calculation");
    throw new Error("BUSD/USD price not available");
  }
  const borrowValueBUSD = BORROW_VALUE_USD / cachedBUSDUsdPrice;
  const WBNBAmountFloat = borrowValueBUSD / targetPrice;
  const WBNBAmountStr = WBNBAmountFloat.toFixed(18);
  const loanAmount = ethers.parseUnits(WBNBAmountStr, 18);
  const loanAmountUSD = WBNBAmountFloat * targetPrice * cachedBUSDUsdPrice;
  console.log(`Calculated loan amount: ${ethers.formatUnits(loanAmount, 18)} WBNB (≈$${loanAmountUSD.toFixed(2)} USD)`);
  return loanAmount;
};

/** Fetch current prices from both DEXs with retry logic */
const fetchFreshPricesWithRetry = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const slot0Uni = await uniswapV3Pool.slot0();
      const reservesPanWBNB = await panWBNBswapV2Pair.getReserves();
      const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsWBNBFirst);
      const freshPricePanWBNB = calculateV2Price(reservesPanWBNB.reserve0, reservesPanWBNB.reserve1, panWBNBswapIsWBNBFirst);
      console.log(`Fresh UniswapV3 price: ${freshPriceUni}`);
      console.log(`Fresh PanWBNBSwapV2 price: ${freshPricePanWBNB}`);
      return { freshPriceUni, freshPricePanWBNB };
    } catch (err) {
      console.error(`Fetch fresh prices attempt ${i + 1} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};

/** Original fetchFreshPrices for initialization */
const fetchFreshPrices = async () => {
  try {
    const slot0Uni = await uniswapV3Pool.slot0();
    const reservesPanWBNB = await panWBNBswapV2Pair.getReserves();
    const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsWBNBFirst);
    const freshPricePanWBNB = calculateV2Price(reservesPanWBNB.reserve0, reservesPanWBNB.reserve1, panWBNBswapIsWBNBFirst);
    console.log(`Fresh UniswapV3 price: ${freshPriceUni}`);
    console.log(`Fresh PanWBNBSwapV2 price: ${freshPricePanWBNB}`);
    return { freshPriceUni, freshPricePanWBNB };
  } catch (error) {
    console.error("Failed to fetch fresh prices during initialization:", error.message);
    throw error;
  }
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
    panWBNBswapV2Pair.removeAllListeners("Sync");
    wsProvider.websocket.close();
    return;
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("Max executing transactions reached, waiting for completion.");
    return;
  }

  if (!cachedUniswapPrice || !cachedPanWBNBswapPrice) {
    console.log("Price data missing - Uniswap:", cachedUniswapPrice, "PanWBNBSwap:", cachedPanWBNBswapPrice);
    return;
  }

  const priceDiff = Math.abs(cachedUniswapPrice - cachedPanWBNBswapPrice);
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;
  
  if (priceDiff > ARBITRAGE_THRESHOLD) {
    (async () => {
      try {
        const { freshPriceUni, freshPricePanWBNB } = await fetchFreshPricesWithRetry();
        const doubleCheckPriceDiff = Math.abs(freshPriceUni - freshPricePanWBNB);
        const timestamp = Date.now();
        const logMessage = `Double-check at opportunity detection: Uniswap=${freshPriceUni.toFixed(18)}, PanWBNBSwap=${freshPricePanWBNB.toFixed(18)}, PriceDiff=${doubleCheckPriceDiff.toFixed(18)} at ${timestamp}\n`;
        console.log(logMessage);
        fs.appendFileSync("time.txt", logMessage);
      } catch (err) {
        console.error("Double-check price fetch failed:", err.message);
        fs.appendFileSync("time.txt", `Error during double-check price fetch: ${err.message}\n`);
      }
    })();

    setTimeout(async () => {
      try {
        console.log(`⏳ Fetching prices 2s after opportunity detection #${arbitrageCount + 1}...`);
        const { freshPriceUni, freshPricePanWBNB } = await fetchFreshPricesWithRetry();
        const newPriceDiff = Math.abs(freshPriceUni - freshPricePanWBNB);
        const timestamp = Date.now();
        const logMessage = `Price difference after 2s for detection #${arbitrageCount + 1}: ${newPriceDiff.toFixed(18)} at ${timestamp}\n`;
        console.log(logMessage);
        fs.appendFileSync("time.txt", logMessage);
      } catch (err) {
        console.error("Fresh price check failed:", err.message);
        fs.appendFileSync("time.txt", `Error during fresh price check: ${err.message}\n`);
      }
    }, 2000);

    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity started at ${arbOpportunityStartTime}`);
    }
    arbitrageCount++;
    console.log(`🚨 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
    console.log(`Uniswap: 1 WBNB = ${cachedUniswapPrice} BUSD (≈$${(cachedUniswapPrice * cachedBUSDUsdPrice).toFixed(6)} USD)`);
    console.log(`PanWBNBSwap: 1 WBNB = ${cachedPanWBNBswapPrice} BUSD (≈$${(cachedPanWBNBswapPrice * cachedBUSDUsdPrice).toFixed(6)} USD)`);
    const direction = cachedPanWBNBswapPrice > cachedUniswapPrice;
    console.log(`Direction: ${direction ? "PanWBNBSwap -> Uniswap" : "Uniswap -> PanWBNBSwap"}`);
    executePresignedArbitrage(direction, swapEventTimestamps[dex] || Date.now());
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
const logTransactionDetails = (serial, txHash, direction, loanAmount, profitInBUSD, gasCostInBUSD, swapFeeUniswap, swapFeePanWBNBswap, netPnL, cumulativePnL, txStatus, error = null) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const WBNBUsdPrice = cachedUniswapPrice * cachedBUSDUsdPrice;
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * WBNBUsdPrice;
  const profitUSD = profitInBUSD * cachedBUSDUsdPrice;
  const gasCostUSD = gasCostInBUSD * cachedBUSDUsdPrice;
  const swapFeeUniswapUSD = swapFeeUniswap * cachedBUSDUsdPrice;
  const swapFeePanWBNBswapUSD = swapFeePanWBNBswap * cachedBUSDUsdPrice;
  const netPnLUSD = netPnL * cachedBUSDUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedBUSDUsdPrice;

  const logMessage = `
Timestamp: ${timestamp}
Transaction #${serial}
Status: ${statusText}
Transaction Hash: ${txHash || 'N/A'}
Direction: ${direction ? "PanWBNBSwap -> Uniswap" : "Uniswap -> PanWBNBSwap"}
Loan Amount: ${ethers.formatUnits(loanAmount, 18)} WBNB (≈$${loanAmountUSD.toFixed(2)} USD)
Profit (before gas and swap fees): ${profitInBUSD.toFixed(18)} BUSD (≈$${profitUSD.toFixed(2)} USD)
Gas Cost: ${gasCostInBUSD.toFixed(18)} BUSD (≈$${gasCostUSD.toFixed(2)} USD)
Uniswap V3 Swap Fee: ${swapFeeUniswap.toFixed(18)} BUSD (≈$${swapFeeUniswapUSD.toFixed(2)} USD)
PanWBNBSwap V2 Swap Fee: ${swapFeePanWBNBswap.toFixed(18)} BUSD (≈$${swapFeePanWBNBswapUSD.toFixed(2)} USD)
Net PnL: ${netPnL.toFixed(18)} BUSD (≈$${netPnLUSD.toFixed(2)} USD)
Cumulative PnL: ${cumulativePnL.toFixed(18)} BUSD (≈$${cumulativePnLUSD.toFixed(2)} USD)${errorMessage}
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

    const targetPrice = direction ? cachedPanWBNBswapPrice : cachedUniswapPrice;
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

    const WBNBUsdPrice = cachedUniswapPrice * cachedBUSDUsdPrice;

    const uniswapFeeFactor = 1 - Number(cachedUniswapFee) / 1e6;
    const panWBNBswapFeeFactor = 0.9975; // Fixed 0.25% fee for PanWBNBSwap V2
    let feeFactorFirst, feeFactorSecond;
    if (direction) {
      feeFactorFirst = panWBNBswapFeeFactor;
      feeFactorSecond = uniswapFeeFactor;
    } else {
      feeFactorFirst = uniswapFeeFactor;
      feeFactorSecond = panWBNBswapFeeFactor;
    }
    console.log(`Fee factors - First: ${feeFactorFirst}, Second: ${feeFactorSecond}`);

    const slippageTolerance = 0.10;
    let minAmountOut1, minAmountOut2, expectedWBNBFloat;

    if (direction) {
      const priceFirst = cachedPanWBNBswapPrice;
      const priceSecond = cachedUniswapPrice;
      console.log(`Prices - PanWBNBSwap: ${priceFirst}, Uniswap: ${priceSecond}`);

      const expectedBUSDFloat = Number(ethers.formatUnits(loanAmount, 18)) * priceFirst * feeFactorFirst;
      const expectedBUSD = ethers.parseUnits(expectedBUSDFloat.toFixed(18), 18);
      minAmountOut1 = (expectedBUSD * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;

      expectedWBNBFloat = expectedBUSDFloat / priceSecond * feeFactorSecond;
      const expectedWBNB = ethers.parseUnits(expectedWBNBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedWBNB * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;
    } else {
      const priceFirst = cachedUniswapPrice;
      const priceSecond = cachedPanWBNBswapPrice;
      console.log(`Prices - Uniswap: ${priceFirst}, PanWBNBSwap: ${priceSecond}`);

      const expectedBUSDFloat = Number(ethers.formatUnits(loanAmount, 18)) * priceFirst * feeFactorFirst;
      const expectedBUSD = ethers.parseUnits(expectedBUSDFloat.toFixed(18), 18);
      minAmountOut1 = (expectedBUSD * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;

      expectedWBNBFloat = expectedBUSDFloat / priceSecond * feeFactorSecond;
      const expectedWBNB = ethers.parseUnits(expectedWBNBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedWBNB * BigInt(Math.floor(slippageTolerance * 10000))) / 10000n;
    }

    const premiumRate = Number(cachedFlashloanPremium) / 10000;
    const totalDebtFloat = Number(ethers.formatUnits(loanAmount, 18)) * (1 + premiumRate);
    const totalDebt = ethers.parseUnits(totalDebtFloat.toFixed(18), 18);
    const expectedFinalAmount = ethers.parseUnits(expectedWBNBFloat.toFixed(18), 18);

    const minAmountOut1BUSD = ethers.formatUnits(minAmountOut1, 18);
    const minAmountOut1USD = Number(minAmountOut1BUSD) * cachedBUSDUsdPrice;
    console.log(`minAmountOut1: ${minAmountOut1BUSD} BUSD (≈$${minAmountOut1USD.toFixed(2)} USD)`);

    const minAmountOut2WBNB = ethers.formatUnits(minAmountOut2, 18);
    const minAmountOut2USD = Number(minAmountOut2WBNB) * WBNBUsdPrice;
    console.log(`minAmountOut2: ${minAmountOut2WBNB} WBNB (≈$${minAmountOut2USD.toFixed(2)} USD)`);

    const expectedFinalAmountWBNB = expectedWBNBFloat.toFixed(18);
    const expectedFinalAmountUSD = expectedWBNBFloat * WBNBUsdPrice;
    console.log(`Expected final amount: ${expectedFinalAmountWBNB} WBNB (≈$${expectedFinalAmountUSD.toFixed(2)} USD)`);

    const totalDebtWBNB = ethers.formatUnits(totalDebt, 18);
    const totalDebtUSD = Number(totalDebtWBNB) * WBNBUsdPrice;
    console.log(`Total debt: ${totalDebtWBNB} WBNB (≈$${totalDebtUSD.toFixed(2)} USD)`);

    if (expectedFinalAmount <= totalDebt) {
      console.log(`Expected final amount ${ethers.formatUnits(expectedFinalAmount, 18)} WBNB (≈$${expectedFinalAmountUSD.toFixed(2)} USD) <= total debt ${ethers.formatUnits(totalDebt, 18)} WBNB (≈$${totalDebtUSD.toFixed(2)} USD). Skipping transaction.`);
      executingTransactions--;
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + 45;
    const feeFirst = direction ? 2500 : cachedUniswapFee; // 2500 for PanWBNBSwap V2 (0.25%)
    const feeSecond = direction ? cachedUniswapFee : 2500;

    let txData;
    try {
      txData = flashLoanArbitrage.interface.encodeFunctionData(
        "executeArbitrage",
        [WBNB_ADDRESS, loanAmount, direction, minAmountOut1, minAmountOut2, deadline, feeFirst, feeSecond]
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
      chainId: 56n, // BSC chain ID
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
              if (typeof argValue === 'bigint') {
                argValue = argValue.toString();
              } else {
                argValue = argValue.toString();
              }
              console.log(`  ${argName}: ${argValue}`);
            });
          } catch (e) {
            console.log("Log skipped (not from contract):", log);
          }
        }
      }

      let profitInWBNB = 0n;
      let success = false;
      if (receipt.status === 1) {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "ArbitrageExecuted") {
              profitInWBNB = parsedLog.args.profit;
              success = parsedLog.args.success;
              console.log(`ArbitrageExecuted event - Profit: ${ethers.formatUnits(profitInWBNB, 18)} WBNB, Success: ${success}`);
              if (success) break;
            }
          } catch (e) {
            // Not our event, skip
          }
        }
      } else {
        console.log(`Transaction failed with status: ${receipt.status}`);
      }

      const sellPrice = direction ? cachedPanWBNBswapPrice : cachedUniswapPrice;
      const profitInBUSD = Number(ethers.formatUnits(profitInWBNB, 18)) * sellPrice;
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice || cachedFeeData.gasPrice;
      const gasCostInWei = gasUsed * effectiveGasPrice;
      const gasCostInBUSD = Number(ethers.formatUnits(gasCostInWei, 18));

      const loanAmountInBUSD = Number(ethers.formatUnits(loanAmount, 18)) * cachedUniswapPrice;
      const swapFeeUniswap = loanAmountInBUSD * (Number(cachedUniswapFee) / 1e6);
      const swapFeePanWBNBswap = loanAmountInBUSD * 0.0025; // 0.25% fixed fee

      const netPnL = profitInBUSD - gasCostInBUSD;
      cumulativePnLInBUSD += netPnL;

      logTransactionDetails(
        arbitrageCount,
        receipt.transactionHash,
        direction,
        loanAmount,
        profitInBUSD,
        gasCostInBUSD,
        swapFeeUniswap,
        swapFeePanWBNBswap,
        netPnL,
        cumulativePnLInBUSD,
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
      cumulativePnLInBUSD,
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
  if (cachedBUSDUsdPrice === 0) {
    console.error("BUSD/USD price is zero, cannot check stop condition");
    return;
  }
  const stopLossBUSD = STOP_LOSS_USD / cachedBUSDUsdPrice;
  if (cumulativePnLInBUSD <= -stopLossBUSD) {
    console.log(`Net PnL ${cumulativePnLInBUSD} BUSD (≈$${cumulativePnLInBUSD * cachedBUSDUsdPrice} USD) ≤ -${stopLossBUSD} BUSD (≈$${STOP_LOSS_USD} USD). Stopping bot.`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    panWBNBswapV2Pair.removeAllListeners("Sync");
    wsProvider.websocket.close();
  }
};

// ========== INITIALIZATION ==========
(async () => {
  try {
    httpProvider = new ethers.JsonRpcProvider(process.env.BSC_HTTP_RPC_URL);
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