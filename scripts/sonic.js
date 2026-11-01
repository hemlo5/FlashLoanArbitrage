const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ========== Sonic Network Configuration ==========
const sonicNetwork = {
  chainId: 146,
  name: "sonic",
  ensAddress: null // Explicitly disable ENS for Sonic
};

// ========== CONFIGURATION ==========
const TOKEN_A_ADDRESS = "0x79bbf4508b1391af3a0f4b30bb5fc4aa9ab0e07c"; // Token A on Sonic
const TOKEN_B_ADDRESS = "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38"; // Token B on Sonic

// DEX configurations
const DEXES = [
  { name: "Shadow", address: "0x3bce5cb273f0f148010bbea2470e7b5df84c7812", type: "V3", enabled: false },    // Shadow Exchange (V3)
  { name: "SwapX", address: "0xda2fddeb3d654e1f32e2664d8d95c9329e34e5c8", type: "V2", enabled: false },     // SwapX (assumed V2)
  { name: "Wagmi", address: "0x297000941c155962b04760ecaeaa422757f20bc1", type: "V3", enabled: true },     // Wagmi (V3)
  { name: "Metropolis", address: "0x...", type: "V3", enabled: false }, // Metropolis (V3)
  { name: "Solidity", address: "0x2183faf6bc955d344dbc2f9965471b14c0853586", type: "V3", enabled: true }   // Solidity (V3)
];

const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x830d692C06295601aaDeED71Ca98bcc55433d489"; // Sonic flashloan contract address
const BORROW_VALUE_USD = 10;
const ARBITRAGE_THRESHOLD = 0.05; // Numerical difference threshold
const ARBITRAGE_THRESHOLD_PERCENT = 0.6; // Percentage difference threshold (e.g., 0.4%)
const USE_NUMBER_THRESHOLD = false; // True: use numerical threshold, False: use percentage threshold
const MIN_PRICE_DIFF_THRESHOLD = 0;
const MAX_ARBITRAGE_TRANSACTIONS = 91;
const STOP_LOSS_USD = 2.5;
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x824364077993847f71293B24ccA8567c00c2de11"; // Chainlink TOKEN_B/USD on Sonic
const GAS_FEE_MULTIPLIER = 1;
const AUTO_THRESHOLD = false;

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute
const LOSING_STREAK_THRESHOLD = 1;
const PAUSE_PERIOD = 60000; // 1 minute
const MAX_TOTAL_LOSSES = 3;

// ========== ABI DEFINITIONS ==========
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const ALGEBRA_V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint24 fee)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const V2_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address poolBuy, address poolSell, address token, uint256 amount, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 feeBuy, uint24 feeSell) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let flashLoanArbitrage, chainlinkTokenBUsd;
let cachedPrices = {};
let cachedTokenBUsdPrice = 0;
let cachedFlashloanPremium = 0; // Set to 0; update if Sonic flashloan has fees
let tokenADecimals, tokenBDecimals;
let highestPriceDiff = 0;
let highestPriceDiffPercent = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let opportunityVanishedTime = null;
let cumulativePnLInTokenB = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 1;
let currentNonce;
const presignedTxCache = {};
let lastPresignTime = 0;
const PRESIGN_INTERVAL = 300000; // 5 minutes
let LOSING_STREAK = 0;
let WINNING_STREAK = 0;
let lastLosingPriceDiff = 0;
let lastLosingTime = 0;
let totalWins = 0;
let totalLosses = 0;
let pauseUntil = 0;

// ========== CORE FUNCTIONS ==========

/** Fetch token decimals as Numbers */
const fetchTokenDecimals = async () => {
  try {
    const tokenAContract = new ethers.Contract(TOKEN_A_ADDRESS, ERC20_ABI, wsProvider);
    const tokenBContract = new ethers.Contract(TOKEN_B_ADDRESS, ERC20_ABI, wsProvider);
    tokenADecimals = Number(await tokenAContract.decimals());
    tokenBDecimals = Number(await tokenBContract.decimals());
    console.log(`TOKEN_A decimals: ${tokenADecimals}, TOKEN_B decimals: ${tokenBDecimals}`);
  } catch (error) {
    console.error(`⚠️ Failed to fetch token decimals: ${error.message}`);
    throw error;
  }
};

/** Update streaks and loss tracking based on trade success */
function updateStreaks(isSuccess, priceDiff) {
  if (isSuccess) {
    WINNING_STREAK++;
    LOSING_STREAK = 0;
    totalWins++;
  } else {
    LOSING_STREAK++;
    WINNING_STREAK = 0;
    totalLosses++;
    lastLosingPriceDiff = priceDiff;
    lastLosingTime = Date.now();
    if (LOSING_STREAK >= LOSING_STREAK_THRESHOLD) {
      pauseUntil = Date.now() + PAUSE_PERIOD;
      console.log(`⏸️ Pausing trading until ${new Date(pauseUntil).toISOString()} due to losing streak of ${LOSING_STREAK}`);
    }
    if (totalLosses >= MAX_TOTAL_LOSSES) {
      console.log(`🛑 Stopping bot: Total losses reached ${MAX_TOTAL_LOSSES}`);
      shouldStop = true;
      if (wsProvider) wsProvider.websocket.close();
    }
  }
  console.log(`📊 Winning Streak: ${WINNING_STREAK}, Losing Streak: ${LOSING_STREAK}, Total Wins: ${totalWins}, Total Losses: ${totalLosses}`);
  if (LOSING_STREAK >= LOSE_TOLERANCE) {
    console.log(`🛑 Stopping bot: Losing streak reached ${LOSE_TOLERANCE}`);
    shouldStop = true;
    if (wsProvider) wsProvider.websocket.close();
  }
}

