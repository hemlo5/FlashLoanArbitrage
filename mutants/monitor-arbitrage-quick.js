const { ethers } = require("hardhat");
const fs = require("fs"); // for file logging
require("dotenv").config();

// ========== CONFIGURATION ==========
const WPOL_ADDRESS = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const UNISWAP_V3_POOL_ADDRESS = "0xa374094527e1673a86de625aa59517c5de346d32";
const QUICKSWAP_V3_POOL_ADDRESS = "0xae81fac689a1b4b1e06e7ef4a2ab4cd8ac0a087d";
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x398E4948e373Db819606A459456176D31C3B1F91";
const BORROW_VALUE_USDC = 1000;
const ARBITRAGE_THRESHOLD = 0.001; // Set threshold for triggering arbitrage

// Fee configuration (e.g., 3000 represents a 0.3% fee)
const FEE1 = 3000;
const FEE2 = 3000;

// ========== ABI DEFINITIONS ==========
const UNISWAP_V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const ALGEBRA_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function globalState() view returns (uint160 sqrtPriceX96, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address token, uint256 amount, bool direction, uint256, uint256, uint256, uint24, uint24) external"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, quickswapV3Pool, flashLoanArbitrage;
let uniswapIsWPOLFirst, quickswapIsWPOLFirst;
let cachedUniswapPrice = 0, cachedQuickSwapPrice = 0;
const swapEventTimestamps = {};
let highestPriceDiff = 0;  // Cache for highest price diff ever found
let arbitrageCount = 0;    // Counter for arbitrage opportunities

// Cached nonce for transaction signing
let cachedNonce = null;

// Variable to track when an arbitrage opportunity was first triggered
let arbOpportunityStartTime = null;

// ========== CORE FUNCTIONS ==========

const connectWebSocket = async () => {
  wsProvider = new ethers.WebSocketProvider(process.env.POLYGON_WS_RPC_URL);

  wsProvider.websocket.on("close", (code) => {
    console.error(`WebSocket closed (${code}). Reconnecting...`);
    setTimeout(connectWebSocket, 3000);
  });

  wsProvider.websocket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    wsProvider.websocket.close();
  });

  await wsProvider.ready;
  console.log("✅ WebSocket connected");
  
  setupEventListeners();
  updateFeeData();
  setInterval(updateFeeData, 10000);
};

const updateFeeData = async () => {
  try {
    cachedFeeData = await wsProvider.getFeeData();
    console.log("⛽ Gas Update - Base:", ethers.formatUnits(cachedFeeData.gasPrice, "gwei"), "Gwei");
  } catch (error) {
    console.error("Gas update failed:", error.message);
  }
};

const setupEventListeners = () => {
  [uniswapV3Pool, quickswapV3Pool].forEach(pool => pool.removeAllListeners("Swap"));

  uniswapV3Pool.on("Swap", (_, __, ___, ____, sqrtPriceX96) => {
    const price = calculateV3Price(sqrtPriceX96, uniswapIsWPOLFirst);
    cachedUniswapPrice = price;
    swapEventTimestamps["Uniswap"] = Date.now();
    console.log(`🔄 [Uniswap] Swap event detected at WPOL Price: ${price}`);
    checkArbitrage("Uniswap");
  });

  quickswapV3Pool.on("Swap", (_, __, ___, ____, sqrtPriceX96) => {
    const price = calculateV3Price(sqrtPriceX96, quickswapIsWPOLFirst);
    cachedQuickSwapPrice = price;
    swapEventTimestamps["QuickSwap"] = Date.now();
    console.log(`🔄 [QuickSwap] Swap event detected at WPOL Price: ${price}`);
    checkArbitrage("QuickSwap");
  });
};

const calculateV3Price = (sqrtPriceX96, isWPOLFirst) => {
  const decimalsWPOL = 18;
  const decimalsUSDC = 6;
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2;
  return isWPOLFirst 
    ? priceRatio * 10 ** (decimalsWPOL - decimalsUSDC)
    : (1 / priceRatio) * 10 ** (decimalsUSDC - decimalsWPOL);
};

const calculateLoanAmount = (targetPrice) => {
  const WPOLiAmountFloat = BORROW_VALUE_USDC / targetPrice;
  const WPOLiAmountStr = WPOLiAmountFloat.toFixed(18);
  return ethers.parseUnits(WPOLiAmountStr, 18); // BigInt in ethers v6
};

const fetchFreshPrices = async () => {
  const slot0Uni = await uniswapV3Pool.slot0();
  const globalStateQuick = await quickswapV3Pool.globalState();

  const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsWPOLFirst);
  const freshPriceQuick = calculateV3Price(globalStateQuick.sqrtPriceX96, quickswapIsWPOLFirst);

  console.log(`Fresh Uniswap price: ${freshPriceUni}`);
  console.log(`Fresh QuickSwap price: ${freshPriceQuick}`);

  return { freshPriceUni, freshPriceQuick };
};

