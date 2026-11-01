const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const TOKEN_A_ADDRESS = "0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8"; // PANIC on Arbitrum
const TOKEN_B_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH on Arbitrum
const UNISWAP_V3_POOL_ADDRESS = "0xb08a8794a5d3ccca3725d92964696858d3201909"; // Uniswap V3 PANIC/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0xbfca4230115de8341f3a3d5e8845ffb3337b2be3"; // SushiSwap V2 PANIC/WETH
const CAMELOT_V3_POOL_ADDRESS = "0xe461f84c3fe6bcdd1162eb0ef4284f3bb6e4cad3"; // Camelot V3 PANIC/WETH
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x2eb8Bd9540f61C219B2FF1f9d0E33C7F4B86c430"; // Assumes this contract uses Balancer
const BORROW_VALUE_USD = 1; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 0.1; // Threshold for arbitrage
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Chainlink TOKEN_B/USD on Arbitrum
const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer V2 Vault on Arbitrum
const GAS_FEE_MULTIPLIER = 1.0; // Set this to your desired multiplier (e.g., 1.5, 2.0)

// Boolean flags to enable/disable pools
const useUniswap = true;
const useSushiSwap = true;
const useCamelot = true;

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

const ALGEBRA_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function globalState() view returns (uint160 price, int24 tick, uint16 feeZto, uint16 feeOtz, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address poolBuy, address poolSell, address token, uint256 amount, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 feeBuy, uint24 feeSell) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const BALANCER_VAULT_ABI = [
  "function getProtocolFeesCollector() view returns (address)"
];

const PROTOCOL_FEES_COLLECTOR_ABI = [
  "function getFlashLoanFeePercentage() view returns (uint256)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, camelotV3Pool, flashLoanArbitrage, chainlinkTokenBUsd;
let uniswapIsTokenAFirst, sushiswapIsTokenAFirst, camelotIsTokenAFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0, cachedCamelotPrice = 0;
let cachedTokenBUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedCamelotFee, cachedFlashloanPremium;
let highestPriceDiff = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let cumulativePnLInTokenB = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 1; // Changed to 1 for sequential execution
let currentNonce;
const presignedTxCache = {};
const dexMap = {
  uniswap: { poolAddress: UNISWAP_V3_POOL_ADDRESS, fee: null, price: null },
  sushiSwap: { poolAddress: SUSHISWAP_V2_POOL_ADDRESS, fee: null, price: null },
  camelot: { poolAddress: CAMELOT_V3_POOL_ADDRESS, fee: null, price: null }
};

// ========== CORE FUNCTIONS ==========

/** Fetch and cache fees for all enabled DEXes */
const fetchAndCacheFees = async () => {
  if (useUniswap) {
    try {
      const fee = await uniswapV3Pool.fee();
      cachedUniswapFee = fee;
      dexMap.uniswap.fee = fee;
      console.log(`💲 Uniswap V3 Pool Fee: ${fee} (${(Number(fee) / 1e6) * 100}%)`);
    } catch (error) {
      console.error(`⚠️ Failed to fetch Uniswap fee: ${error.message}`);
    }
  }

  if (useSushiSwap) {
    cachedSushiSwapFee = 3000; // Fixed fee of 0.3% (3000 basis points)
    dexMap.sushiSwap.fee = 3000;
    console.log(`💲 SushiSwap V2 Pool Fee: 3000 (0.3%)`);
  }

  if (useCamelot) {
    try {
      const globalState = await camelotV3Pool.globalState();
      // Use feeZto as the fee; adjust to feeOtz if needed based on Camelot's pool configuration
      const fee = globalState.feeZto;
      cachedCamelotFee = fee;
      dexMap.camelot.fee = fee;
      console.log(`💲 Camelot V3 Pool Fee: ${fee} (${(Number(fee) / 1e6) * 100}%)`);
    } catch (error) {
      console.error(`⚠️ Failed to fetch Camelot fee: ${error.message}`);
      cachedCamelotFee = 500; // Fallback to 0.05% if retrieval fails
      dexMap.camelot.fee = 500;
      console.log(`💲 Camelot V3 Pool Fee (fallback): 500 (0.05%)`);
    }
  }
};

/** Update Uniswap price from pool state */
const updateUniswapPrice = async (blockTag = "latest") => {
  if (!useUniswap) return;
  console.log(`🔄 Updating Uniswap price for blockTag: ${blockTag}`);
  try {
    const slot0Uni = await uniswapV3Pool.slot0({ blockTag });
    cachedUniswapPrice = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsTokenAFirst);
    dexMap.uniswap.price = cachedUniswapPrice;
    console.log(`📊 Uniswap price updated: ${cachedUniswapPrice}`);
  } catch (e) {
    console.error(`⚠️ Uniswap slot0 call failed: ${e.message}`);
  }
};

