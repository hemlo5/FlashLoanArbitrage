const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ========== CONFIGURATION ==========

const TOKEN_A_ADDRESS = "0x40375c92d9faf44d2f9db9bd9ba41a3317a2404f"; // WCORE on Core
const TOKEN_B_ADDRESS = "0x900101d06a7426441ae63e9ab3b9b0f63be145f1"; // USDT on Core

const SUSHISWAP_V3_POOL_ADDRESS = "0x95dcc9e9bf80980375494346e00fc5aef6883ef7"; // SushiSwap V3 on Core
const CORE_X_POOL_ADDRESS = "0xd203eab4e8c741473f7456a9f32ce310d521fa41"; // Core X on Core
const GLYPH_EXCHANGE_V4_POOL_ADDRESS = "0xa7e8685727df3cdb40927e817c8b7ce6e91c56bb"; // Glyph Exchange V4 on Core
const ARCHERSWAP_POOL_ADDRESS = "0x6a4cbca01b3d8dc7f397d1c897f8a9a88bfcb1d0"; // ArcherSwap on Core (invalid, kept as placeholder)
const ICECREAM_SWAP_POOL_ADDRESS = "0x6063d72ab87a879ba25c68ad09af3937f55a99a8"; // Icecream Swap on Core

let useSushiSwapV3 = true;
let useCoreX = true; // Using V3 ABI
let useGlyphExchangeV4 = false; // Using custom V2 ABI
let useArcherSwap = false; // Disabled due to invalid address
let useIcecreamSwap = false; // Disabled by default

const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x830D692C06295601AAdEed71Ca98bCC55433d489";
const BORROW_VALUE_USD = 10;
const ARBITRAGE_THRESHOLD = 8;
const MIN_PRICE_DIFF_THRESHOLD = 0;
const MAX_ARBITRAGE_TRANSACTIONS = 2;
const STOP_LOSS_USD = 2.5;
const GAS_FEE_MULTIPLIER = 1;
const AUTO_THRESHOLD = false;

const PERCENTAGE_THRESHOLD = .3; // 1% threshold for arbitrage
const ARB_BY_PERCENT = true; // Use percentage threshold if true

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute
const LOSING_STREAK_THRESHOLD = 1;
const PAUSE_PERIOD = 60000; // 5 minutes
const MAX_TOTAL_LOSSES = 3;

const CHAIN_ID = 1116; // Core chain ID

const coreNetwork = {
  chainId: CHAIN_ID,
  name: "Core",
  ensAddress: null // Core does not support ENS
};

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

const GLYPH_V4_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address poolBuy, address poolSell, address token, uint256 amount, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 feeBuy, uint24 feeSell) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)"
];

// ========== GLOBAL STATE ==========

let wsProvider, httpProvider, signer, cachedFeeData;
let sushiswapV3Pool, coreXPool, glyphExchangeV4Pool, archerSwapPool, icecreamSwapPool, flashLoanArbitrage;
let sushiswapV3IsTokenAFirst, coreXIsTokenAFirst, glyphExchangeV4IsTokenAFirst, archerSwapIsTokenAFirst, icecreamSwapIsTokenAFirst;
let cachedSushiSwapV3Price = 0, cachedCoreXPrice = 0, cachedGlyphExchangeV4Price = 0, cachedArcherSwapPrice = 0, cachedIcecreamSwapPrice = 0;
let cachedSushiSwapV3Fee, cachedCoreXFee, cachedGlyphExchangeV4Fee, cachedArcherSwapFee, cachedIcecreamSwapFee;
let tokenADecimals, tokenBDecimals;
let highestPriceDiff = 0;
let highestPercentageDiff = 0; // Added to track highest percentage difference
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
  const tokenAContract = new ethers.Contract(TOKEN_A_ADDRESS, ERC20_ABI, wsProvider);
  const tokenBContract = new ethers.Contract(TOKEN_B_ADDRESS, ERC20_ABI, wsProvider);
  tokenADecimals = Number(await tokenAContract.decimals());
  tokenBDecimals = Number(await tokenBContract.decimals());
  console.log(`TOKEN_A decimals: ${tokenADecimals}, TOKEN_B decimals: ${tokenBDecimals}`);
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
      console.log(`⏸️ Pausing trading until ${pauseUntil} due to losing streak of ${LOSING_STREAK}`);
    }
    if (totalLosses >= MAX_TOTAL_LOSSES) {
      console.log(`🛑 Stopping bot: Total losses reached ${MAX_TOTAL_LOSSES}`);
      shouldStop = true;
      wsProvider.websocket.close();
    }
  }
  console.log(`📊 Winning Streak: ${WINNING_STREAK}, Losing Streak: ${LOSING_STREAK}, Total Wins: ${totalWins}, Total Losses: ${totalLosses}`);
  if (LOSING_STREAK >= LOSE_TOLERANCE) {
    console.log(`🛑 Stopping bot: Losing streak reached ${LOSE_TOLERANCE}`);
    shouldStop = true;
    wsProvider.websocket.close();
  }
}