/** Calculate price (tokenB/tokenA) from sqrtPriceX96 for V3 pools */
const calculateV3Price = (sqrtPriceX96, isTokenAFirst) => {
  try {
    const Q96 = BigInt(1) << BigInt(96);
    const sqrtPrice = BigInt(sqrtPriceX96);
    const priceScaled = (sqrtPrice * sqrtPrice * (BigInt(10) ** BigInt(18))) / (Q96 * Q96);
    let price = Number(priceScaled) / 1e18;
    price = isTokenAFirst ? price : 1 / price;
    const decimalAdjustment = 10 ** (tokenADecimals - tokenBDecimals);
    return price * decimalAdjustment;
  } catch (e) {
    console.error(`⚠️ Error in calculateV3Price: ${e.message}`);
    throw e;
  }
};

/** Calculate price (tokenB/tokenA) from V2 reserves */
const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = BigInt(reserves.reserve0);
  const reserve1 = BigInt(reserves.reserve1);
  const precision = BigInt(1e18);
  let priceScaled;
  if (isTokenAFirst) {
    priceScaled = (reserve1 * precision) / reserve0; // TOKEN_B per TOKEN_A
  } else {
    priceScaled = (reserve0 * precision) / reserve1; // TOKEN_B per TOKEN_A
  }
  return Number(priceScaled) / 1e18;
};

/** Update prices from pool states with enhanced logging */
const updatePrices = async (blockTag = "latest") => {
  console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
  const prices = {};

  for (const dex of DEXES) {
    if (dex.enabled) {
      try {
        if (dex.type === "V3") {
          const slot0MethodSig = ethers.id("slot0()").slice(0, 10);
          const slot0Raw = await wsProvider.call({ to: dex.address, data: slot0MethodSig }, blockTag);
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ["uint160", "int24", "uint16", "uint16"],
              slot0Raw
            );
            console.log(`Decoded slot0 for ${dex.name}:`, decoded.map((v) => v.toString()));
            const slot0 = {
              sqrtPriceX96: decoded[0],
              tick: decoded[1],
              observationIndex: decoded[2],
              observationCardinality: decoded[3]
            };
            const price = calculateV3Price(slot0.sqrtPriceX96, dex.isTokenAFirst);
            console.log(`Calculated price for ${dex.name}: ${price}`);
            prices[dex.name] = price;
          } catch (decodeError) {
            console.error(`⚠️ Decoding failed for ${dex.name}: ${decodeError.message}`);
          }
        } else if (dex.type === "AlgebraV3") {
          const slot0MethodSig = ethers.id("slot0()").slice(0, 10);
          const slot0Raw = await wsProvider.call({ to: dex.address, data: slot0MethodSig }, blockTag);
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ["uint160", "int24", "uint24"],
              slot0Raw
            );
            console.log(`Decoded slot0 for ${dex.name}:`, decoded.map((v) => v.toString()));
            const slot0 = {
              sqrtPriceX96: decoded[0],
              tick: decoded[1],
              fee: decoded[2]
            };
            const price = calculateV3Price(slot0.sqrtPriceX96, dex.isTokenAFirst);
            console.log(`Calculated price for ${dex.name}: ${price}`);
            prices[dex.name] = price;
            dex.fee = slot0.fee; // Update fee for AlgebraV3 pools
          } catch (decodeError) {
            console.error(`⚠️ Decoding failed for ${dex.name}: ${decodeError.message}`);
          }
        } else if (dex.type === "V2") {
          const getReservesMethodSig = ethers.id("getReserves()").slice(0, 10);
          const reservesRaw = await wsProvider.call({ to: dex.address, data: getReservesMethodSig }, blockTag);
          console.log(`Raw getReserves response for ${dex.name}:`, reservesRaw); // Enhanced logging for raw response
          try {
            let decoded;
            if (dex.name === "SwapX") {
              // Decode as two uint256 for SwapX
              decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], reservesRaw);
              console.log(`Decoded reserves for ${dex.name}:`, decoded.map((v) => v.toString()));
              const reserves = {
                reserve0: decoded[0],
                reserve1: decoded[1],
              };
              const price = calculateV2Price(reserves, dex.isTokenAFirst);
              console.log(`Calculated price for ${dex.name}: ${price}`);
              prices[dex.name] = price;
            } else {
              // Standard decoding
              decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint112", "uint112", "uint32"], reservesRaw);
              console.log(`Decoded reserves for ${dex.name}:`, decoded.map((v) => v.toString()));
              const reserves = {
                reserve0: decoded[0],
                reserve1: decoded[1],
                blockTimestampLast: decoded[2]
              };
              const price = calculateV2Price(reserves, dex.isTokenAFirst);
              console.log(`Calculated price for ${dex.name}: ${price}`);
              prices[dex.name] = price;
            }
          } catch (decodeError) {
            console.error(`⚠️ Decoding failed for ${dex.name}: ${decodeError.message}`);
          }
        }
      } catch (e) {
        console.error(`⚠️ ${dex.name} price fetch failed: ${e.message}`);
        if (e.data) console.log(`Raw error data:`, e.data);
      }
    }
  }

  for (const [name, price] of Object.entries(prices)) {
    if (price) cachedPrices[name] = price;
  }
  console.log(`📊 Prices updated: ${JSON.stringify(cachedPrices)}`);
  return prices;
};