/** Update SushiSwap price from pool state */
const updateSushiSwapPrice = async (blockTag = "latest") => {
  if (!useSushiSwap) return;
  console.log(`🔄 Updating SushiSwap price for blockTag: ${blockTag}`);
  try {
    const reservesSushi = await sushiswapV2Pool.getReserves({ blockTag });
    cachedSushiSwapPrice = calculateV2Price(reservesSushi, sushiswapIsTokenAFirst);
    dexMap.sushiSwap.price = cachedSushiSwapPrice;
    console.log(`📊 SushiSwap price updated: ${cachedSushiSwapPrice}`);
  } catch (e) {
    console.error(`⚠️ SushiSwap getReserves call failed: ${e.message}`);
  }
};

/** Update Camelot price from pool state */
const updateCamelotPrice = async (blockTag = "latest") => {
  if (!useCamelot) return;
  console.log(`🔄 Updating Camelot price for blockTag: ${blockTag}`);
  try {
    const globalStateCamelot = await camelotV3Pool.globalState({ blockTag });
    cachedCamelotPrice = calculateV3Price(globalStateCamelot.price, camelotIsTokenAFirst);
    dexMap.camelot.price = cachedCamelotPrice;
    console.log(`📊 Camelot price updated: ${cachedCamelotPrice}`);
  } catch (e) {
    console.error(`⚠️ Camelot globalState call failed: ${e.message}`);
  }
};

/** Calculate TOKEN_A/TOKEN_B price from sqrtPriceX96 (Uniswap V3 or Algebra) */
const calculateV3Price = (sqrtPriceX96, isTokenAFirst) => {
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2;
  return isTokenAFirst ? priceRatio : (1 / priceRatio);
};