const checkArbitrage = (dex) => {
  if (!cachedUniswapPrice || !cachedQuickSwapPrice) return;

  const priceDiff = Math.abs(cachedUniswapPrice - cachedQuickSwapPrice);
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;
  
  if (priceDiff > ARBITRAGE_THRESHOLD) {
    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity started at ${arbOpportunityStartTime}`);
      
      // Schedule a fresh-price check after 2 seconds
      setTimeout(async () => {
        try {
          console.log(`⏳ Fetching prices 2s after opportunity...`);
          const { freshPriceUni, freshPriceQuick } = await fetchFreshPrices();
          const newPriceDiff = Math.abs(freshPriceUni - freshPriceQuick);
          const timestamp = Date.now();
          const logMessage = `Price difference after 2s: ${newPriceDiff} at ${timestamp}\n`;
          console.log(logMessage);
          fs.appendFileSync("time.txt", logMessage);
        } catch (err) {
          console.error("Fresh price check failed:", err.message);
          fs.appendFileSync("time.txt", `Error during fresh price check: ${err.message}\n`);
        }
      }, 2000); // Changed from 2500 to 2000 for 2 seconds
    }
    arbitrageCount++;
    console.log(`🚨 Arbitrage opportunity #${arbitrageCount} triggered: Price diff ${priceDiff} (Highest diff: ${highestPriceDiff})`);
    const direction = cachedUniswapPrice > cachedQuickSwapPrice;
    executePresignedArbitrage(direction, swapEventTimestamps[dex] || Date.now());
  } else {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now() - arbOpportunityStartTime;
      console.log(`ℹ️ Arbitrage opportunity vanished after ${vanishTime} ms.`);
      fs.appendFileSync("time.txt", `Opportunity lasted: ${vanishTime} ms, pricediff: ${priceDiff}\n`);
      arbOpportunityStartTime = null;
    }
    console.log(`ℹ️ No arbitrage opportunity. Price diff: ${priceDiff} (Highest diff: ${highestPriceDiff}) | Count: ${arbitrageCount}`);
  }
};

const executePresignedArbitrage = async (direction, startTime) => {
  try {
    console.log("Starting arbitrage execution");
    const targetPrice = direction ? cachedQuickSwapPrice : cachedUniswapPrice;
    console.log(`Target price: ${targetPrice}`);
    const loanAmount = calculateLoanAmount(targetPrice);
    console.log(`Calculated loan amount (human-readable): ${ethers.formatUnits(loanAmount, 18)} WPOL`);
    const minAmount = (loanAmount * 995n) / 1000n;
    console.log(`Minimum acceptable amount: ${ethers.formatUnits(minAmount, 18)} WPOL`);
    const deadline = Math.floor(Date.now() / 1000) + 45;
    console.log(`Deadline set to: ${deadline}`);

    const txData = flashLoanArbitrage.interface.encodeFunctionData(
      "executeArbitrage",
      [WPOL_ADDRESS, loanAmount, direction, minAmount, minAmount, deadline, FEE1, FEE2]
    );
    console.log(`Encoded tx data: ${txData}`);

    if (cachedNonce === null) {
      cachedNonce = await signer.provider.getTransactionCount(signer.address, "pending");
      console.log(`Fetched nonce: ${cachedNonce}`);
    }
    const nonceToUse = cachedNonce;
    cachedNonce++;
    console.log(`Using nonce: ${nonceToUse} (Cached nonce updated to ${cachedNonce})`);

    const basePriorityFee = ethers.parseUnits("50", "gwei");
    const randomBump = BigInt(Math.floor(Math.random() * 3000000000)) + 2000000000n;
    const bumpedPriorityFee = basePriorityFee + randomBump;
    console.log(`Bumped Priority Fee: ${bumpedPriorityFee.toString()}`);

    const tx = {
      from: signer.address,
      to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      data: txData,
      nonce: nonceToUse,
      chainId: 137,
      type: 2,
      maxFeePerGas: ethers.parseUnits("500", "gwei"),
      maxPriorityFeePerGas: bumpedPriorityFee,
      gasLimit: 500000
    };

    const signingStart = Date.now();
    const signedTx = await signer.signTransaction(tx);
    const signingLatency = Date.now() - signingStart;
    console.log(`Transaction signed in ${signingLatency} ms`);
    
    const sendStart = Date.now();
    const txResponse = await httpProvider.send("eth_sendRawTransaction", [signedTx]);
    const submissionLatency = Date.now() - sendStart;
    console.log(`⚡ TX Mined: ${txResponse.transactionHash}`);
    const totalLatency = Date.now() - startTime;
    console.log(`⏱️ Total latency (from swap event to transaction sent): ${totalLatency} ms`);
    console.log(`⏱️ Transaction submission latency: ${submissionLatency} ms`);

    // Write latency details to time.txt
    const logMessage = `Arbitrage #${arbitrageCount}: Total latency ${totalLatency} ms, signing latency ${signingLatency} ms, submission latency ${submissionLatency} ms\n`;
    fs.appendFileSync("time.txt", logMessage);
  } catch (error) {
    console.error("Execution failed:", error.message);
  }
};

// ========== INITIALIZATION ==========
(async () => {
  httpProvider = new ethers.JsonRpcProvider(process.env.POLYGON_HTTP_RPC_URL);
  signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
  
  uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, UNISWAP_V3_POOL_ABI, httpProvider);
  quickswapV3Pool = new ethers.Contract(QUICKSWAP_V3_POOL_ADDRESS, ALGEBRA_POOL_ABI, httpProvider);
  flashLoanArbitrage = new ethers.Contract(
    FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
    FLASHLOAN_ARBITRAGE_ABI,
    signer
  );

  cachedNonce = await signer.provider.getTransactionCount(signer.address, "pending");
  console.log(`Initial cached nonce: ${cachedNonce}`);

  const [uniToken0, quickToken0] = await Promise.all([
    uniswapV3Pool.token0(),
    quickswapV3Pool.token0()
  ]);
  uniswapIsWPOLFirst = uniToken0.toLowerCase() === WPOL_ADDRESS.toLowerCase();
  quickswapIsWPOLFirst = quickToken0.toLowerCase() === WPOL_ADDRESS.toLowerCase();

  connectWebSocket();
})();