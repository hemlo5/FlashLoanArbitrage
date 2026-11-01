const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ========== CONFIGURATION ==========

const TOKEN_A_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // TBTC
const TOKEN_B_ADDRESS = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"; // WBTC

const UNISWAP_V3_POOL_ADDRESS = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443"; // Uniswap V3 
const SUSHISWAP_V2_POOL_ADDRESS = "0x905dfCD5649217c42684f23958568e533C711Aa3"; // SushiSwap V2 
const ARBSWAP_POOL_ADDRESS = "0x4832e0a194281d1ffE464C654E4E938f642DD362"; // Arbswap pool address
const ARBIDEX_POOL_ADDRESS = "0x39511b74722afe77d532eb70632b4b59c559019b"; // Arbidex pool address
const PANCAKESWAP_V3_POOL_ADDRESS = "0x7fcdc35463e3770c2fb992716cd070b63540b947"; // PancakeSwap V3 
const CAMELOT_V3_POOL_ADDRESS = "0x84652bb2539513BAf36e225c930Fdd8eaa63CE27"; // Camelot V3
const BALANCER_V2_POOL_ADDRESS = "0x32df62dc3aed2cd6224193052ce665dc18165841"; // Balancer V2 pool address
const CURVE_POOL_ADDRESS = "0x186cf879186986a20aadfb7ead50e3c20cb26cec"; // Curve pool address

let useUniswap = true;
let useSushiSwap = false;
let useArbswap = false;
let useArbidex = false;
let usePancakeSwapV3 = true;
let useCamelotV3 = true;
let useBalancerV2 = false; // Disabled due to pool not having exactly two tokens
let useCurve = false;

const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x76d8a81e59a5E3503C2F34629932557B68797b4c"; // 0x59fFe188f3c82256DB95a7f8d9455A454F5275A3 old contract with logs
const BORROW_VALUE_USD = 50;
const ARBITRAGE_THRESHOLD = 8;
const ARBITRAGE_THRESHOLD_PERCENT = 0.2; // 0.5% threshold
const ARB_BY_PERCENT = true; // Use percentage threshold if true
const MIN_PRICE_DIFF_THRESHOLD = 0.0;
const MIN_ARBITRAGE_THRESHOLD_PERCENT = .2; // 0.1% minimum threshold
const MAX_ARBITRAGE_TRANSACTIONS = 1000;
const STOP_LOSS_USD = 2.5;
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Chainlink WETH/USD
const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer V2 Vault
const GAS_FEE_MULTIPLIER = 1;
const AUTO_THRESHOLD = false;

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute
const LOSING_STREAK_THRESHOLD = 1;
const PAUSE_PERIOD = 60000; // 5 minutes
const MAX_TOTAL_LOSSES = 3;

// ========== ABI DEFINITIONS ==========
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const CAMELOT_V3_POOL_ABI = [
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

const BALANCER_V2_POOL_ABI = [
  "function getPoolId() view returns (bytes32)",
  "function getNormalizedWeights() view returns (uint256[])",
  "function getSwapFeePercentage() view returns (uint256)"
];

const CURVE_POOL_ABI = [
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function fee() view returns (uint256)",
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)"
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
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
  "function getProtocolFeesCollector() view returns (address)"
];

const PROTOCOL_FEES_COLLECTOR_ABI = [
  "function getFlashLoanFeePercentage() view returns (uint256)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, arbswapPool, arbidexPool, pancakeswapV3Pool, camelotV3Pool, balancerV2Pool, curvePool, flashLoanArbitrage, chainlinkTokenBUsd, vault;
let uniswapIsTokenAFirst, sushiswapIsTokenAFirst, arbswapIsTokenAFirst, arbidexIsTokenAFirst, pancakeswapIsTokenAFirst, camelotIsTokenAFirst, balancerIsTokenAFirst, curveIsTokenAFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0, cachedArbswapPrice = 0, cachedArbidexPrice = 0, cachedPancakeSwapV3Price = 0, cachedCamelotV3Price = 0, cachedBalancerPrice = 0, cachedCurvePrice = 0;
let cachedTokenBUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedArbswapFee, cachedArbidexFee, cachedPancakeSwapV3Fee, cachedCamelotV3Fee, cachedBalancerFee, cachedCurveFee, cachedFlashloanPremium;
let tokenADecimals, tokenBDecimals;
let highestPriceDiff = 0;
let highestPriceDiffPercent = 0; // New variable to track highest percentage difference
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
  console.log(`TOKEN_A (TBTC) decimals: ${tokenADecimals}, TOKEN_B (WBTC) decimals: ${tokenBDecimals}`);
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

/** Calculate price (tokenB/tokenA) from V2 reserves */
const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = BigInt(reserves.reserve0);
  const reserve1 = BigInt(reserves.reserve1);
  const decimalsA = BigInt(10) ** BigInt(isTokenAFirst ? tokenADecimals : tokenBDecimals);
  const decimalsB = BigInt(10) ** BigInt(isTokenAFirst ? tokenBDecimals : tokenADecimals);
  const precision = BigInt(10) ** BigInt(18);
  const priceScaled = (reserve1 * precision * decimalsA) / (reserve0 * decimalsB);
  return Number(priceScaled) / 1e18;
};