/** Connect to WebSocket and initialize contracts with raw data logging */
const connectWebSocket = async () => {
  console.log("🌐 Connecting to Sonic WebSocket...");
  wsProvider = new ethers.WebSocketProvider(process.env.SONIC_WS_RPC_URL, sonicNetwork);
  wsProvider.ens = null; // Explicitly disable ENS

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
  for (const dex of DEXES) {
    if (dex.enabled && ethers.isAddress(dex.address)) {
      try {
        if (dex.type === "V3" || dex.type === "AlgebraV3") {
          const poolAbi = dex.type === "V3" ? V3_POOL_ABI : ALGEBRA_V3_POOL_ABI;
          dex.pool = new ethers.Contract(dex.address, poolAbi, wsProvider);
          const token0MethodSig = ethers.id("token0()").slice(0, 10);
          const token0Raw = await wsProvider.call({ to: dex.address, data: token0MethodSig });
          console.log(`Raw token0 response for ${dex.name}:`, token0Raw);
          const token0 = ethers.AbiCoder.defaultAbiCoder().decode(["address"], token0Raw)[0];
          dex.isTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
          if (dex.type === "V3") {
            try {
              const feeMethodSig = ethers.id("fee()").slice(0, 10);
              const feeRaw = await wsProvider.call({ to: dex.address, data: feeMethodSig });
              console.log(`Raw fee response for ${dex.name}:`, feeRaw);
              dex.fee = ethers.AbiCoder.defaultAbiCoder().decode(["uint24"], feeRaw)[0];
            } catch (e) {
              console.warn(`⚠️ ${dex.name} fee fetch failed: ${e.message}. Using default 0.3%`);
              dex.fee = 3000; // Default to 0.3%
            }
          } else if (dex.type === "AlgebraV3") {
            // Fee is fetched from slot0 for AlgebraV3
          }
        } else if (dex.type === "V2") {
          dex.pool = new ethers.Contract(dex.address, V2_POOL_ABI, wsProvider);
          const token0MethodSig = ethers.id("token0()").slice(0, 10);
          const token0Raw = await wsProvider.call({ to: dex.address, data: token0MethodSig });
          console.log(`Raw token0 response for ${dex.name}:`, token0Raw);
          const token0 = ethers.AbiCoder.defaultAbiCoder().decode(["address"], token0Raw)[0];
          const token1MethodSig = ethers.id("token1()").slice(0, 10);
          const token1Raw = await wsProvider.call({ to: dex.address, data: token1MethodSig });
          const token1 = ethers.AbiCoder.defaultAbiCoder().decode(["address"], token1Raw)[0];
          console.log(`For ${dex.name}: token0 = ${token0}, token1 = ${token1}`);
          dex.isTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
          dex.fee = 3000; // Standard 0.3% for V2
        }
        console.log(`💲 ${dex.name} Fee: ${dex.fee} (${(Number(dex.fee) / 1e6) * 100}%)`);
      } catch (e) {
        console.error(`⚠️ Failed to initialize ${dex.name}: ${e.message}`);
        if (e.data) console.log(`Raw error data:`, e.data);
        dex.enabled = false;
      }
    } else {
      console.log(`⚠️ ${dex.name} disabled or invalid address`);
      dex.enabled = false;
    }
  }

  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);

  cachedFlashloanPremium = 0; // Update if Sonic flashloan has fees
  console.log(`💲 Flashloan Fee: ${cachedFlashloanPremium} (0%)`);

  await fetchTokenDecimals();
  await updateTokenBUsdPrice();
  await updatePrices();
  console.log(`📊 Initial prices: ${JSON.stringify(cachedPrices)}`);

  try {
    await preparePresignedTransactions();
    lastPresignTime = Date.now();
    console.log("✅ Initial presigned transactions prepared");
  } catch (error) {
    console.error(`⚠️ Initial presigning failed: ${error.message}`);
  }

  await updateFeeData();
  checkArbitrage("Initial");

  for (const dex of DEXES) {
    if (dex.enabled) {
      if (dex.type === "V3" || dex.type === "AlgebraV3") {
        dex.pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
          if (shouldStop) return;
          const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
          console.log(`🔔 Swap on ${dex.name} at block ${blockNumber}`);
          try {
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on ${dex.name} at block ${blockNumber}`);
          } catch (error) {
            console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
          }
        });
      } else if (dex.type === "V2") {
        dex.pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
          if (shouldStop) return;
          const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
          console.log(`🔔 Swap on ${dex.name} at block ${blockNumber}`);
          try {
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on ${dex.name} at block ${blockNumber}`);
          } catch (error) {
            console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
          }
        });
      }
    }
  }

  setInterval(updateFeeData, 10000); // Update gas fees every 10 seconds
  setInterval(updateTokenBUsdPrice, 60000); // Update price feed every minute
  setInterval(async () => {
    if (Date.now() - lastPresignTime >= PRESIGN_INTERVAL && executingTransactions === 0) {
      try {
        await preparePresignedTransactions();
        lastPresignTime = Date.now();
        console.log("✅ Periodic presigned transactions prepared");
      } catch (error) {
        console.error(`⚠️ Periodic presigning failed: ${error.message}`);
      }
    }
  }, 60000); // Check every minute
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
    const feeData = await signer.provider.getFeeData();
    let baseFeePerGas = feeData.lastBaseFeePerGas || (await signer.provider.getBlock("latest")).baseFeePerGas || BigInt(0);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("0.01", "gwei");
    const maxFeePerGas = baseFeePerGas * BigInt(2) + maxPriorityFeePerGas;

    cachedFeeData = { gasPrice: feeData.gasPrice, maxPriorityFeePerGas, maxFeePerGas };
    console.log(`✅ Gas Update - Base Fee: ${ethers.formatUnits(baseFeePerGas, "gwei")} Gwei, Max Fee: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);
  } catch (error) {
    console.error(`⚠️ Gas update failed: ${error.message}`);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("0.1", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"),
      maxFeePerGas: ethers.parseUnits("0.12", "gwei")
    };
  }
};

/** Fetch and log prices from all DEXes with raw data logging */
const fetchAndLogPrices = async (context = "general") => {
  console.log(`🔍 Fetching prices for context: ${context}`);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const prices = {};
      for (const dex of DEXES) {
        if (dex.enabled) {
          if (dex.type === "V3") {
            const slot0MethodSig = ethers.id("slot0()").slice(0, 10);
            const slot0Raw = await wsProvider.call({ to: dex.address, data: slot0MethodSig });
            console.log(`Raw slot0 response for ${dex.name}:`, slot0Raw);
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ["uint160", "int24", "uint16", "uint16"],
              slot0Raw
            );
            const slot0 = { sqrtPriceX96: decoded[0], tick: decoded[1] };
            prices[dex.name] = calculateV3Price(slot0.sqrtPriceX96, dex.isTokenAFirst);
          } else if (dex.type === "AlgebraV3") {
            const slot0MethodSig = ethers.id("slot0()").slice(0, 10);
            const slot0Raw = await wsProvider.call({ to: dex.address, data: slot0MethodSig });
            console.log(`Raw slot0 response for ${dex.name}:`, slot0Raw);
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ["uint160", "int24", "uint24"],
              slot0Raw
            );
            const slot0 = { sqrtPriceX96: decoded[0], tick: decoded[1] };
            prices[dex.name] = calculateV3Price(slot0.sqrtPriceX96, dex.isTokenAFirst);
          } else if (dex.type === "V2") {
            const reservesMethodSig = ethers.id("getReserves()").slice(0, 10);
            const reservesRaw = await wsProvider.call({ to: dex.address, data: reservesMethodSig });
            console.log(`Raw getReserves response for ${dex.name}:`, reservesRaw);
            let decoded;
            if (dex.name === "SwapX") {
              decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], reservesRaw);
            } else {
              decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint112", "uint112", "uint32"], reservesRaw);
            }
            const reserves = { reserve0: decoded[0], reserve1: decoded[1] };
            prices[dex.name] = calculateV2Price(reserves, dex.isTokenAFirst);
          }
        }
      }
      const timestamp = Date.now();
      const logMessage = `⭕ ${context}: ${Object.entries(prices).map(([name, price]) => `${name}=${price.toFixed(18)}`).join(", ")} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync(path.join(__dirname, "time.txt"), logMessage);
      return prices;
    } catch (err) {
      console.error(`⚠️ Fetch prices attempt ${attempt + 1} failed: ${err.message}`);
      if (err.data) console.log(`Raw error data:`, err.data);
      if (attempt === maxRetries - 1) {
        fs.appendFileSync(path.join(__dirname, "time.txt"), `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

/** Calculate loan amount in TOKEN_A based on USD value */
const calculateLoanAmount = (targetPrice) => {
  if (cachedTokenBUsdPrice === 0) throw new Error("TOKEN_B/USD price not available");
  const borrowValueTokenB = BORROW_VALUE_USD / cachedTokenBUsdPrice;
  const tokenAAmountFloat = borrowValueTokenB / targetPrice;
  return ethers.parseUnits(tokenAAmountFloat.toFixed(8), tokenADecimals);
};

/** Get current nonce from the blockchain */
const getCurrentNonce = async () => {
  console.log("🔢 Fetching current nonce...");
  try {
    const nonce = BigInt(await signer.provider.getTransactionCount(signer.address, "pending"));
    console.log(`✅ Current nonce: ${nonce}`);
    return nonce;
  } catch (error) {
    console.error(`⚠️ Failed to fetch nonce: ${error.message}`);
    throw error;
  }
};

/** Check account balance and throw error if insufficient */
const checkBalance = async (maxFeePerGas, gasLimit) => {
  try {
    const balance = await signer.provider.getBalance(signer.address);
    const requiredFunds = maxFeePerGas * gasLimit;
    if (balance < requiredFunds) {
      throw new Error(
        `Insufficient funds: have ${ethers.formatUnits(balance, "ether")} ETH, need ${ethers.formatUnits(requiredFunds, "ether")} ETH`
      );
    }
    console.log(`✅ Balance sufficient: ${ethers.formatUnits(balance, "ether")} ETH available`);
  } catch (error) {
    console.error(`⚠️ Balance check failed: ${error.message}`);
    throw error;
  }
};

/** Prepare presigned transactions for all enabled DEX pairs */
const preparePresignedTransactions = async () => {
  console.log("✍️ Preparing presigned transactions...");
  if (!Object.values(cachedPrices).some((price) => price > 0)) {
    console.log("⚠️ Skipping presigning: Price data incomplete");
    return;
  }
  if (!cachedFeeData) {
    console.log("⚠️ Skipping presigning: Fee data not available");
    await updateFeeData();
    if (!cachedFeeData) return;
  }

  const enabledDEXes = DEXES.filter((dex) => dex.enabled);
  const pairs = [];
  for (let i = 0; i < enabledDEXes.length; i++) {
    for (let j = 0; j < enabledDEXes.length; j++) {
      if (i !== j) {
        pairs.push({
          poolBuy: enabledDEXes[i].address,
          poolSell: enabledDEXes[j].address,
          feeBuy: enabledDEXes[i].fee,
          feeSell: enabledDEXes[j].fee,
        });
      }
    }
  }

  const referenceDEX = enabledDEXes.find((dex) => dex.name === "Shadow" && dex.enabled) || enabledDEXes[0];
  const referencePrice = cachedPrices[referenceDEX.name];
  if (!referencePrice) {
    console.log("⚠️ No reference price available");
    return;
  }
  const loanAmount = calculateLoanAmount(referencePrice);

  Object.keys(presignedTxCache).forEach((key) => delete presignedTxCache[key]);

  const nonceToUse = currentNonce;
  const { maxFeePerGas, maxPriorityFeePerGas } = cachedFeeData;
  const multiplier = BigInt(Math.round(GAS_FEE_MULTIPLIER * 100));
  const adjustedMaxFeePerGas = (maxFeePerGas * multiplier) / BigInt(100);
  const adjustedMaxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / BigInt(100);
  const gasLimit = BigInt(1000000);

  await checkBalance(adjustedMaxFeePerGas, gasLimit);

  for (const pair of pairs) {
    try {
      const deadline = Math.floor(Date.now() / 1000) + 360;
      const txData = flashLoanArbitrage.interface.encodeFunctionData("executeArbitrage", [
        pair.poolBuy,
        pair.poolSell,
        TOKEN_A_ADDRESS,
        loanAmount,
        0,
        0,
        deadline,
        pair.feeBuy,
        pair.feeSell,
      ]);

      const tx = {
        to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
        data: txData,
        chainId: BigInt(146), // Sonic chain ID
        type: 2,
        gasLimit,
        maxFeePerGas: adjustedMaxFeePerGas,
        maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
        nonce: nonceToUse,
      };

      const signedTx = await signer.signTransaction(tx);
      presignedTxCache[`${pair.poolBuy}-${pair.poolSell}`] = { signedTx, timestamp: Date.now(), nonce: nonceToUse };
      console.log(
        `✅ Presigned tx for pair ${pair.poolBuy}-${pair.poolSell} at nonce ${nonceToUse}, maxFeePerGas: ${ethers.formatUnits(
          adjustedMaxFeePerGas,
          "gwei"
        )} Gwei`
      );
    } catch (error) {
      console.error(`⚠️ Failed to presign tx for pair ${pair.poolBuy}-${pair.poolSell}: ${error.message}`);
    }
  }
};

/** Calculate dynamic arbitrage threshold based on fees */
const calculateDynamicThreshold = (poolBuyFee, poolSellFee) => {
  const swapFeeBuyPercent = Number(poolBuyFee) / 1e6 * 100;
  const swapFeeSellPercent = Number(poolSellFee) / 1e6 * 100;
  const flashloanFeePercent = Number(cachedFlashloanPremium) / 1e18 * 100;
  const totalFeesPercent = swapFeeBuyPercent + swapFeeSellPercent + flashloanFeePercent;
  return totalFeesPercent / 100;
};

/** Check for arbitrage opportunities */
const checkArbitrage = (context) => {
  console.log(`🔍 Checking arbitrage for context: ${context}`);
  if (shouldStop) {
    console.log(`🛑 Bot stopped. Wins: ${WINNING_STREAK} | Losses: ${LOSING_STREAK}`);
    return;
  }
  if (Date.now() < pauseUntil) {
    console.log(`⏸️ Paused until ${new Date(pauseUntil).toISOString()}`);
    return;
  }
  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`🛑 Stopped: Max transactions (${MAX_ARBITRAGE_TRANSACTIONS}) reached`);
    shouldStop = true;
    if (wsProvider) wsProvider.websocket.close();
    return;
  }
  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("⏳ Waiting for transactions...");
    return;
  }

  const prices = Object.entries(cachedPrices).map(([name, price]) => ({
    dex: name,
    price,
    pool: DEXES.find((d) => d.name === name).address,
    fee: DEXES.find((d) => d.name === name).fee,
  }));

  if (prices.length < 2) {
    console.log("⚠️ Not enough DEXes for arbitrage");
    return;
  }

  let maxDiff = 0,
    maxDiffPercent = 0,
    maxDiffPair = "";
  for (let i = 0; i < prices.length; i++) {
    for (let j = 0; j < prices.length; j++) {
      if (i !== j) {
        const priceDiff = Math.abs(prices[i].price - prices[j].price);
        const priceDiffPercent = (priceDiff / Math.min(prices[i].price, prices[j].price)) * 100;
        if (priceDiff > maxDiff) {
          maxDiff = priceDiff;
          maxDiffPercent = priceDiffPercent;
          maxDiffPair = `${prices[i].dex}-${prices[j].dex}`;
        }
        if (priceDiff > highestPriceDiff) {
          highestPriceDiff = priceDiff;
          highestPriceDiffPercent = priceDiffPercent;
        }
      }
    }
  }
  console.log(
    `📊 Diff: ${maxDiff.toFixed(18)} (${maxDiffPercent.toFixed(4)}%) on ${maxDiffPair}, Highest: ${highestPriceDiff.toFixed(18)} (${highestPriceDiffPercent.toFixed(4)}%)`
  );

  let maxPriceDex, minPriceDex;
  if (AUTO_THRESHOLD) {
    let maxProfit = 0;
    for (let i = 0; i < prices.length; i++) {
      for (let j = 0; j < prices.length; j++) {
        if (i !== j) {
          const priceDiffPercent = ((prices[i].price - prices[j].price) / prices[j].price) * 100;
          const totalFees = calculateDynamicThreshold(prices[i].fee, prices[j].fee);
          const profitPercent = priceDiffPercent - totalFees * 100;
          if (profitPercent > maxProfit) {
            maxProfit = profitPercent;
            maxPriceDex = prices[i];
            minPriceDex = prices[j];
          }
        }
      }
    }
    if (maxProfit <= 0) {
      console.log("ℹ️ No profitable opportunity");
      if (arbOpportunityStartTime) {
        opportunityVanishedTime = Date.now();
        const duration = opportunityVanishedTime - arbOpportunityStartTime;
        console.log(`⏱️ Opportunity vanished after ${duration} ms`);
        fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
        arbOpportunityStartTime = null;
        opportunityVanishedTime = null;
      }
      return;
    }
  } else {
    maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price ? prev : curr));
    minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price ? prev : curr));
    const priceDiff = maxPriceDex.price - minPriceDex.price;
    const priceDiffPercent = (priceDiff / minPriceDex.price) * 100;

    if (USE_NUMBER_THRESHOLD) {
      if (priceDiff <= ARBITRAGE_THRESHOLD) {
        console.log(`ℹ️ No arbitrage: Diff ${priceDiff.toFixed(10)} <= ${ARBITRAGE_THRESHOLD}`);
        if (arbOpportunityStartTime) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          console.log(`⏱️ Opportunity vanished after ${duration} ms`);
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
        return;
      }
    } else {
      if (priceDiffPercent <= ARBITRAGE_THRESHOLD_PERCENT) {
        console.log(`ℹ️ No arbitrage: Percent diff ${priceDiffPercent.toFixed(4)}% <= ${ARBITRAGE_THRESHOLD_PERCENT}%`);
        if (arbOpportunityStartTime) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          console.log(`⏱️ Opportunity vanished after ${duration} ms`);
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
        return;
      }
    }
  }

  const priceDiff = maxPriceDex.price - minPriceDex.price;
  if (priceDiff < MIN_PRICE_DIFF_THRESHOLD) {
    console.log(`ℹ️ Diff (${priceDiff.toFixed(18)}) < threshold (${MIN_PRICE_DIFF_THRESHOLD})`);
    if (arbOpportunityStartTime) {
      opportunityVanishedTime = Date.now();
      const duration = opportunityVanishedTime - arbOpportunityStartTime;
      console.log(`⏱️ Opportunity vanished after ${duration} ms`);
      fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
      arbOpportunityStartTime = null;
      opportunityVanishedTime = null;
    }
    return;
  }

  if (lastLosingTime && Date.now() - lastLosingTime < COOLDOWN_PERIOD) {
    const requiredDiff = lastLosingPriceDiff * 1.3;
    if (priceDiff <= requiredDiff) {
      console.log(`ℹ️ Skipping: ${priceDiff.toFixed(18)} <= ${requiredDiff.toFixed(18)}`);
      return;
    }
  }

  if (priceDiff > highestPriceDiff) {
    highestPriceDiff = priceDiff;
    highestPriceDiffPercent = (priceDiff / Math.min(maxPriceDex.price, minPriceDex.price)) * 100;
  }

  (async () => {
    await fetchAndLogPrices("opportunity_detected");
    setTimeout(() => fetchAndLogPrices("2s_after_opportunity"), 2000);
  })();

  if (!arbOpportunityStartTime) {
    arbOpportunityStartTime = Date.now();
    console.log(`💡 Opportunity at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}`);
    fs.appendFileSync(
      path.join(__dirname, "time.txt"),
      `Opportunity at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}\n`
    );
  }
  arbitrageCount++;
  console.log(`📈 Arbitrage #${arbitrageCount}: Diff ${priceDiff.toFixed(10)}`);
  // executePresignedArbitrage(maxPriceDex.pool, minPriceDex.pool, arbOpportunityStartTime, priceDiff);
};