/** Calculate TOKEN_A/TOKEN_B price from SushiSwap V2 reserves */
const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = Number(reserves.reserve0.toString());
  const reserve1 = Number(reserves.reserve1.toString());
  return isTokenAFirst ? reserve1 / reserve0 : reserve0 / reserve1;
};

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
  console.log("🌐 Connecting to WebSocket...");
  wsProvider = new ethers.WebSocketProvider(process.env.ARBITRUM_WS_RPC_URL);

  wsProvider.websocket.on("close", (code) => {
    console.log(`🔄 WebSocket closed (${code}). Reconnecting...`);
    setTimeout(connectWebSocket, 3000);
  });

  wsProvider.websocket.on("error", (error) => {
    console.error(`⚠️ WebSocket error: ${error.message}`);
    wsProvider.websocket.close();
  });

  try {
    const network = await wsProvider.getNetwork();
    console.log(`✅ WebSocket connected to network: ${network.name} (chainId: ${network.chainId})`);
  } catch (error) {
    console.error(`⚠️ WebSocket connection failed: ${error.message}`);
    return;
  }

  console.log("📦 Initializing contracts...");
  if (useUniswap) {
    uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
    try {
      const [uniToken0, uniToken1] = await Promise.all([uniswapV3Pool.token0(), uniswapV3Pool.token1()]);
      console.log(`ℹ️ Uniswap token0: ${uniToken0}, token1: ${uniToken1}`);
      uniswapIsTokenAFirst = uniToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
    } catch (error) {
      console.error(`⚠️ Failed to fetch Uniswap details: ${error.message}`);
    }
  }

  if (useSushiSwap) {
    sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
    try {
      const [sushiToken0, sushiToken1] = await Promise.all([sushiswapV2Pool.token0(), sushiswapV2Pool.token1()]);
      console.log(`ℹ️ SushiSwap token0: ${sushiToken0}, token1: ${sushiToken1}`);
      sushiswapIsTokenAFirst = sushiToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
    } catch (error) {
      console.error(`⚠️ Failed to fetch SushiSwap details: ${error.message}`);
    }
  }

  if (useCamelot) {
    camelotV3Pool = new ethers.Contract(CAMELOT_V3_POOL_ADDRESS, ALGEBRA_POOL_ABI, wsProvider);
    try {
      const [camelotToken0, camelotToken1] = await Promise.all([camelotV3Pool.token0(), camelotV3Pool.token1()]);
      console.log(`ℹ️ Camelot token0: ${camelotToken0}, token1: ${camelotToken1}`);
      camelotIsTokenAFirst = camelotToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
    } catch (error) {
      console.error(`⚠️ Failed to fetch Camelot details: ${error.message}`);
    }
  }

  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const balancerVault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, wsProvider);

  try {
    const protocolFeesCollectorAddress = await balancerVault.getProtocolFeesCollector();
    const protocolFeesCollector = new ethers.Contract(protocolFeesCollectorAddress, PROTOCOL_FEES_COLLECTOR_ABI, wsProvider);
    const flashLoanFeePercentage = await protocolFeesCollector.getFlashLoanFeePercentage();
    cachedFlashloanPremium = flashLoanFeePercentage;
    console.log(`💲 Balancer Flashloan Fee: ${flashLoanFeePercentage} (fee percentage: ${Number(flashLoanFeePercentage) / 1e18}%)`);
  } catch (error) {
    console.error(`⚠️ Failed to fetch Balancer flashloan fee: ${error.message}`);
  }

  // Fetch and cache fees for all enabled DEXes at startup
  await fetchAndCacheFees();

  // Fetch initial prices for all DEXes
  try {
    if (useUniswap) await updateUniswapPrice();
    if (useSushiSwap) await updateSushiSwapPrice();
    if (useCamelot) await updateCamelotPrice();
    console.log(`📊 Initial prices fetched: Uniswap=${cachedUniswapPrice}, SushiSwap=${cachedSushiSwapPrice}, Camelot=${cachedCamelotPrice}`);
  } catch (error) {
    console.error(`⚠️ Initial price fetch failed: ${error.message}`);
    return;
  }

  // Perform initial arbitrage check
  checkArbitrage("Initial");

  // Set up swap event listeners for price updates
  if (useUniswap) {
    uniswapV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      const blockNumber = event.blockNumber;
      console.log(`🔔 Swap event detected on Uniswap V3 at block ${blockNumber}`);
      try {
        await updateUniswapPrice(blockNumber);
        console.log(`📊 Uniswap price updated for block ${blockNumber}: ${cachedUniswapPrice}`);
        checkArbitrage(`Swap on Uniswap V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating Uniswap price for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useSushiSwap) {
    sushiswapV2Pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const blockNumber = event.blockNumber;
      console.log(`🔔 Swap event detected on SushiSwap V2 at block ${blockNumber}`);
      try {
        await updateSushiSwapPrice(blockNumber);
        console.log(`📊 SushiSwap price updated for block ${blockNumber}: ${cachedSushiSwapPrice}`);
        checkArbitrage(`Swap on SushiSwap V2 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating SushiSwap price for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useCamelot) {
    camelotV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      const blockNumber = event.blockNumber;
      console.log(`🔔 Swap event detected on Camelot V3 at block ${blockNumber}`);
      try {
        await updateCamelotPrice(blockNumber);
        console.log(`📊 Camelot price updated for block ${blockNumber}: ${cachedCamelotPrice}`);
        checkArbitrage(`Swap on Camelot V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating Camelot price for block ${blockNumber}: ${error.message}`);
      }
    });
  }
};