/** Update prices from pool states */
const updatePrices = async (blockTag = "latest") => {
  console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
  const prices = {};

  if (useUniswap) {
    try {
      const slot0Uni = await uniswapV3Pool.slot0({ blockTag });
      console.log(`Uniswap slot0: sqrtPriceX96=${slot0Uni.sqrtPriceX96.toString()}`);
      prices.uniswap = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Uniswap slot0 call failed: ${e.message}`);
    }
  }

  if (useSushiSwap) {
    try {
      const reservesSushi = await sushiswapV2Pool.getReserves({ blockTag });
      prices.sushiSwap = calculateV2Price(reservesSushi, sushiswapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ SushiSwap getReserves call failed: ${e.message}`);
    }
  }

  if (useArbswap) {
    try {
      const reservesArbswap = await arbswapPool.getReserves({ blockTag });
      prices.arbswap = calculateV2Price(reservesArbswap, arbswapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Arbswap getReserves call failed: ${e.message}`);
    }
  }

  if (useArbidex) {
    try {
      const reservesArbidex = await arbidexPool.getReserves({ blockTag });
      prices.arbidex = calculateV2Price(reservesArbidex, arbidexIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Arbidex getReserves call failed: ${e.message}`);
    }
  }

  if (usePancakeSwapV3) {
    try {
      const slot0Pancake = await pancakeswapV3Pool.slot0({ blockTag });
      console.log(`PancakeSwap V3 slot0: sqrtPriceX96=${slot0Pancake.sqrtPriceX96.toString()}`);
      prices.pancakeSwapV3 = calculateV3Price(slot0Pancake.sqrtPriceX96, pancakeswapIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ PancakeSwap V3 slot0 call failed: ${e.message}`);
    }
  }

  if (useCamelotV3) {
    try {
      const slot0Camelot = await camelotV3Pool.slot0({ blockTag });
      console.log(`Camelot V3 slot0: sqrtPriceX96=${slot0Camelot.sqrtPriceX96.toString()}`);
      prices.camelotV3 = calculateV3Price(slot0Camelot.sqrtPriceX96, camelotIsTokenAFirst);
    } catch (e) {
      console.error(`⚠️ Camelot V3 slot0 call failed: ${e.message}`);
    }
  }

  if (useBalancerV2) {
    try {
      const poolId = await balancerV2Pool.getPoolId();
      const [tokens, balances] = await vault.getPoolTokens(poolId, { blockTag });
      const tokenAIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase());
      const tokenBIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase());
      const balanceA = BigInt(balances[tokenAIndex]);
      const balanceB = BigInt(balances[tokenBIndex]);
      const precision = BigInt(10) ** BigInt(18);
      const decimalsA = BigInt(10) ** BigInt(tokenADecimals);
      const decimalsB = BigInt(10) ** BigInt(tokenBDecimals);
      const priceScaled = (balanceB * precision * decimalsA) / (balanceA * decimalsB);
      prices.balancerV2 = Number(priceScaled) / 1e18;
    } catch (e) {
      console.error(`⚠️ Balancer V2 price fetch failed: ${e.message}`);
    }
  }

  if (useCurve) {
    try {
      const balance0 = BigInt(await curvePool.balances(0, { blockTag }));
      const balance1 = BigInt(await curvePool.balances(1, { blockTag }));
      const coin0 = await curvePool.coins(0);
      const coin1 = await curvePool.coins(1);
      console.log(`Curve coin0: ${coin0}, coin1: ${coin1}`);
      console.log(`Curve balance0: ${balance0.toString()}, balance1: ${balance1.toString()}`);
      let balanceA, balanceB;
      if (coin0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase()) {
        balanceA = balance0;
        balanceB = balance1;
        console.log(`Assigned balanceA (TBTC: ${TOKEN_A_ADDRESS}) = balance0: ${balanceA.toString()}`);
        console.log(`Assigned balanceB (WBTC: ${TOKEN_B_ADDRESS}) = balance1: ${balanceB.toString()}`);
      } else {
        balanceA = balance1;
        balanceB = balance0;
        console.log(`Assigned balanceA (TBTC: ${TOKEN_A_ADDRESS}) = balance1: ${balanceA.toString()}`);
        console.log(`Assigned balanceB (WBTC: ${TOKEN_B_ADDRESS}) = balance0: ${balanceB.toString()}`);
      }
      const precision = BigInt(10) ** BigInt(18);
      const decimalsA = BigInt(10) ** BigInt(tokenADecimals);
      const decimalsB = BigInt(10) ** BigInt(tokenBDecimals);
      const priceScaled = (balanceB * precision * decimalsA) / (balanceA * decimalsB);
      const price = Number(priceScaled) / 1e18;
      prices.curve = price;
      console.log(`Curve price calculation: priceScaled = ${priceScaled.toString()}, price = ${price}`);
    } catch (e) {
      console.error(`⚠️ Curve price fetch failed: ${e.message}`);
    }
  }

  if (useUniswap && prices.uniswap) cachedUniswapPrice = prices.uniswap;
  if (useSushiSwap && prices.sushiSwap) cachedSushiSwapPrice = prices.sushiSwap;
  if (useArbswap && prices.arbswap) cachedArbswapPrice = prices.arbswap;
  if (useArbidex && prices.arbidex) cachedArbidexPrice = prices.arbidex;
  if (usePancakeSwapV3 && prices.pancakeSwapV3) cachedPancakeSwapV3Price = prices.pancakeSwapV3;
  if (useCamelotV3 && prices.camelotV3) cachedCamelotV3Price = prices.camelotV3;
  if (useBalancerV2 && prices.balancerV2) cachedBalancerPrice = prices.balancerV2;
  if (useCurve && prices.curve) cachedCurvePrice = prices.curve;

  console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
  return prices;
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
  vault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, wsProvider);

  if (useUniswap) {
    try {
      uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
      uniswapIsTokenAFirst = (await uniswapV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedUniswapFee = await uniswapV3Pool.fee();
      console.log(`💲 Uniswap V3 Pool Fee: ${cachedUniswapFee} (${(Number(cachedUniswapFee) / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Uniswap V3: ${e.message}`);
      useUniswap = false;
    }
  }

  if (useSushiSwap) {
    try {
      sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
      sushiswapIsTokenAFirst = (await sushiswapV2Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedSushiSwapFee = 3000; // 0.3% for V2
      console.log(`💲 SushiSwap V2 Pool Fee: ${cachedSushiSwapFee} (${(cachedSushiSwapFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize SushiSwap V2: ${e.message}`);
      useSushiSwap = false;
    }
  }

  if (useArbswap) {
    try {
      arbswapPool = new ethers.Contract(ARBSWAP_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
      arbswapIsTokenAFirst = (await arbswapPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedArbswapFee = 3000; // 0.3% for V2
      console.log(`💲 Arbswap Pool Fee: ${cachedArbswapFee} (${(cachedArbswapFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Arbswap: ${e.message}`);
      useArbswap = false;
    }
  }

  if (useArbidex) {
    try {
      arbidexPool = new ethers.Contract(ARBIDEX_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
      arbidexIsTokenAFirst = (await arbidexPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedArbidexFee = 3000; // 0.3% for V2
      console.log(`💲 Arbidex Pool Fee: ${cachedArbswapFee} (${(cachedArbidexFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Arbidex: ${e.message}`);
      useArbidex = false;
    }
  }

  if (usePancakeSwapV3) {
    try {
      pancakeswapV3Pool = new ethers.Contract(PANCAKESWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
      pancakeswapIsTokenAFirst = (await pancakeswapV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedPancakeSwapV3Fee = await pancakeswapV3Pool.fee();
      console.log(`💲 PancakeSwap V3 Pool Fee: ${cachedPancakeSwapV3Fee} (${(Number(cachedPancakeSwapV3Fee) / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize PancakeSwap V3: ${e.message}`);
      usePancakeSwapV3 = false;
    }
  }

  if (useCamelotV3) {
    try {
      camelotV3Pool = new ethers.Contract(CAMELOT_V3_POOL_ADDRESS, CAMELOT_V3_POOL_ABI, wsProvider);
      camelotIsTokenAFirst = (await camelotV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      cachedCamelotV3Fee = await camelotV3Pool.fee();
      console.log(`💲 Camelot V3 Pool Fee: ${cachedCamelotV3Fee} (${(Number(cachedCamelotV3Fee) / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Camelot V3: ${e.message}`);
      useCamelotV3 = false;
    }
  }

  if (useBalancerV2) {
    try {
      balancerV2Pool = new ethers.Contract(BALANCER_V2_POOL_ADDRESS, BALANCER_V2_POOL_ABI, wsProvider);
      const poolId = await balancerV2Pool.getPoolId();
      const [tokens] = await vault.getPoolTokens(poolId);
      if (tokens.length !== 2) throw new Error("Balancer V2 pool must have exactly two tokens");
      const tokenAIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase());
      const tokenBIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase());
      if (tokenAIndex === -1 || tokenBIndex === -1) throw new Error("Tokens not found in Balancer V2 pool");
      balancerIsTokenAFirst = tokenAIndex < tokenBIndex;
      const swapFeePercentage = await balancerV2Pool.getSwapFeePercentage();
      cachedBalancerFee = Number((swapFeePercentage * BigInt(1e6)) / BigInt(1e18));
      console.log(`💲 Balancer V2 Pool Fee: ${cachedBalancerFee} (${(cachedBalancerFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Balancer V2: ${e.message}`);
      useBalancerV2 = false;
    }
  }

  if (useCurve) {
    try {
      curvePool = new ethers.Contract(CURVE_POOL_ADDRESS, CURVE_POOL_ABI, wsProvider);
      const coin0 = await curvePool.coins(0);
      const coin1 = await curvePool.coins(1);
      if (coin0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase() && coin1.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase()) {
        curveIsTokenAFirst = true;
      } else if (coin0.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase() && coin1.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase()) {
        curveIsTokenAFirst = false;
      } else {
        throw new Error("Tokens not found in Curve pool");
      }
      const fee = await curvePool.fee();
      cachedCurveFee = Number((fee * BigInt(1e6)) / BigInt(1e10));
      console.log(`💲 Curve Pool Fee: ${cachedCurveFee} (${(cachedCurveFee / 1e6) * 100}%)`);
    } catch (e) {
      console.error(`⚠️ Failed to initialize Curve: ${e.message}`);
      useCurve = false;
    }
  }

  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);

  try {
    const addr = await vault.getProtocolFeesCollector();
    const protocolFeesCollector = new ethers.Contract(addr, PROTOCOL_FEES_COLLECTOR_ABI, wsProvider);
    cachedFlashloanPremium = await protocolFeesCollector.getFlashLoanFeePercentage();
    console.log(`💲 Balancer Flashloan Fee: ${cachedFlashloanPremium} (${Number(cachedFlashloanPremium) / 1e18}%)`);
  } catch (e) {
    console.error(`⚠️ Failed to fetch Balancer flashloan fee: ${e.message}`);
  }

  await fetchTokenDecimals();
  await updateTokenBUsdPrice();

  try {
    await updatePrices();
    console.log(`📊 Initial prices: Uniswap=${cachedUniswapPrice}, SushiSwap=${cachedSushiSwapPrice}, Arbswap=${cachedArbswapPrice}, Arbidex=${cachedArbidexPrice}, PancakeSwapV3=${cachedPancakeSwapV3Price}, CamelotV3=${cachedCamelotV3Price}, BalancerV2=${cachedBalancerPrice}, Curve=${cachedCurvePrice}`);
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

  if (useUniswap) {
    uniswapV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Uniswap V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Uniswap V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useSushiSwap) {
    sushiswapV2Pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on SushiSwap V2 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on SushiSwap V2 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useArbswap) {
    arbswapPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Arbswap at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Arbswap at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useArbidex) {
    arbidexPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Arbidex at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Arbidex at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (usePancakeSwapV3) {
    pancakeswapV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on PancakeSwap V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on PancakeSwap V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useCamelotV3) {
    camelotV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Camelot V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Camelot V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useBalancerV2) {
    balancerV2Pool.on("Swap", async (event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Balancer V2 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Balancer V2 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useCurve) {
    curvePool.on("TokenExchange", async (buyer, sold_id, tokens_sold, bought_id, tokens_bought, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Token Exchange on Curve at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Token Exchange on Curve at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  setInterval(updateFeeData, 100000); // Update gas fees every 10 seconds
  setInterval(updateTokenBUsdPrice, 60000);
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

/** Fetch and log prices from all DEXes */
const fetchAndLogPrices = async (context = "general") => {
  console.log(`🔍 Fetching prices for context: ${context}`);
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const prices = {};
      if (useUniswap) {
        const slot0Uni = await uniswapV3Pool.slot0();
        prices.uniswap = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsTokenAFirst);
      }
      if (useSushiSwap) {
        const reservesSushi = await sushiswapV2Pool.getReserves();
        prices.sushiSwap = calculateV2Price(reservesSushi, sushiswapIsTokenAFirst);
      }
      if (useArbswap) {
        const reservesArbswap = await arbswapPool.getReserves();
        prices.arbswap = calculateV2Price(reservesArbswap, arbswapIsTokenAFirst);
      }
      if (useArbidex) {
        const reservesArbidex = await arbidexPool.getReserves();
        prices.arbidex = calculateV2Price(reservesArbidex, arbidexIsTokenAFirst);
      }
      if (usePancakeSwapV3) {
        const slot0Pancake = await pancakeswapV3Pool.slot0();
        prices.pancakeSwapV3 = calculateV3Price(slot0Pancake.sqrtPriceX96, pancakeswapIsTokenAFirst);
      }
      if (useCamelotV3) {
        const slot0Camelot = await camelotV3Pool.slot0();
        prices.camelotV3 = calculateV3Price(slot0Camelot.sqrtPriceX96, camelotIsTokenAFirst);
      }
      if (useBalancerV2) {
        const poolId = await balancerV2Pool.getPoolId();
        const [tokens, balances] = await vault.getPoolTokens(poolId);
        const tokenAIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase());
        const tokenBIndex = tokens.findIndex(t => t.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase());
        const balanceA = BigInt(balances[tokenAIndex]);
        const balanceB = BigInt(balances[tokenBIndex]);
        const precision = BigInt(10) ** BigInt(18);
        const decimalsA = BigInt(10) ** BigInt(tokenADecimals);
        const decimalsB = BigInt(10) ** BigInt(tokenBDecimals);
        const priceScaled = (balanceB * precision * decimalsA) / (balanceA * decimalsB);
        prices.balancerV2 = Number(priceScaled) / 1e18;
      }
      if (useCurve) {
        const balance0 = BigInt(await curvePool.balances(0));
        const balance1 = BigInt(await curvePool.balances(1));
        const coin0 = await curvePool.coins(0);
        const coin1 = await curvePool.coins(1);
        let balanceA, balanceB;
        if (coin0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase()) {
          balanceA = balance0;
          balanceB = balance1;
        } else {
          balanceA = balance1;
          balanceB = balance0;
        }
        const precision = BigInt(10) ** BigInt(18);
        const decimalsA = BigInt(10) ** BigInt(tokenADecimals);
        const decimalsB = BigInt(10) ** BigInt(tokenBDecimals);
        const priceScaled = (balanceB * precision * decimalsA) / (balanceA * decimalsB);
        prices.curve = Number(priceScaled) / 1e18;
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
  if (cachedTokenBUsdPrice === 0) throw new Error("TOKEN_B/USD price not available");
  const borrowValueTokenB = BORROW_VALUE_USD / cachedTokenBUsdPrice;
  const tokenAAmountFloat = borrowValueTokenB / targetPrice;
  return ethers.parseUnits(tokenAAmountFloat.toFixed(8), tokenADecimals);
};

/** Get current nonce from the blockchain */
const getCurrentNonce = async () => {
  console.log("🔢 Fetching current nonce...");
  const nonce = BigInt(await signer.provider.getTransactionCount(signer.address, "pending"));
  console.log(`✅ Current nonce: ${nonce}`);
  return nonce;
};

/** Check account balance and throw error if insufficient */
const checkBalance = async (maxFeePerGas, gasLimit) => {
  const balance = await signer.provider.getBalance(signer.address);
  const requiredFunds = maxFeePerGas * gasLimit;
  if (balance < requiredFunds) {
    throw new Error(
      `Insufficient funds: have ${ethers.formatUnits(balance, "ether")} ETH, need ${ethers.formatUnits(requiredFunds, "ether")} ETH`
    );
  }
  console.log(`✅ Balance sufficient: ${ethers.formatUnits(balance, "ether")} ETH available`);
};

/** Prepare presigned transactions for all enabled DEX pairs with cached gas fees */
const preparePresignedTransactions = async () => {
  console.log("✍️ Preparing presigned transactions...");
  if (!cachedUniswapPrice || !cachedTokenBUsdPrice) {
    console.log("⚠️ Skipping presigning: Price data incomplete");
    return;
  }

  if (!cachedFeeData) {
    console.log("⚠️ Skipping presigning: Fee data not available");
    await updateFeeData();
    if (!cachedFeeData) return;
  }

  const enabledDEXes = [];
  if (useUniswap) enabledDEXes.push({ name: 'Uniswap', pool: UNISWAP_V3_POOL_ADDRESS, type: 'V3', fee: cachedUniswapFee });
  if (useSushiSwap) enabledDEXes.push({ name: 'SushiSwap', pool: SUSHISWAP_V2_POOL_ADDRESS, type: 'V2', fee: cachedSushiSwapFee });
  if (useArbswap) enabledDEXes.push({ name: 'Arbswap', pool: ARBSWAP_POOL_ADDRESS, type: 'V2', fee: cachedArbswapFee });
  if (useArbidex) enabledDEXes.push({ name: 'Arbidex', pool: ARBIDEX_POOL_ADDRESS, type: 'V2', fee: cachedArbidexFee });
  if (usePancakeSwapV3) enabledDEXes.push({ name: 'PancakeSwapV3', pool: PANCAKESWAP_V3_POOL_ADDRESS, type: 'V3', fee: cachedPancakeSwapV3Fee });
  if (useCamelotV3) enabledDEXes.push({ name: 'CamelotV3', pool: CAMELOT_V3_POOL_ADDRESS, type: 'V3', fee: cachedCamelotV3Fee });
  if (useBalancerV2) enabledDEXes.push({ name: 'BalancerV2', pool: BALANCER_V2_POOL_ADDRESS, type: 'BalancerV2', fee: cachedBalancerFee });
  if (useCurve) enabledDEXes.push({ name: 'Curve', pool: CURVE_POOL_ADDRESS, type: 'Curve', fee: cachedCurveFee });

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

  const loanAmount = calculateLoanAmount(cachedUniswapPrice);

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
        chainId: BigInt(42161), // Arbitrum chain ID
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
  const flashloanFeePercent = Number(cachedFlashloanPremium) / 1e18 * 100;
  const totalFeesPercent = swapFeeBuyPercent + swapFeeSellPercent + flashloanFeePercent;
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
  if (useUniswap && cachedUniswapPrice) prices.push({ dex: 'Uniswap', price: cachedUniswapPrice, pool: UNISWAP_V3_POOL_ADDRESS, fee: cachedUniswapFee });
  if (useSushiSwap && cachedSushiSwapPrice) prices.push({ dex: 'SushiSwap', price: cachedSushiSwapPrice, pool: SUSHISWAP_V2_POOL_ADDRESS, fee: cachedSushiSwapFee });
  if (useArbswap && cachedArbswapPrice) prices.push({ dex: 'Arbswap', price: cachedArbswapPrice, pool: ARBSWAP_POOL_ADDRESS, fee: cachedArbswapFee });
  if (useArbidex && cachedArbidexPrice) prices.push({ dex: 'Arbidex', price: cachedArbidexPrice, pool: ARBIDEX_POOL_ADDRESS, fee: cachedArbidexFee });
  if (usePancakeSwapV3 && cachedPancakeSwapV3Price) prices.push({ dex: 'PancakeSwapV3', price: cachedPancakeSwapV3Price, pool: PANCAKESWAP_V3_POOL_ADDRESS, fee: cachedPancakeSwapV3Fee });
  if (useCamelotV3 && cachedCamelotV3Price) prices.push({ dex: 'CamelotV3', price: cachedCamelotV3Price, pool: CAMELOT_V3_POOL_ADDRESS, fee: cachedCamelotV3Fee });
  if (useBalancerV2 && cachedBalancerPrice) prices.push({ dex: 'BalancerV2', price: cachedBalancerPrice, pool: BALANCER_V2_POOL_ADDRESS, fee: cachedBalancerFee });
  if (useCurve && cachedCurvePrice) prices.push({ dex: 'Curve', price: cachedCurvePrice, pool: CURVE_POOL_ADDRESS, fee: cachedCurveFee });

  if (prices.length < 2) {
    console.log("⚠️ Not enough DEXes enabled for arbitrage check.");
    return;
  }

  let maxDiff = 0;
  let maxDiffPercent = 0;
  let maxDiffPair = '';
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
        if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;
        if (priceDiffPercent > highestPriceDiffPercent) highestPriceDiffPercent = priceDiffPercent;
      }
    }
  }
  console.log(`📊 Price diff on ${context}: Max diff=${maxDiff.toFixed(18)}, Percent=${maxDiffPercent.toFixed(4)}%, Pair=${maxDiffPair}, Highest diff ever=${highestPriceDiff.toFixed(18)}, Highest diff percent ever=${highestPriceDiffPercent.toFixed(4)}%`);
  console.log(`Winstreak: ${WINNING_STREAK} | Losestreak: ${LOSING_STREAK} | Total Wins: ${totalWins} | Total Losses: ${totalLosses}`);

  let maxPriceDex, minPriceDex, priceDiff, priceDiffPercent;

  if (ARB_BY_PERCENT) {
    maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    priceDiff = maxPriceDex.price - minPriceDex.price;
    priceDiffPercent = (priceDiff / minPriceDex.price) * 100;

    if (priceDiffPercent <= ARBITRAGE_THRESHOLD_PERCENT) {
      console.log(`ℹ️ No arbitrage. Price diff percent: ${priceDiffPercent.toFixed(4)}% <= ${ARBITRAGE_THRESHOLD_PERCENT}%`);
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

    if (priceDiffPercent < MIN_ARBITRAGE_THRESHOLD_PERCENT) {
      console.log(`ℹ️ Price diff percent (${priceDiffPercent.toFixed(4)}%) is below minimum threshold (${MIN_ARBITRAGE_THRESHOLD_PERCENT}%). Skipping trade.`);
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
  } else if (AUTO_THRESHOLD) {
    let maxProfit = 0;
    for (let i = 0; i < prices.length; i++) {
      for (let j = 0; j < prices.length; j++) {
        if (i !== j) {
          const priceDiffPercent = (prices[i].price - prices[j].price) / prices[j].price * 100;
          const totalFees = calculateDynamicThreshold(prices[i].fee, prices[j].fee);
          const profitPercent = priceDiffPercent - (totalFees * 100);
          if (profitPercent > maxProfit) {
            maxProfit = profitPercent;
            maxPriceDex = prices[i];
            minPriceDex = prices[j];
          }
        }
      }
    }
    if (maxProfit <= 0) {
      console.log("ℹ️ No profitable arbitrage opportunity found after fees.");
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
    priceDiff = maxPriceDex.price - minPriceDex.price;
    priceDiffPercent = (priceDiff / minPriceDex.price) * 100;
  } else {
    maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    priceDiff = maxPriceDex.price - minPriceDex.price;
    priceDiffPercent = (priceDiff / minPriceDex.price) * 100;

    if (priceDiff <= ARBITRAGE_THRESHOLD) {
      console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} <= ${ARBITRAGE_THRESHOLD}`);
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
  }

  // Check minimum price difference threshold (absolute)
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

  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;
  if (priceDiffPercent > highestPriceDiffPercent) highestPriceDiffPercent = priceDiffPercent;

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
  console.log(`📈 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Percent=${priceDiffPercent.toFixed(4)}%) (Highest: ${highestPriceDiff.toFixed(10)}, Highest Percent: ${highestPriceDiffPercent.toFixed(4)}%)`);
  const poolBuy = maxPriceDex.pool;
  const poolSell = minPriceDex.pool;
  const detectionTime = arbOpportunityStartTime;
  // executePresignedArbitrage(poolBuy, poolSell, detectionTime, priceDiff);
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
  const errorMessage = error ? `\nError: ${error}` : '';
  const profitUSD = (profitInTokenA * cachedUniswapPrice) * cachedTokenBUsdPrice;
  const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
  const swapFeeBuyUSD = swapFeeBuy * cachedTokenBUsdPrice;
  const swapFeeSellUSD = swapFeeSell * cachedTokenBUsdPrice;
  const netPnLUSD = netPnL * cachedTokenBUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;
  const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, tokenADecimals));
  const loanAmountUSD = (loanAmountInTokenA * cachedUniswapPrice) * cachedTokenBUsdPrice;

  const logMessage = `
🕒 Timestamp: ${timestamp}
🔢 Transaction #${serial}
ℹ️ Status: ${statusText}
📜 Transaction Hash: ${txHash || 'N/A'}
↔️ Path: ${poolBuy} -> ${poolSell}
💸 Loan Amount: ${loanAmountInTokenA.toFixed(18)} TOKEN_A (≈$${loanAmountUSD.toFixed(2)} USD)
💰 Profit: ${profitInTokenA.toFixed(18)} TOKEN_A (≈$${profitUSD.toFixed(2)} USD)
⛽ Gas Cost: ${gasCostInTokenB.toFixed(18)} TOKEN_B (≈$${gasCostUSD.toFixed(2)} USD)
💲 Buy Swap Fee: ${swapFeeBuy.toFixed(18)} TOKEN_B (≈$${swapFeeBuyUSD.toFixed(2)} USD)
💲 Sell Swap Fee: ${swapFeeSell.toFixed(18)} TOKEN_B (≈$${swapFeeSellUSD.toFixed(2)} USD)
📈 Net PnL: ${netPnL.toFixed(18)} TOKEN_B (≈$${netPnLUSD.toFixed(2)} USD)
📊 Cumulative PnL: ${cumulativePnL.toFixed(18)} TOKEN_B (≈$${cumulativePnLUSD.toFixed(2)} USD)
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

/** Execute arbitrage using presigned transaction and wait for confirmation */
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
      const profitInTokenB = profitInTokenA * cachedUniswapPrice;
      const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
      cumulativePnLInTokenB += netPnLInTokenB;

      const isSuccess = receipt.status === 1;
      updateStreaks(isSuccess, priceDiff);

      await updatePrices();
      const prices = [];
      if (useUniswap && cachedUniswapPrice) prices.push({ dex: 'Uniswap', price: cachedUniswapPrice });
      if (useSushiSwap && cachedSushiSwapPrice) prices.push({ dex: 'SushiSwap', price: cachedSushiSwapPrice });
      if (useArbswap && cachedArbswapPrice) prices.push({ dex: 'Arbswap', price: cachedArbswapPrice });
      if (useArbidex && cachedArbidexPrice) prices.push({ dex: 'Arbidex', price: cachedArbidexPrice });
      if (usePancakeSwapV3 && cachedPancakeSwapV3Price) prices.push({ dex: 'PancakeSwapV3', price: cachedPancakeSwapV3Price });
      if (useCamelotV3 && cachedCamelotV3Price) prices.push({ dex: 'CamelotV3', price: cachedCamelotV3Price });
      if (useBalancerV2 && cachedBalancerPrice) prices.push({ dex: 'BalancerV2', price: cachedBalancerPrice });
      if (useCurve && cachedCurvePrice) prices.push({ dex: 'Curve', price: cachedCurvePrice });

      let opportunityStatus = '';
      const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
      const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
      const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
      const currentPriceDiffPercent = (currentPriceDiff / minPriceDex.price) * 100;

      if (ARB_BY_PERCENT) {
        if (currentPriceDiffPercent > ARBITRAGE_THRESHOLD_PERCENT && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD && currentPriceDiffPercent >= MIN_ARBITRAGE_THRESHOLD_PERCENT) {
          opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)}, Percent: ${currentPriceDiffPercent.toFixed(4)}%)`;
        } else {
          opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)}, Percent: ${currentPriceDiffPercent.toFixed(4)}%)`;
          if (arbOpportunityStartTime !== null) {
            opportunityVanishedTime = confirmTime;
            const duration = opportunityVanishedTime - arbOpportunityStartTime;
            opportunityStatus += ` after ${duration} ms`;
            fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
            arbOpportunityStartTime = null;
            opportunityVanishedTime = null;
          }
        }
      } else if (AUTO_THRESHOLD) {
        const totalFees = calculateDynamicThreshold(cachedUniswapFee, cachedArbswapFee);
        const profitPercent = (currentPriceDiff / minPriceDex.price * 100) - (totalFees * 100);
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
    if (useUniswap && cachedUniswapPrice) prices.push({ dex: 'Uniswap', price: cachedUniswapPrice });
    if (useSushiSwap && cachedSushiSwapPrice) prices.push({ dex: 'SushiSwap', price: cachedSushiSwapPrice });
    if (useArbswap && cachedArbswapPrice) prices.push({ dex: 'Arbswap', price: cachedArbswapPrice });
    if (useArbidex && cachedArbidexPrice) prices.push({ dex: 'Arbidex', price: cachedArbidexPrice });
    if (usePancakeSwapV3 && cachedPancakeSwapV3Price) prices.push({ dex: 'PancakeSwapV3', price: cachedPancakeSwapV3Price });
    if (useCamelotV3 && cachedCamelotV3Price) prices.push({ dex: 'CamelotV3', price: cachedCamelotV3Price });
    if (useBalancerV2 && cachedBalancerPrice) prices.push({ dex: 'BalancerV2', price: cachedBalancerPrice });
    if (useCurve && cachedCurvePrice) prices.push({ dex: 'Curve', price: cachedCurvePrice });

    let opportunityStatus = '';
    const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
    const currentPriceDiffPercent = (currentPriceDiff / minPriceDex.price) * 100;

    if (ARB_BY_PERCENT) {
      if (currentPriceDiffPercent > ARBITRAGE_THRESHOLD_PERCENT && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD && currentPriceDiffPercent >= MIN_ARBITRAGE_THRESHOLD_PERCENT) {
        opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)}, Percent: ${currentPriceDiffPercent.toFixed(4)}%)`;
      } else {
        opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)}, Percent: ${currentPriceDiffPercent.toFixed(4)}%)`;
        if (arbOpportunityStartTime !== null) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          opportunityStatus += ` after ${duration} ms`;
          fs.appendFileSync(path.join(__dirname, "time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
          arbOpportunityStartTime = null;
          opportunityVanishedTime = null;
        }
      }
    } else if (AUTO_THRESHOLD) {
      const totalFees = calculateDynamicThreshold(cachedUniswapFee, cachedArbswapFee);
      const profitPercent = (currentPriceDiff / minPriceDex.price * 100) - (totalFees * 100);
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

    await updateFeeData();
    await connectWebSocket();
  } catch (error) {
    console.error(`⚠️ Initialization failed: ${error.message}`);
    process.exit(1);
  }
})();