/** Log transaction details with timing and opportunity status */
const logTransactionDetails = (
  serial,
  txHash,
  poolBuy,
  poolSell,
  loanAmount,
  profitInTokenA,
  gasCostInTokenB,
  swapFeeBuy,
  swapFeeSell,
  netPnL,
  cumulativePnL,
  txStatus,
  timingDetails,
  opportunityStatus,
  error = null
) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : "";
  const buyDEX = DEXES.find((d) => d.address === poolBuy);
  const buyPrice = cachedPrices[buyDEX.name];
  const profitUSD = profitInTokenA * buyPrice * cachedTokenBUsdPrice;
  const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
  const netPnLUSD = netPnL * cachedTokenBUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;
  const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, tokenADecimals));
  const loanAmountUSD = loanAmountInTokenA * buyPrice * cachedTokenBUsdPrice;

  const logMessage = `
🕒 ${timestamp}
🔢 Tx #${serial} - ${statusText}
📜 Hash: ${txHash || "N/A"}
↔️ ${buyDEX.name} (${poolBuy}) -> ${DEXES.find((d) => d.address === poolSell).name} (${poolSell})
💸 Loan: ${loanAmountInTokenA.toFixed(18)} TOKEN_A (≈$${loanAmountUSD.toFixed(2)})
💰 Profit: ${profitInTokenA.toFixed(18)} TOKEN_A (≈$${profitUSD.toFixed(2)})
⛽ Gas: ${gasCostInTokenB.toFixed(18)} TOKEN_B (≈$${gasCostUSD.toFixed(2)})
📈 Net PnL: ${netPnL.toFixed(18)} TOKEN_B (≈$${netPnLUSD.toFixed(2)})
📊 Cumulative: ${cumulativePnL.toFixed(18)} TOKEN_B (≈$${cumulativePnLUSD.toFixed(2)})
🏆 Wins: ${WINNING_STREAK} | Losses: ${LOSING_STREAK}
⏱️ Timing: ${timingDetails.timeToRetrieveOrGenerate}ms / ${timingDetails.timeToSend}ms / ${timingDetails.timeToConfirm}ms / Total ${timingDetails.totalTime}ms
🔍 Status: ${opportunityStatus}${errorMessage}
--------------------------------------------------
`;
  console.log(logMessage);
  fs.appendFileSync(path.join(__dirname, "p&l.txt"), logMessage);
};