/** Update TOKEN_B/USD price from Chainlink */
const updateTokenBUsdPrice = async () => {
  console.log("💹 Updating TOKEN_B/USD price...");
  try {
    const price = await chainlinkTokenBUsd.latestAnswer();
    const decimals = Number(await chainlinkTokenBUsd.decimals());
    cachedTokenBUsdPrice = Number(price) / 10 ** decimals;
    console.log(`✅ Updated TOKEN_B/USD price: ${cachedTokenBUsdPrice}`);
  } catch (error) {
    console.error(`⚠️ Failed to update TOKEN_B/USD price: ${error.message}`);
  }
};

/** Update gas fee data */
const updateFeeData = async () => {
  console.log("⛽ Updating gas fee data...");
  try {
    const feeData = await wsProvider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ? BigInt(feeData.maxFeePerGas) : BigInt(feeData.gasPrice);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? BigInt(feeData.maxPriorityFeePerGas) : ethers.parseUnits("0.01", "gwei");
    const bufferedMaxFeePerGas = (maxFeePerGas * BigInt(Math.floor(GAS_FEE_MULTIPLIER * 10))) / 10n;

    cachedFeeData = {
      gasPrice: feeData.gasPrice,
      maxPriorityFeePerGas: maxPriorityFeePerGas,
      maxFeePerGas: bufferedMaxFeePerGas
    };
    console.log(`✅ Gas Update - Base: ${ethers.formatUnits(cachedFeeData.gasPrice, "gwei")} Gwei`);
  } catch (error) {
    console.error(`⚠️ Gas update failed: ${error.message}`);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("0.01", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"),
      maxFeePerGas: ethers.parseUnits("0.012", "gwei")
    };
  }
};