/** Calculate price (tokenB/tokenA) from sqrtPriceX96 for V3 pools */
const calculateV3Price = (sqrtPriceX96, isTokenAFirst) => {
  try {
    const Q96 = BigInt(1) << BigInt(96);
    const sqrtPrice = BigInt(sqrtPriceX96);
    const priceScaled = (sqrtPrice * sqrtPrice * (BigInt(10) ** BigInt(18))) / (Q96 * Q96);
    let price = Number(priceScaled) / 1e18;
    price = isTokenAFirst ? price : (1 / price);
    const decimalAdjustment = 10 ** (tokenADecimals - tokenBDecimals);
    const finalPrice = price * decimalAdjustment;
    return finalPrice;
  } catch (e) {
    console.error(`⚠️ Error in calculateV3Price: ${e.message}`);
    throw e;
  }
};

/** Calculate price (tokenB/tokenA) from V2 reserves with improved precision */
/** Calculate price (tokenB/tokenA) from V2 reserves with improved precision */
const calculateV2Price = (reserves, isTokenAFirst) => {
  let reserve0 = BigInt(reserves.reserve0);
  let reserve1 = BigInt(reserves.reserve1);
  console.log(`Calculating V2 price: reserve0=${reserve0}, reserve1=${reserve1}, isTokenAFirst=${isTokenAFirst}`);

  if (reserve0 === BigInt(0) || reserve1 === BigInt(0)) {
    console.error("⚠️ Zero reserve detected, returning price as 0");
    return 0;
  }

  // Assign reserves based on token order
  let reserveA, reserveB;
  if (isTokenAFirst) {
    reserveA = reserve0; // TOKEN_A
    reserveB = reserve1; // TOKEN_B
  } else {
    reserveA = reserve1; // TOKEN_A
    reserveB = reserve0; // TOKEN_B
  }

  const decimalsTokenA = BigInt(10) ** BigInt(tokenADecimals);
  const decimalsTokenB = BigInt(10) ** BigInt(tokenBDecimals);
  const precision = BigInt(10) ** BigInt(18);

  const numerator = reserveB * precision * decimalsTokenA;
  const denominator = reserveA * decimalsTokenB;

  console.log(`Numerator: ${numerator}, Denominator: ${denominator}`);

  if (denominator === BigInt(0)) {
    console.error("⚠️ Denominator is zero, returning price as 0");
    return 0;
  }

  const priceScaled = numerator / denominator;
  console.log(`priceScaled: ${priceScaled}`);

  const finalPrice = Number(priceScaled) / 1e18;
  console.log(`finalPrice: ${finalPrice}`);

  return finalPrice;
};

/** Log initial raw data from contract calls for debugging */
const logInitialRawData = async () => {
  console.log("🔍 Logging initial raw data for debugging...");
  if (useSushiSwapV3) {
    try {
      const slot0 = await sushiswapV3Pool.slot0();
      console.log("SushiSwap V3 slot0:", slot0);
    } catch (e) {
      console.error("SushiSwap V3 slot0 failed:", e);
    }
  }
  if (useCoreX) {
    try {
      const slot0 = await coreXPool.slot0();
      console.log("Core X slot0:", slot0);
    } catch (e) {
      console.error("Core X slot0 failed:", e);
    }
  }
  if (useGlyphExchangeV4) {
    try {
      const reserves = await glyphExchangeV4Pool.getReserves();
      console.log("Glyph Exchange V4 reserves:", reserves);
    } catch (e) {
      console.error("Glyph Exchange V4 getReserves failed:", e);
    }
  }
  if (useIcecreamSwap) {
    try {
      const reserves = await icecreamSwapPool.getReserves();
      console.log("Icecream Swap reserves:", reserves);
    } catch (e) {
      console.error("Icecream Swap getReserves failed:", e);
    }
  }
};