/** Execute arbitrage using presigned transaction and wait for confirmation */
const executePresignedArbitrage = async (poolBuy, poolSell, detectionTime, priceDiff) => {
  console.log(`🚀 Arbitrage #${arbitrageCount}: ${poolBuy} -> ${poolSell}`);
  executingTransactions++;
  let loanAmount = ethers.BigInt(0);

  try {
    const retrieveOrGenerateTime = Date.now();
    const pairKey = `${poolBuy}-${poolSell}`;
    let presigned = presignedTxCache[pairKey];
    if (!presigned || Date.now() - presigned.timestamp > PRESIGN_INTERVAL) {
      console.log("✍️ Generating new presigned tx");
      await preparePresignedTransactions();
      presigned = presignedTxCache[pairKey];
      if (!presigned) throw new Error("Failed to generate presigned tx");
    } else {
      console.log("✅ Using presigned tx");
    }

    const tx = ethers.Transaction.from(presigned.signedTx);
    const decoded = flashLoanArbitrage.interface.decodeFunctionData("executeArbitrage", tx.data);
    loanAmount = decoded.amount;

    const sendStartTime = Date.now();
    const txHash = await httpProvider.send("eth_sendRawTransaction", [presigned.signedTx]);
    const hashReceivedTime = Date.now();
    console.log(`✅ Tx hash: ${txHash} at ${hashReceivedTime}`);

    currentNonce++;
    await preparePresignedTransactions();

    const waitStartTime = Date.now();
    const receipt = await httpProvider.waitForTransaction(txHash);
    const confirmTime = Date.now();

    const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
    const timeToSend = sendStartTime - retrieveOrGenerateTime;
    const timeToConfirm = confirmTime - sendStartTime;
    const totalTime = confirmTime - detectionTime;

    if (receipt) {
      let profitInTokenA = 0,
        success = false;
      if (receipt.status === 1) {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "ArbitrageExecuted") {
              profitInTokenA = Number(ethers.formatUnits(parsedLog.args.profit, tokenADecimals));
              success = parsedLog.args.success;
              console.log(`💰 Profit: ${profitInTokenA} TOKEN_A, Success: ${success}`);
              break;
            }
          } catch (e) {}
        }
      }

      const buyDEX = DEXES.find((d) => d.address === poolBuy);
      const buyPrice = cachedPrices[buyDEX.name];
      const gasCostInTokenB = Number(
        ethers.formatUnits(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || cachedFeeData.gasPrice), tokenBDecimals)
      );
      const profitInTokenB = profitInTokenA * buyPrice;
      const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
      cumulativePnLInTokenB += netPnLInTokenB;

      const isSuccess = receipt.status === 1;
      updateStreaks(isSuccess, priceDiff);

      await updatePrices();
      const prices = Object.entries(cachedPrices).map(([name, price]) => ({ dex: name, price }));

      let opportunityStatus = "";
      const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price ? prev : curr));
      const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price ? prev : curr));
      const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
      if (AUTO_THRESHOLD) {
        const totalFees = calculateDynamicThreshold(buyDEX.fee, DEXES.find((d) => d.address === poolSell).fee);
        const profitPercent = (currentPriceDiff / minPriceDex.price) * 100 - totalFees * 100;
        opportunityStatus =
          profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD
            ? `Persists (Diff: ${currentPriceDiff.toFixed(10)})`
            : `Vanished (Diff: ${currentPriceDiff.toFixed(10)})`;
      } else {
        opportunityStatus =
          currentPriceDiff > ARBITRAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD
            ? `Persists (Diff: ${currentPriceDiff.toFixed(10)})`
            : `Vanished (Diff: ${currentPriceDiff.toFixed(10)})`;
      }
      if (opportunityStatus.includes("Vanished") && arbOpportunityStartTime) {
        opportunityVanishedTime = confirmTime;
        const duration = opportunityVanishedTime - arbOpportunityStartTime;
        opportunityStatus += ` after ${duration} ms`;
        fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
        arbOpportunityStartTime = null;
        opportunityVanishedTime = null;
      }

      logTransactionDetails(
        arbitrageCount,
        receipt.transactionHash,
        poolBuy,
        poolSell,
        loanAmount,
        profitInTokenA,
        gasCostInTokenB,
        0,
        0,
        netPnLInTokenB,
        cumulativePnLInTokenB,
        receipt.status,
        { timeToRetrieveOrGenerate, timeToSend, timeToConfirm, totalTime },
        opportunityStatus
      );
      checkStopCondition();
    }
  } catch (error) {
    console.error(`⚠️ Execution failed #${arbitrageCount}: ${error.message}`);
    const retrieveOrGenerateTime = Date.now();
    const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
    const totalTime = Date.now() - detectionTime;

    updateStreaks(false, priceDiff);

    if (error.message.includes("nonce too low")) {
      currentNonce = await getCurrentNonce();
      await preparePresignedTransactions();
    }

    await updatePrices();
    const prices = Object.entries(cachedPrices).map(([name, price]) => ({ dex: name, price }));

    let opportunityStatus = "";
    const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price ? prev : curr));
    const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price ? prev : curr));
    const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
    if (AUTO_THRESHOLD) {
      const totalFees = calculateDynamicThreshold(DEXES.find((d) => d.address === poolBuy).fee, DEXES.find((d) => d.address === poolSell).fee);
      const profitPercent = (currentPriceDiff / minPriceDex.price) * 100 - totalFees * 100;
      opportunityStatus =
        profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD
          ? `Persists (Diff: ${currentPriceDiff.toFixed(10)})`
          : `Vanished (Diff: ${currentPriceDiff.toFixed(10)})`;
    } else {
      opportunityStatus =
        currentPriceDiff > ARBITRAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD
          ? `Persists (Diff: ${currentPriceDiff.toFixed(10)})`
          : `Vanished (Diff: ${currentPriceDiff.toFixed(10)})`;
    }
    if (opportunityStatus.includes("Vanished") && arbOpportunityStartTime) {
      opportunityVanishedTime = Date.now();
      const duration = opportunityVanishedTime - arbOpportunityStartTime;
      opportunityStatus += ` after ${duration} ms`;
      fs.appendFileSync(path.join(__dirname, "time.txt"), `Vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
      arbOpportunityStartTime = null;
      opportunityVanishedTime = null;
    }

    logTransactionDetails(
      arbitrageCount,
      null,
      poolBuy,
      poolSell,
      loanAmount,
      0,
      0,
      0,
      0,
      0,
      cumulativePnLInTokenB,
      0,
      { timeToRetrieveOrGenerate, timeToSend: 0, timeToConfirm: 0, totalTime },
      opportunityStatus,
      error.message
    );
    checkStopCondition();
  } finally {
    executingTransactions--;
    if (executingTransactions < MAX_EXECUTING_TRANSACTIONS && !shouldStop) {
      checkArbitrage("PostTransaction");
    }
  }
};

/** Check stop-loss condition */
const checkStopCondition = () => {
  if (cachedTokenBUsdPrice === 0) return;
  const stopLossTokenB = STOP_LOSS_USD / cachedTokenBUsdPrice;
  if (cumulativePnLInTokenB <= -stopLossTokenB) {
    console.log(`🛑 Stopped: PnL ${cumulativePnLInTokenB} ≤ -${stopLossTokenB}`);
    shouldStop = true;
    if (wsProvider) wsProvider.websocket.close();
  }
};

// ========== INITIALIZATION ==========
(async () => {
  console.log("🛠️ Initializing...");
  httpProvider = new ethers.JsonRpcProvider(process.env.SONIC_HTTP_RPC_URL, sonicNetwork);
  httpProvider.ens = null; // Explicitly disable ENS
  signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
  console.log(`👤 Signer: ${signer.address}`);

  currentNonce = await getCurrentNonce();
  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, signer);
  console.log(`📜 Flashloan at: ${FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS}`);

  await updateFeeData();
  await connectWebSocket();
})().catch((error) => console.error(`⚠️ Initialization failed: ${error.message}`));