/** Fetch and log prices from enabled DEXes */
const fetchAndLogPrices = async (context = "general") => {
  console.log(`🔍 Fetching prices for context: ${context}`);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const calls = [];
      if (useUniswap) calls.push(uniswapV3Pool.slot0());
      if (useSushiSwap) calls.push(sushiswapV2Pool.getReserves());
      if (useCamelot) calls.push(camelotV3Pool.globalState());

      const results = await Promise.all(calls);
      const prices = {};

      let index = 0;
      if (useUniswap) {
        prices.uniswap = calculateV3Price(results[index].sqrtPriceX96, uniswapIsTokenAFirst);
        index++;
      }
      if (useSushiSwap) {
        prices.sushiSwap = calculateV2Price(results[index], sushiswapIsTokenAFirst);
        index++;
      }
      if (useCamelot) {
        prices.camelot = calculateV3Price(results[index].price, camelotIsTokenAFirst);
      }

      const pricePairs = [];
      const enabledDexes = [];
      if (useUniswap) enabledDexes.push('uniswap');
      if (useSushiSwap) enabledDexes.push('sushiSwap');
      if (useCamelot) enabledDexes.push('camelot');
      for (let i = 0; i < enabledDexes.length; i++) {
        for (let j = i + 1; j < enabledDexes.length; j++) {
          const dex1 = enabledDexes[i];
          const dex2 = enabledDexes[j];
          const diff = Math.abs(prices[dex1] - prices[dex2]);
          pricePairs.push(`${dex1}=${prices[dex1].toFixed(18)}, ${dex2}=${prices[dex2].toFixed(18)}, Diff=${diff.toFixed(18)}`);
        }
      }

      const timestamp = Date.now();
      const logMessage = `⭕ Double check (${context}): ${pricePairs.join(" | ")} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync("time.txt", logMessage);
      return prices;
    } catch (err) {
      console.error(`⚠️ Fetch prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        fs.appendFileSync("time.txt", `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

/** Calculate loan amount in TOKEN_A based on USD value */
const calculateLoanAmount = (targetPrice) => {
  if (cachedTokenBUsdPrice === 0) throw new Error("TOKEN_B/USD price not available");
  const borrowValueTokenB = BORROW_VALUE_USD / cachedTokenBUsdPrice;
  const tokenAAmountFloat = borrowValueTokenB / targetPrice;
  return ethers.parseUnits(tokenAAmountFloat.toFixed(18), 18);
};

/** Get current nonce from the blockchain */
const getCurrentNonce = async () => {
  console.log("🔢 Fetching current nonce...");
  const nonce = BigInt(await signer.provider.getTransactionCount(signer.address, "pending"));
  console.log(`✅ Current nonce: ${nonce}`);
  return nonce;
};

/** Prepare presigned transactions for all ordered pairs of enabled DEXes */
const preparePresignedTransactions = async () => {
  console.log("✍️ Preparing presigned transactions...");
  if ((!useUniswap || !cachedUniswapPrice) && (!useSushiSwap || !cachedSushiSwapPrice) && (!useCamelot || !cachedCamelotPrice)) {
    console.log("⚠️ Skipping presigning: Price data incomplete");
    return;
  }

  if (!cachedFeeData) {
    console.log("⚠️ Skipping presigning: Fee data not available");
    await updateFeeData();
    if (!cachedFeeData) return;
  }

  const enabledDexes = [];
  if (useUniswap) enabledDexes.push('uniswap');
  if (useSushiSwap) enabledDexes.push('sushiSwap');
  if (useCamelot) enabledDexes.push('camelot');

  currentNonce = await getCurrentNonce(); // Fetch current nonce once as the base

  for (let i = 0; i < enabledDexes.length; i++) {
    for (let j = 0; j < enabledDexes.length; j++) {
      if (i !== j) {
        const dexBuy = enabledDexes[i];
        const dexSell = enabledDexes[j];
        const key = `${dexBuy}-${dexSell}`;
        try {
          const dexBuyInfo = dexMap[dexBuy];
          const dexSellInfo = dexMap[dexSell];
          const poolBuy = dexBuyInfo.poolAddress;
          const poolSell = dexSellInfo.poolAddress;
          const feeBuy = dexBuyInfo.fee;
          const feeSell = dexSellInfo.fee;
          const targetPrice = dexBuyInfo.price;
          const loanAmount = calculateLoanAmount(targetPrice);

          const feeFactorBuy = 1 - Number(feeBuy) / 1e6;
          const feeFactorSell = 1 - Number(feeSell) / 1e6;
          const slippageTolerance = 0.10;

          const expectedTokenBFloat = Number(ethers.formatUnits(loanAmount, 18)) * targetPrice * feeFactorBuy;
          const expectedTokenB = ethers.parseUnits(expectedTokenBFloat.toFixed(18), 18);
          const minAmountOut1 = 0; // Set to 0 for testing; adjust for production

          const priceSell = dexSellInfo.price;
          const expectedTokenAFloat = expectedTokenBFloat / priceSell * feeFactorSell;
          const expectedTokenA = ethers.parseUnits(expectedTokenAFloat.toFixed(18), 18);
          const minAmountOut2 = 0; // Set to 0 for testing; adjust for production

          const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

          const txData = flashLoanArbitrage.interface.encodeFunctionData(
            "executeArbitrage",
            [poolBuy, poolSell, TOKEN_A_ADDRESS, loanAmount, minAmountOut1, minAmountOut2, deadline, feeBuy, feeSell]
          );

          const tx = {
            to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
            data: txData,
            chainId: BigInt(42161),
            type: 2,
            gasLimit: BigInt(1000000),
            maxFeePerGas: cachedFeeData.maxFeePerGas,
            maxPriorityFeePerGas: cachedFeeData.maxPriorityFeePerGas,
            nonce: currentNonce
          };

          const signedTx = await signer.signTransaction(tx);
          presignedTxCache[key] = { signedTx, timestamp: Date.now(), nonce: currentNonce };
          console.log(`✅ Presigned transaction for ${key} at nonce ${currentNonce}, timestamp: ${Date.now()}`);
        } catch (error) {
          console.error(`⚠️ Failed to presign tx for ${key}: ${error.message}`);
        }
      }
    }
  }
};

/** Check for arbitrage opportunities across enabled DEXes */
const checkArbitrage = async (context) => {
  console.log(`🔍 Checking arbitrage for context: ${context}`);
  if (shouldStop) {
    console.log("🛑 Bot stopped due to stop loss condition.");
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`🛑 Bot stopped: Reached maximum arbitrage transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
    shouldStop = true;
    wsProvider.websocket.close();
    return;
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("⏳ Max executing transactions reached, waiting for completion.");
    return;
  }

  const dexPrices = {};
  if (useUniswap) dexPrices.uniswap = cachedUniswapPrice;
  if (useSushiSwap) dexPrices.sushiSwap = cachedSushiSwapPrice;
  if (useCamelot) dexPrices.camelot = cachedCamelotPrice;

  const enabledDexes = Object.keys(dexPrices);
  if (enabledDexes.length < 2) {
    console.log("⚠️ At least two DEXes must be enabled for arbitrage.");
    return;
  }

  let opportunities = 0;
  for (let i = 0; i < enabledDexes.length; i++) {
    for (let j = 0; j < enabledDexes.length; j++) {
      if (i !== j) {
        const dex1 = enabledDexes[i];
        const dex2 = enabledDexes[j];
        const P1 = dexPrices[dex1];
        const P2 = dexPrices[dex2];
        const priceDiff = Math.abs(P1 - P2);
        if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;

        if (P1 > P2 + ARBITRAGE_THRESHOLD) {
          opportunities++;
          arbitrageCount++;
          console.log(`📈 Arbitrage #${arbitrageCount}: ${dex1} -> ${dex2}, Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
          if (arbOpportunityStartTime === null) {
            arbOpportunityStartTime = Date.now();
            console.log(`💡 Arbitrage opportunity detected at ${arbOpportunityStartTime}`);
          }
          await fetchAndLogPrices("opportunity_detected");
          setTimeout(async () => {
            await fetchAndLogPrices("2s_after_opportunity");
          }, 2000);
          await executePresignedArbitrage(dex1, dex2, Date.now());
        }
      }
    }
  }

  if (opportunities === 0) {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now() - arbOpportunityStartTime;
      console.log(`⏱️ Arbitrage opportunity vanished after ${vanishTime} ms`);
      fs.appendFileSync("time.txt", `Opportunity lasted: ${vanishTime} ms\n`);
      arbOpportunityStartTime = null;
    }
    console.log(`ℹ️ No arbitrage. Highest diff: ${highestPriceDiff.toFixed(10)} | Count: ${arbitrageCount}`);
  }
};

/** Log transaction details with timing */
const logTransactionDetails = (
  serial,
  txHash,
  dexBuy,
  dexSell,
  loanAmount,
  profitInTokenB,
  gasCostInTokenB,
  swapFeeBuy,
  swapFeeSell,
  netPnL,
  cumulativePnL,
  txStatus,
  timingDetails,
  error = null
) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const tokenAUsdPrice = cachedTokenBUsdPrice * (useUniswap ? cachedUniswapPrice : cachedSushiSwapPrice);
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * tokenAUsdPrice;
  const profitUSD = profitInTokenB * cachedTokenBUsdPrice;
  const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
  const swapFeeBuyUSD = swapFeeBuy * cachedTokenBUsdPrice;
  const swapFeeSellUSD = swapFeeSell * cachedTokenBUsdPrice;
  const netPnLUSD = netPnL * cachedTokenBUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;

  const logMessage = `
🕒 Timestamp: ${timestamp}
🔢 Transaction #${serial}
ℹ️ Status: ${statusText}
📜 Transaction Hash: ${txHash || 'N/A'}
↔️ Direction: ${dexBuy} -> ${dexSell}
💸 Loan Amount: ${ethers.formatUnits(loanAmount, 18)} TOKEN_A (≈$${loanAmountUSD.toFixed(2)} USD)
💰 Profit: ${profitInTokenB.toFixed(18)} TOKEN_B (≈$${profitUSD.toFixed(2)} USD)
⛽ Gas Cost: ${gasCostInTokenB.toFixed(18)} TOKEN_B (≈$${gasCostUSD.toFixed(2)} USD)
💲 ${dexBuy} Swap Fee: ${swapFeeBuy.toFixed(18)} TOKEN_B (≈$${swapFeeBuyUSD.toFixed(2)} USD)
💲 ${dexSell} Swap Fee: ${swapFeeSell.toFixed(18)} TOKEN_B (≈$${swapFeeSellUSD.toFixed(2)} USD)
📈 Net PnL: ${netPnL.toFixed(18)} TOKEN_B (≈$${netPnLUSD.toFixed(2)} USD)
📊 Cumulative PnL: ${cumulativePnL.toFixed(18)} TOKEN_B (≈$${cumulativePnLUSD.toFixed(2)} USD)
⏱️ Timing Details:
- Detection to retrieve/generate: ${timingDetails.timeToRetrieveOrGenerate} ms
- Retrieve/generate to send: ${timingDetails.timeToSend} ms
- Send to confirm: ${timingDetails.timeToConfirm} ms
- Total execution time: ${timingDetails.totalTime} ms${errorMessage}
--------------------------------------------------
`;
  console.log(logMessage);
  fs.appendFileSync("p&l.txt", logMessage);
};

/** Execute arbitrage using presigned transaction with detailed timing */
const executePresignedArbitrage = async (dexBuy, dexSell, detectionTime) => {
  const key = `${dexBuy}-${dexSell}`;
  console.log(`🚀 Starting arbitrage execution #${arbitrageCount} for ${key}`);
  executingTransactions++;
  console.log(`ℹ️ Executing transactions count: ${executingTransactions}`);
  let loanAmount = ethers.getBigInt(0);

  try {
    const retrieveOrGenerateTime = Date.now();
    let presigned = presignedTxCache[key];
    if (!presigned) {
      console.log("✍️ No presigned transaction available for this pair. Generating new ones.");
      await preparePresignedTransactions();
      presigned = presignedTxCache[key];
      if (!presigned) throw new Error("Failed to generate presigned transaction for this pair");
    } else {
      console.log("✅ Using presigned transaction.");
    }

    const tx = ethers.Transaction.from(presigned.signedTx);
    const decoded = flashLoanArbitrage.interface.decodeFunctionData("executeArbitrage", tx.data);
    loanAmount = decoded.amount;

    const sendStartTime = Date.now();
    console.log(`📤 Starting eth_sendRawTransaction at ${sendStartTime}`);
    const txHash = await httpProvider.send("eth_sendRawTransaction", [presigned.signedTx]);
    const hashReceivedTime = Date.now();
    console.log(`✅ Transaction hash received: ${txHash} at ${hashReceivedTime}`);

    const waitStartTime = Date.now();
    console.log(`⏳ Starting waitForTransaction at ${waitStartTime}`);
    const receipt = await httpProvider.waitForTransaction(txHash);
    const confirmTime = Date.now();
    console.log(`✅ Transaction receipt received at ${confirmTime}`);

    const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
    const timeToSend = sendStartTime - retrieveOrGenerateTime;
    const timeToConfirm = confirmTime - sendStartTime;
    const totalTime = confirmTime - detectionTime;

    console.log(`⏱️ Arbitrage #${arbitrageCount} timing details:
- Detection to retrieve/generate: ${timeToRetrieveOrGenerate} ms
- Retrieve/generate to send: ${timeToSend} ms
- Send to confirm: ${timeToConfirm} ms
- Total execution time: ${totalTime} ms`);

    if (receipt) {
      console.log(`ℹ️ TX Status: ${receipt.status}`);
      if (receipt.logs.length === 0) {
        console.log("⚠️ No logs emitted before revert.");
      } else {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            console.log(`ℹ️ Event: ${parsedLog.name} ${parsedLog.args}`);
          } catch (e) {
            console.log(`⚠️ Log skipped: ${log}`);
          }
        }
      }

      let profitInTokenA = ethers.getBigInt(0);
      let success = false;
      if (receipt.status === 1) {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "ArbitrageExecuted") {
              profitInTokenA = parsedLog.args.profit;
              success = parsedLog.args.success;
              console.log(`💰 Profit: ${ethers.formatUnits(profitInTokenA, 18)} TOKEN_A, Success: ${success}`);
              break;
            }
          } catch (e) {}
        }
      } else {
        console.log(`❌ Transaction failed with status: ${receipt.status}`);
      }

      const dexPrices = {
        uniswap: cachedUniswapPrice,
        sushiSwap: cachedSushiSwapPrice,
        camelot: cachedCamelotPrice
      };
      const sellPrice = dexPrices[dexSell] || cachedUniswapPrice;
      const profitInTokenB = Number(ethers.formatUnits(profitInTokenA, 18)) * sellPrice;
      const gasCostInTokenB = Number(ethers.formatUnits(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || cachedFeeData.gasPrice), 18));
      const loanAmountInTokenB = Number(ethers.formatUnits(loanAmount, 18)) * (dexPrices[dexBuy] || cachedUniswapPrice);
      const swapFeeBuy = loanAmountInTokenB * (Number(dexMap[dexBuy].fee) / 1e6);
      const swapFeeSell = loanAmountInTokenB * (Number(dexMap[dexSell].fee) / 1e6);

      const netPnL = profitInTokenB - gasCostInTokenB;
      cumulativePnLInTokenB += netPnL;

      logTransactionDetails(
        arbitrageCount,
        receipt.transactionHash,
        dexBuy,
        dexSell,
        loanAmount,
        profitInTokenB,
        gasCostInTokenB,
        swapFeeBuy,
        swapFeeSell,
        netPnL,
        cumulativePnLInTokenB,
        receipt.status,
        { timeToRetrieveOrGenerate, timeToSend, timeToConfirm, totalTime }
      );
      checkStopCondition();

      if (receipt.status === 1) {
        currentNonce++;
        await preparePresignedTransactions();
      }
    }
  } catch (error) {
    console.error(`⚠️ Execution failed #${arbitrageCount}: ${error.message}`);
    const retrieveOrGenerateTime = Date.now();
    const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
    const timeToSend = 0;
    const timeToConfirm = 0;
    const totalTime = Date.now() - detectionTime;

    logTransactionDetails(
      arbitrageCount,
      null,
      dexBuy,
      dexSell,
      loanAmount,
      0,
      0,
      0,
      0,
      0,
      cumulativePnLInTokenB,
      0,
      { timeToRetrieveOrGenerate, timeToSend, timeToConfirm, totalTime },
      error.message
    );
  } finally {
    executingTransactions--;
    console.log(`ℹ️ Transaction completed. Executing transactions: ${executingTransactions}`);
    if (executingTransactions === 0) {
      checkArbitrage("PostTransaction");
    }
  }
};