/** Update prices from pool states */
const updatePrices = async (blockTag = "latest") => {
  console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
  const prices = {};

  if (useSushiSwapV3) {
    try {
      const slot0Sushi = await sushiswapV3Pool.slot0({ blockTag });
      prices.sushiSwapV3 = calculateV3Price(slot0Sushi.sqrtPriceX96, sushiswapV3IsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ SushiSwap V3 slot0 call failed: ${e.message}`);
    }
  }

  if (useCoreX) {
    try {
      const slot0CoreX = await coreXPool.slot0({ blockTag });
      prices.coreX = calculateV3Price(slot0CoreX.sqrtPriceX96, coreXIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Core X slot0 call failed: ${e.message}`);
    }
  }

  if (useGlyphExchangeV4) {
    try {
      const reservesGlyph = await glyphExchangeV4Pool.getReserves({ blockTag });
      prices.glyphExchangeV4 = calculateV2Price(reservesGlyph, glyphExchangeV4IsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Glyph Exchange V4 getReserves call failed: ${e.message}`);
    }
  }

  if (useArcherSwap) {
    try {
      const reservesArcher = await archerSwapPool.getReserves({ blockTag });
      prices.archerSwap = calculateV2Price(reservesArcher, archerSwapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ ArcherSwap getReserves call failed: ${e.message}`);
    }
  }

  if (useIcecreamSwap) {
    try {
      const reservesIcecream = await icecreamSwapPool.getReserves({ blockTag });
      prices.icecreamSwap = calculateV2Price(reservesIcecream, icecreamSwapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Icecream Swap getReserves call failed: ${e.message}`);
    }
  }

  if (useSushiSwapV3 && prices.sushiSwapV3) cachedSushiSwapV3Price = prices.sushiSwapV3;
  if (useCoreX && prices.coreX) cachedCoreXPrice = prices.coreX;
  if (useGlyphExchangeV4 && prices.glyphExchangeV4) cachedGlyphExchangeV4Price = prices.glyphExchangeV4;
  if (useArcherSwap && prices.archerSwap) cachedArcherSwapPrice = prices.archerSwap;
  if (useIcecreamSwap && prices.icecreamSwap) cachedIcecreamSwapPrice = prices.icecreamSwap;

  console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
  return prices;
};

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
  console.log("🌐 Connecting to Core chain WebSocket...");
  wsProvider = new ethers.WebSocketProvider(process.env.CORE_WS_RPC_URL, coreNetwork);

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

  if (useSushiSwapV3) {
    try {
      sushiswapV3Pool = new ethers.Contract(SUSHISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
      sushiswapV3IsTokenAFirst = (await sushiswapV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedSushiSwapV3Fee = await sushiswapV3Pool.fee();
      console.log(`💲 SushiSwap V3 Pool Fee: ${cachedSushiSwapV3Fee} (${(Number(cachedSushiSwapV3Fee) / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize SushiSwap V3: ${e.message}`);
      useSushiSwapV3 = false;
    }
  }

  if (useCoreX) {
    try {
      coreXPool = new ethers.Contract(CORE_X_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
      coreXIsTokenAFirst = (await coreXPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedCoreXFee = await coreXPool.fee();
      console.log(`💲 Core X Pool Fee: ${cachedCoreXFee} (${(Number(cachedCoreXFee) / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Core X: ${e.message}`);
      useCoreX = false;
    }
  }

  if (useGlyphExchangeV4) {
    try {
      glyphExchangeV4Pool = new ethers.Contract(GLYPH_EXCHANGE_V4_POOL_ADDRESS, GLYPH_V4_ABI, wsProvider);
      const token0 = await glyphExchangeV4Pool.token0();
      const token1 = await glyphExchangeV4Pool.token1();
      const token0Lower = token0.toLowerCase();
      const token1Lower = token1.toLowerCase();
      const tokenALower = TOKEN_A_ADDRESS.toLowerCase();
      const tokenBLower = TOKEN_B_ADDRESS.toLowerCase();

      if (
        (token0Lower === tokenALower && token1Lower === tokenBLower) ||
        (token0Lower === tokenBLower && token1Lower === tokenALower)
      ) {
        glyphExchangeV4IsTokenAFirst = token0Lower === tokenALower;
        cachedGlyphExchangeV4Fee = 3000; // 0.3% default for V2 pools
        console.log(`💲 Glyph Exchange V4 Pool Fee: ${cachedGlyphExchangeV4Fee} (${(cachedGlyphExchangeV4Fee / 1e6) * 100}%)`);
        console.log(`Glyph Exchange V4: token0=${token0}, token1=${token1}, isTokenAFirst=${glyphExchangeV4IsTokenAFirst}`);
      } else {
        console.error(`⚠️ Glyph Exchange V4 pool does not match TOKEN_A (${TOKEN_A_ADDRESS}) and TOKEN_B (${TOKEN_B_ADDRESS}). Disabling. Found token0=${token0}, token1=${token1}`);
        useGlyphExchangeV4 = false;
      }
    } catch (e) {
      console.error(`⚠️ Failed to initialize Glyph Exchange V4: ${e.message}`);
      useGlyphExchangeV4 = false;
    }
  }

  if (useArcherSwap) {
    try {
      archerSwapPool = new ethers.Contract(ARCHERSWAP_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
      archerSwapIsTokenAFirst = (await archerSwapPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedArcherSwapFee = 3000; // 0.3% for V2
      console.log(`💲 ArcherSwap Pool Fee: ${cachedArcherSwapFee} (${(cachedArcherSwapFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize ArcherSwap: ${e.message}`);
      useArcherSwap = false;
    }
  }

  if (useIcecreamSwap) {
    try {
      icecreamSwapPool = new ethers.Contract(ICECREAM_SWAP_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
      icecreamSwapIsTokenAFirst = (await icecreamSwapPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedIcecreamSwapFee = 3000; // 0.3% for V2
      console.log(`💲 Icecream Swap Pool Fee: ${cachedIcecreamSwapFee} (${(cachedIcecreamSwapFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Icecream Swap: ${e.message}`);
      useIcecreamSwap = false;
    }
  }

  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);

  await fetchTokenDecimals();

  // Log raw data for debugging
  await logInitialRawData();

  try {
    await updatePrices();
    console.log(`📊 Initial prices: SushiSwapV3=${cachedSushiSwapV3Price}, CoreX=${cachedCoreXPrice}, GlyphExchangeV4=${cachedGlyphExchangeV4Price}, ArcherSwap=${cachedArcherSwapPrice}, IcecreamSwap=${cachedIcecreamSwapPrice}`);
  } catch (error) {
    console.error(`⚠️ Initial price fetch failed: ${error.message}`);
  }

  try {
    await preparePresignedTransactions();
    lastPresignTime = Date.now();
    console.log("✅ Initial presigned transactions prepared");
  } catch (error) {
    console.error(`⚠️ Initial presigning failed: ${error.message}`);
  }

  await updateFeeData();
  checkArbitrage("Initial");

  if (useSushiSwapV3) {
    sushiswapV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on SushiSwap V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on SushiSwap V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useIcecreamSwap) {
    icecreamSwapPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Icecream Swap at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Icecream Swap at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  setInterval(updateFeeData, 100000); // Update gas fees every 10 seconds
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

/** Update gas fee data */
const updateFeeData = async () => {
  console.log("⛽ Updating gas fee data...");
  try {
    const feeData = await signer.provider.getFeeData();
    let baseFeePerGas = feeData.lastBaseFeePerGas;
    if (!baseFeePerGas || baseFeePerGas === BigInt(0)) {
      const block = await signer.provider.getBlock('latest');
      baseFeePerGas = block.baseFeePerGas || BigInt(0);
      console.log(`Fetched base fee from block: ${ethers.formatUnits(baseFeePerGas, "gwei")} Gwei`);
    }
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("0.01", "gwei");
    const maxFeePerGas = (baseFeePerGas * BigInt(2)) + maxPriorityFeePerGas;

    cachedFeeData = {
      gasPrice: feeData.gasPrice,
      maxPriorityFeePerGas,
      maxFeePerGas
    };
    console.log(`✅ Gas Update - Base Fee: ${ethers.formatUnits(baseFeePerGas, "gwei")} Gwei, Max Fee Per Gas: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);
  } catch (error) {
    console.error(`⚠️ Gas update failed: ${error.message}`);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("0.1", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"),
      maxFeePerGas: ethers.parseUnits("0.12", "gwei")
    };
  }
};

/** Check account balance and log warning if insufficient */
const checkBalance = async (maxFeePerGas, gasLimit) => {
  const balance = await signer.provider.getBalance(signer.address);
  const requiredFunds = maxFeePerGas * gasLimit;
  if (balance < requiredFunds) {
    console.warn(`⚠️ Insufficient funds: have ${ethers.formatUnits(balance, "ether")} ETH, need ${ethers.formatUnits(requiredFunds, "ether")} ETH`);
  } else {
    console.log(`✅ Balance sufficient: ${ethers.formatUnits(balance, "ether")} ETH available`);
  }
};

/** Fetch and log prices from all DEXes */
const fetchAndLogPrices = async (context = "general") => {
  console.log(`🔍 Fetching prices for context: ${context}`);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const prices = {};
      if (useSushiSwapV3) {
        const slot0Sushi = await sushiswapV3Pool.slot0();
        prices.sushiSwapV3 = calculateV3Price(slot0Sushi.sqrtPriceX96, sushiswapV3IsTokenAFirst);
      }
      if (useCoreX) {
        const slot0CoreX = await coreXPool.slot0();
        prices.coreX = calculateV3Price(slot0CoreX.sqrtPriceX96, coreXIsTokenAFirst);
      }
      if (useGlyphExchangeV4) {
        const reservesGlyph = await glyphExchangeV4Pool.getReserves();
        prices.glyphExchangeV4 = calculateV2Price(reservesGlyph, glyphExchangeV4IsTokenAFirst);
      }
      if (useArcherSwap) {
        const reservesArcher = await archerSwapPool.getReserves();
        prices.archerSwap = calculateV2Price(reservesArcher, archerSwapIsTokenAFirst);
      }
      if (useIcecreamSwap) {
        const reservesIcecream = await icecreamSwapPool.getReserves();
        prices.icecreamSwap = calculateV2Price(reservesIcecream, icecreamSwapIsTokenAFirst);
      }

      const timestamp = Date.now();
      const logMessage = `⭕ Double check (${context}): ${Object.entries(prices).map(([dex, price]) => `${dex}=${price.toFixed(18)}`).join(", ")} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync(path.join(__dirname, "time.txt"), logMessage);
      return prices;
    } catch (err) {
      console.error(`⚠️ Fetch prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        fs.appendFileSync(path.join(__dirname, "time.txt"), `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

/** Calculate loan amount in TOKEN_A based on USD value */
const calculateLoanAmount = (targetPrice) => {
  const tokenAAmountFloat = BORROW_VALUE_USD / targetPrice; // Simplified, assumes TOKEN_A price in TOKEN_B
  return ethers.parseUnits(tokenAAmountFloat.toFixed(8), tokenADecimals);
};

/** Get current nonce from the blockchain */
const getCurrentNonce = async () => {
  console.log("🔢 Fetching current nonce...");
  const nonce = BigInt(await signer.provider.getTransactionCount(signer.address, "pending"));
  console.log(`✅ Current nonce: ${nonce}`);
  return nonce;
};

/** Prepare presigned transactions for all enabled DEX pairs */
const preparePresignedTransactions = async () => {
  console.log("✍️ Preparing presigned transactions...");
  if (!cachedSushiSwapV3Price) {
    console.log("⚠️ Skipping presigning: Price data incomplete");
    return;
  }

  if (!cachedFeeData) {
    console.log("⚠️ Skipping presigning: Fee data not available");
    await updateFeeData();
    if (!cachedFeeData) return;
  }

  const enabledDEXes = [];
  if (useSushiSwapV3) enabledDEXes.push({ name: 'SushiSwapV3', pool: SUSHISWAP_V3_POOL_ADDRESS, type: 'V3', fee: cachedSushiSwapV3Fee });
  if (useCoreX) enabledDEXes.push({ name: 'CoreX', pool: CORE_X_POOL_ADDRESS, type: 'V3', fee: cachedCoreXFee });
  if (useGlyphExchangeV4) enabledDEXes.push({ name: 'GlyphExchangeV4', pool: GLYPH_EXCHANGE_V4_POOL_ADDRESS, type: 'V2', fee: cachedGlyphExchangeV4Fee });
  if (useArcherSwap) enabledDEXes.push({ name: 'ArcherSwap', pool: ARCHERSWAP_POOL_ADDRESS, type: 'V2', fee: cachedArcherSwapFee });
  if (useIcecreamSwap) enabledDEXes.push({ name: 'IcecreamSwap', pool: ICECREAM_SWAP_POOL_ADDRESS, type: 'V2', fee: cachedIcecreamSwapFee });

  const pairs = [];
  for (let i = 0; i < enabledDEXes.length; i++) {
    for (let j = 0; j < enabledDEXes.length; j++) {
      if (i !== j) {
        pairs.push({
          poolBuy: enabledDEXes[i].pool,
          poolSell: enabledDEXes[j].pool,
          feeBuy: enabledDEXes[i].fee,
          feeSell: enabledDEXes[j].fee
        });
      }
    }
  }

  const loanAmount = calculateLoanAmount(cachedSushiSwapV3Price);

  Object.keys(presignedTxCache).forEach(key => delete presignedTxCache[key]);

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
      const txData = flashLoanArbitrage.interface.encodeFunctionData(
        "executeArbitrage",
        [pair.poolBuy, pair.poolSell, TOKEN_A_ADDRESS, loanAmount, 0, 0, deadline, pair.feeBuy, pair.feeSell]
      );

      const tx = {
        to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
        data: txData,
        chainId: BigInt(CHAIN_ID),
        type: 2,
        gasLimit: gasLimit,
        maxFeePerGas: adjustedMaxFeePerGas,
        maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
        nonce: nonceToUse
      };

      const signedTx = await signer.signTransaction(tx);
      presignedTxCache[`${pair.poolBuy}-${pair.poolSell}`] = { signedTx, timestamp: Date.now(), nonce: nonceToUse };
      console.log(`✅ Presigned tx for pair ${pair.poolBuy}-${pair.poolSell} at nonce ${nonceToUse}, maxFeePerGas: ${ethers.formatUnits(adjustedMaxFeePerGas, "gwei")} Gwei`);
    } catch (error) {
      console.error(`⚠️ Failed to presign tx for pair ${pair.poolBuy}-${pair.poolSell}: ${error.message}`);
    }
  }
};

/** Calculate dynamic arbitrage threshold based on fees */
const calculateDynamicThreshold = (poolBuyFee, poolSellFee) => {
  const swapFeeBuyPercent = Number(poolBuyFee) / 1e6 * 100;
  const swapFeeSellPercent = Number(poolSellFee) / 1e6 * 100;
  const totalFeesPercent = swapFeeBuyPercent + swapFeeSellPercent;
  return totalFeesPercent / 100;
};

/** Check for arbitrage opportunities */
const checkArbitrage = (context) => {
  console.log(`🔍 Checking arbitrage for context: ${context}`);
  if (shouldStop) {
    console.log(`🛑 Bot stopped due to stop condition. WINS: ${WINNING_STREAK} | LOSS: ${LOSING_STREAK}`);
    return;
  }

  if (Date.now() < pauseUntil) {
    console.log(`⏸️ Trading paused until ${pauseUntil}. Skipping arbitrage check.`);
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`🛑 Bot stopped: Reached max arbitrage transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
    shouldStop = true;
    wsProvider.websocket.close();
    return;
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("⏳ Max executing transactions reached, waiting...");
    return;
  }

  const prices = [];
  if (useSushiSwapV3 && cachedSushiSwapV3Price) prices.push({ dex: 'SushiSwapV3', price: cachedSushiSwapV3Price, pool: SUSHISWAP_V3_POOL_ADDRESS, fee: cachedSushiSwapV3Fee });
  if (useCoreX && cachedCoreXPrice) prices.push({ dex: 'CoreX', price: cachedCoreXPrice, pool: CORE_X_POOL_ADDRESS, fee: cachedCoreXFee });
  if (useGlyphExchangeV4 && cachedGlyphExchangeV4Price) prices.push({ dex: 'GlyphExchangeV4', price: cachedGlyphExchangeV4Price, pool: GLYPH_EXCHANGE_V4_POOL_ADDRESS, fee: cachedGlyphExchangeV4Fee });
  if (useArcherSwap && cachedArcherSwapPrice) prices.push({ dex: 'ArcherSwap', price: cachedArcherSwapPrice, pool: ARCHERSWAP_POOL_ADDRESS, fee: cachedArcherSwapFee });
  if (useIcecreamSwap && cachedIcecreamSwapPrice) prices.push({ dex: 'IcecreamSwap', price: cachedIcecreamSwapPrice, pool: ICECREAM_SWAP_POOL_ADDRESS, fee: cachedIcecreamSwapFee });

  if (prices.length < 2) {
    console.log("⚠️ Not enough DEXes enabled for arbitrage check.");
    return;
  }

  const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
  const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
  const priceDiff = maxPriceDex.price - minPriceDex.price;
  const percentageDiff = (priceDiff / minPriceDex.price) * 100;

  // Update highest differences as soon as a larger difference is found
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;
  if (percentageDiff > highestPercentageDiff) highestPercentageDiff = percentageDiff;

  let isArbitrageOpportunity = false;
  if (AUTO_THRESHOLD) {
    const totalFees = calculateDynamicThreshold(maxPriceDex.fee, minPriceDex.fee);
    const profitPercent = percentageDiff - (totalFees * 100);
    if (profitPercent > 0) {
      isArbitrageOpportunity = true;
    }
  } else if (ARB_BY_PERCENT) {
    if (percentageDiff > PERCENTAGE_THRESHOLD) {
      isArbitrageOpportunity = true;
    }
  } else {
    if (priceDiff > ARBITRAGE_THRESHOLD) {
      isArbitrageOpportunity = true;
    }
  }

  if (!isArbitrageOpportunity) {
    console.log(`ℹ️ No arbitrage opportunity. Percentage diff: ${percentageDiff.toFixed(4)}%, Price diff: ${priceDiff.toFixed(18)}, Highest Diff: ${highestPriceDiff}, Highest Diff %: ${highestPercentageDiff} `);
    if (arbOpportunityStartTime !== null) {
      opportunityVanishedTime = Date.now();
      const duration = opportunityVanishedTime - arbOpportunityStartTime;
      console.log(`⏱️ Arbitrage opportunity vanished after ${duration} ms`);
      fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
      arbOpportunityStartTime = null;
      opportunityVanishedTime = null;
    }
    return;
  }

  if (priceDiff < MIN_PRICE_DIFF_THRESHOLD) {
    console.log(`ℹ️ Price difference (${priceDiff.toFixed(18)}) is below minimum threshold (${MIN_PRICE_DIFF_THRESHOLD}). Skipping trade.`);
    if (arbOpportunityStartTime !== null) {
      opportunityVanishedTime = Date.now();
      const duration = opportunityVanishedTime - arbOpportunityStartTime;
      console.log(`⏱️ Arbitrage opportunity vanished after ${duration} ms`);
      fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
      arbOpportunityStartTime = null;
      opportunityVanishedTime = null;
    }
    return;
  }

  if (lastLosingTime > 0 && Date.now() - lastLosingTime < COOLDOWN_PERIOD) {
    const requiredDiff = lastLosingPriceDiff * 1.3;
    if (priceDiff <= requiredDiff) {
      console.log(`ℹ️ Skipping trade: Price diff ${priceDiff.toFixed(18)} <= ${requiredDiff.toFixed(18)} (1.3 * last losing price diff)`);
      return;
    }
  }

  (async () => {
    await fetchAndLogPrices("opportunity_detected");
    setTimeout(async () => {
      await fetchAndLogPrices("2s_after_opportunity");
    }, 2000);
  })();

  if (arbOpportunityStartTime === null) {
    arbOpportunityStartTime = Date.now();
    console.log(`💡 Arbitrage opportunity detected at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}`);
    fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity detected at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}\n`);
  }
  arbitrageCount++;
  console.log(`📈 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (${percentageDiff.toFixed(4)}%), Highest diff: ${highestPriceDiff.toFixed(10)} (${highestPercentageDiff.toFixed(4)}%)`);
  const poolBuy = maxPriceDex.pool;
  const poolSell = minPriceDex.pool;
  const detectionTime = arbOpportunityStartTime;
//   executePresignedArbitrage(poolBuy, poolSell, detectionTime, priceDiff);
};

/** Log transaction details */
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
  const errorMessage = error ? `\nError: ${error}` : '';
  const profitInTokenB = profitInTokenA * cachedSushiSwapV3Price;
  const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
  const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, tokenADecimals));

  const logMessage = `
🕒 Timestamp: ${timestamp}
🔢 Transaction #${serial}
ℹ️ Status: ${statusText}
📜 Transaction Hash: ${txHash || 'N/A'}
↔️ Path: ${poolBuy} -> ${poolSell}
💸 Loan Amount: ${loanAmountInTokenA.toFixed(18)} TOKEN_A
💰 Profit: ${profitInTokenA.toFixed(18)} TOKEN_A
⛽ Gas Cost: ${gasCostInTokenB.toFixed(18)} TOKEN_B
💲 Buy Swap Fee: ${swapFeeBuy.toFixed(18)} TOKEN_B
💲 Sell Swap Fee: ${swapFeeSell.toFixed(18)} TOKEN_B
📈 Net PnL: ${netPnLInTokenB.toFixed(18)} TOKEN_B
📊 Cumulative PnL: ${cumulativePnL.toFixed(18)} TOKEN_B
🏆 Winning Streak: ${WINNING_STREAK}
💔 Losing Streak: ${LOSING_STREAK}
🏆 Total Wins: ${totalWins}
💔 Total Losses: ${totalLosses}
⏱️ Timing Details:
- Detection to retrieve/generate: ${timingDetails.timeToRetrieveOrGenerate} ms
- Retrieve/generate to send: ${timingDetails.timeToSend} ms
- Send to confirm: ${timingDetails.timeToConfirm} ms
- Total execution time: ${timingDetails.totalTime} ms
🔍 Opportunity Status at Confirmation: ${opportunityStatus}${errorMessage}
--------------------------------------------------
`;
  console.log(logMessage);
  fs.appendFileSync(path.join(__dirname, "p&l.txt"), logMessage);
};

/** Execute arbitrage using presigned transaction */
const executePresignedArbitrage = async (poolBuy, poolSell, detectionTime, priceDiff) => {
  console.log(`🚀 Starting arbitrage execution #${arbitrageCount} for ${poolBuy} -> ${poolSell}`);
  executingTransactions++;
  console.log(`ℹ️ Executing transactions count: ${executingTransactions}`);
  let loanAmount = ethers.getBigInt(0);

  try {
    const retrieveOrGenerateTime = Date.now();
    const pairKey = `${poolBuy}-${poolSell}`;
    let presigned = presignedTxCache[pairKey];
    if (!presigned || Date.now() - presigned.timestamp > PRESIGN_INTERVAL) {
      console.log("✍️ No valid presigned tx or expired. Generating new one.");
      await preparePresignedTransactions();
      presigned = presignedTxCache[pairKey];
      if (!presigned) throw new Error("Failed to generate presigned transaction");
    } else {
      console.log("✅ Using presigned transaction.");
    }

    const tx = ethers.Transaction.from(presigned.signedTx);
    const decoded = flashLoanArbitrage.interface.decodeFunctionData("executeArbitrage", tx.data);
    loanAmount = decoded.amount;

    const sendStartTime = Date.now();
    console.log(`📤 Sending tx at ${sendStartTime}`);
    const txHash = await httpProvider.send("eth_sendRawTransaction", [presigned.signedTx]);
    const hashReceivedTime = Date.now();
    console.log(`✅ Tx hash received: ${txHash} at ${hashReceivedTime}`);

    currentNonce++;
    console.log(`🔢 Nonce incremented to ${currentNonce} after sending tx`);
    await preparePresignedTransactions();

    const waitStartTime = Date.now();
    console.log(`⏳ Waiting for tx confirmation at ${waitStartTime}`);
    const receipt = await httpProvider.waitForTransaction(txHash);
    const confirmTime = Date.now();
    console.log(`✅ Tx confirmed at ${confirmTime}`);

    const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
    const timeToSend = sendStartTime - retrieveOrGenerateTime;
    const timeToConfirm = confirmTime - sendStartTime;
    const totalTime = confirmTime - detectionTime;

    if (receipt) {
      console.log(`ℹ️ TX Status: ${receipt.status}`);
      let profitInTokenA = 0;
      let success = false;
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

      const gasCostInTokenB = Number(ethers.formatUnits(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || cachedFeeData.gasPrice), tokenBDecimals));
      const profitInTokenB = profitInTokenA * cachedSushiSwapV3Price;
      const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
      cumulativePnLInTokenB += netPnLInTokenB;

      const isSuccess = receipt.status === 1;
      updateStreaks(isSuccess, priceDiff);

      await updatePrices();
      const prices = [];
      if (useSushiSwapV3 && cachedSushiSwapV3Price) prices.push({ dex: 'SushiSwapV3', price: cachedSushiSwapV3Price });
      if (useCoreX && cachedCoreXPrice) prices.push({ dex: 'CoreX', price: cachedCoreXPrice });
      if (useGlyphExchangeV4 && cachedGlyphExchangeV4Price) prices.push({ dex: 'GlyphExchangeV4', price: cachedGlyphExchangeV4Price });
      if (useArcherSwap && cachedArcherSwapPrice) prices.push({ dex: 'ArcherSwap', price: cachedArcherSwapPrice });
      if (useIcecreamSwap && cachedIcecreamSwapPrice) prices.push({ dex: 'IcecreamSwap', price: cachedIcecreamSwapPrice });

      let opportunityStatus = '';
      const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
      const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
      const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
      const currentPercentageDiff = (currentPriceDiff / minPriceDex.price) * 100;

      if (AUTO_THRESHOLD) {
        const totalFees = calculateDynamicThreshold(cachedSushiSwapV3Fee, cachedIcecreamSwapFee);
        const profitPercent = currentPercentageDiff - (totalFees * 100);
        if (profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
          opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
        } else {
          opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
          if (arbOpportunityStartTime !== null) {
            opportunityVanishedTime = confirmTime;
            const duration = opportunityVanishedTime - arbOpportunityStartTime;
            opportunityStatus += ` after ${duration} ms`;
            fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
            arbOpportunityStartTime = null;
            opportunityVanishedTime = null;
          }
        }
      } else if (ARB_BY_PERCENT) {
        if (currentPercentageDiff > PERCENTAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
          opportunityStatus = `Opportunity persists (Percentage diff: ${currentPercentageDiff.toFixed(4)}%)`;
        } else {
          opportunityStatus = `Opportunity vanished (Percentage diff: ${currentPercentageDiff.toFixed(4)}%)`;
          if (arbOpportunityStartTime !== null) {
            opportunityVanishedTime = confirmTime;
            const duration = opportunityVanishedTime - arbOpportunityStartTime;
            opportunityStatus += ` after ${duration} ms`;
            fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
            arbOpportunityStartTime = null;
            opportunityVanishedTime = null;
          }
        }
      } else {
        if (currentPriceDiff > ARBITRAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
          opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
        } else {
          opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
          if (arbOpportunityStartTime !== null) {
            opportunityVanishedTime = confirmTime;
            const duration = opportunityVanishedTime - arbOpportunityStartTime;
            opportunityStatus += ` after ${duration} ms`;
            fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
            arbOpportunityStartTime = null;
            opportunityVanishedTime = null;
          }
        }
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
    const timeToSend = 0;
    const timeToConfirm = 0;
    const totalTime = Date.now() - detectionTime;

    updateStreaks(false, priceDiff);

    if (error.message.includes("nonce too low")) {
      console.log("⚠️ Nonce too low detected, refreshing nonce...");
      currentNonce = await getCurrentNonce();
      await preparePresignedTransactions();
    }

    await updatePrices();
    const prices = [];
    if (useSushiSwapV3 && cachedSushiSwapV3Price) prices.push({ dex: 'SushiSwapV3', price: cachedSushiSwapV3Price });
    if (useCoreX && cachedCoreXPrice) prices.push({ dex: 'CoreX', price: cachedCoreXPrice });
    if (useGlyphExchangeV4 && cachedGlyphExchangeV4Price) prices.push({ dex: 'GlyphExchangeV4', price: cachedGlyphExchangeV4Price });
    if (useArcherSwap && cachedArcherSwapPrice) prices.push({ dex: 'ArcherSwap', price: cachedArcherSwapPrice });
    if (useIcecreamSwap && cachedIcecreamSwapPrice) prices.push({ dex: 'IcecreamSwap', price: cachedIcecreamSwapPrice });

    let opportunityStatus = '';
    const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
    const currentPercentageDiff = (currentPriceDiff / minPriceDex.price) * 100;

    if (AUTO_THRESHOLD) {
      const totalFees = calculateDynamicThreshold(cachedSushiSwapV3Fee, cachedIcecreamSwapFee);
      const profitPercent = currentPercentageDiff - (totalFees * 100);
      if (profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
        opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
      } else {
        opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
        if (arbOpportunityStartTime !== null) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          opportunityStatus += ` after ${duration} ms`;
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
      }
    } else if (ARB_BY_PERCENT) {
      if (currentPercentageDiff > PERCENTAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
        opportunityStatus = `Opportunity persists (Percentage diff: ${currentPercentageDiff.toFixed(4)}%)`;
      } else {
        opportunityStatus = `Opportunity vanished (Percentage diff: ${currentPercentageDiff.toFixed(4)}%)`;
        if (arbOpportunityStartTime !== null) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          opportunityStatus += ` after ${duration} ms`;
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
      }
    } else {
      if (currentPriceDiff > ARBITRAGE_THRESHOLD && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
        opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
      } else {
        opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
        if (arbOpportunityStartTime !== null) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          opportunityStatus += ` after ${duration} ms`;
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
      }
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
      { timeToRetrieveOrGenerate, timeToSend, timeToConfirm, totalTime },
      opportunityStatus,
      error.message
    );
    checkStopCondition();
  } finally {
    executingTransactions--;
    console.log(`ℹ️ Transaction completed. Executing transactions: ${executingTransactions}`);
    if (executingTransactions < MAX_EXECUTING_TRANSACTIONS && !shouldStop) {
      checkArbitrage("PostTransaction");
    }
  }
};

/** Check stop-loss condition */
const checkStopCondition = () => {
  console.log("ℹ️ Stop-loss check skipped as TOKEN_B/USD price is unavailable");
};

// ========== INITIALIZATION ==========
(async () => {
  try {
    console.log("🛠️ Initializing HTTP provider and signer...");
    httpProvider = new ethers.JsonRpcProvider(process.env.CORE_HTTP_RPC_URL, coreNetwork);
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    console.log(`👤 Signer address: ${signer.address}`);

    currentNonce = await getCurrentNonce();
    flashLoanArbitrage = new ethers.Contract(
      FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      FLASHLOAN_ARBITRAGE_ABI,
      signer
    );
    console.log(`📜 Flashloan contract initialized at: ${FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS}`);

    await updateFeeData();
    await connectWebSocket();
  } catch (error) {
    console.error(`⚠️ Initialization failed: ${error.message}`);
    process.exit(1);
  }
})();