/** Check stop-loss condition */
const checkStopCondition = () => {
  if (cachedTokenBUsdPrice === 0) return;
  const stopLossTokenB = STOP_LOSS_USD / cachedTokenBUsdPrice;
  if (cumulativePnLInTokenB <= -stopLossTokenB) {
    console.log(`🛑 Net PnL ${cumulativePnLInTokenB} TOKEN_B ≤ -${stopLossTokenB} TOKEN_B. Stopping bot.`);
    shouldStop = true;
    wsProvider.websocket.close();
  }
};

// ========== INITIALIZATION ==========
(async () => {
  try {
    console.log("🛠️ Initializing HTTP provider and signer...");
    httpProvider = new ethers.JsonRpcProvider(process.env.ARBITRUM_HTTP_RPC_URL);
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    console.log(`👤 Signer address: ${signer.address}`);

    currentNonce = await getCurrentNonce();
    flashLoanArbitrage = new ethers.Contract(
      FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      FLASHLOAN_ARBITRAGE_ABI,
      signer
    );
    console.log(`📜 Flashloan contract initialized at: ${FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS}`);

    await connectWebSocket();
    await updateTokenBUsdPrice();
    await updateFeeData();
    setInterval(updateFeeData, 10000);
    setInterval(updateTokenBUsdPrice, 60000);
    setInterval(preparePresignedTransactions, 300000);
  } catch (error) {
    console.error(`⚠️ Initialization failed: ${error.message}`);
  }
})().catch(console.error);