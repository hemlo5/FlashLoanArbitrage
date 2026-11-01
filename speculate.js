const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const TOKEN_A_ADDRESS = "0x6985884c4392d348587b19cb9eaaf157f13271cd"; // ZRO on Arbitrum
const TOKEN_B_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH on Arbitrum

const UNISWAP_V3_POOL_ADDRESS = "0x4cef551255ec96d89fec975446301b5c4e164c59"; // Uniswap V3 ZRO/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0xbfca4230115de8341f3a3d5e8845ffb3337b2be3"; // SushiSwap V2
const ARBSWAP_POOL_ADDRESS = "0x4832e0a194281d1ffE464C654E4E938f642DD362"; // Arbswap pool address
const SWAPRUM_POOL_ADDRESS = "0x72ffa9f2bf5daf384952513ac6aa41e25dd5c713"; // Swaprum pool address
const CURVE_POOL_ADDRESS = "0x186cf879186986a20aadfb7ead50e3c20cb26cec"; // Curve pool ZRO/WETH
const ARBIDEX_POOL_ADDRESS = "0x39511b74722afe77d532eb70632b4b59c559019b"; // Arbidex pool address
const CAMELOT_V3_POOL_ADDRESS = "0x6eccab422d763ac031210895c81787e9c38f6520"; // Camelot V3 pool address
const PANCAKESWAP_V3_POOL_ADDRESS = "0xf0346b437fe43e64fa799c2bd3cf5db1f7e9327c"; // PancakeSwap V3 ZRO/WETH
const ARBITRAGE_THRESHOLD = 0.0000007;

// Boolean flags to enable/disable pools
const useUniswap = true;
const useSushiSwap = false;
const useArbswap = false;
const useSwaprum = false;
const useCurve = false;
const useArbidex = false;
const useCamelotV3 = false;
const usePancakeSwapV3 = true;

// ========== ABI DEFINITIONS ==========
const ERC20_ABI = [
  "function decimals() view returns (uint8)"
];

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

const CURVE_POOL_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function fee() view returns (uint256)",
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)"
];

const CAMELOT_V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

// Token indices for Curve pool (placeholders, not used since Curve is disabled)
let ZRO_INDEX = 1;
let WETH_INDEX = 0;

// ========== GLOBAL STATE ==========
let wsProvider;
let uniswapV3Pool, sushiswapV2Pool, arbswapPool, swaprumPool, curvePool, arbidexPool, camelotV3Pool, pancakeswapV3Pool;
let uniswapIsTokenAFirst, sushiswapIsTokenAFirst, arbswapIsTokenAFirst, swaprumIsTokenAFirst, arbidexIsTokenAFirst, camelotIsTokenAFirst, pancakeswapIsTokenAFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0, cachedArbswapPrice = 0, cachedSwaprumPrice = 0, cachedCurvePrice = 0, cachedArbidexPrice = 0, cachedCamelotV3Price = 0, cachedPancakeSwapV3Price = 0;
let arbOpportunityStartTime = null;
let opportunityHighestPriceDiff = 0;
let allTimeHighestPriceDiff = 0;
let curveFeePercent = "0.04%"; // Default assumed fee
let TOKEN_A_DECIMALS, TOKEN_B_DECIMALS;

// ========== CORE FUNCTIONS ==========

/** Update prices from pool states */
const updatePrices = async (blockTag = "latest") => {
  console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
  try {
    const pricePromises = [];

    if (useUniswap) {
      pricePromises.push(
        uniswapV3Pool.slot0({ blockTag })
          .then(slot0 => {
            const sqrtPriceX96 = slot0.sqrtPriceX96;
            if (typeof sqrtPriceX96 === 'bigint') {
              return calculateV3Price(sqrtPriceX96, uniswapIsTokenAFirst);
            } else {
              throw new Error('sqrtPriceX96 is not a BigInt');
            }
          })
          .catch(e => {
            console.error(`⚠️ Uniswap slot0 call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useSushiSwap) {
      pricePromises.push(
        sushiswapV2Pool.getReserves({ blockTag })
          .then(reserves => calculateV2Price(reserves, sushiswapIsTokenAFirst))
          .catch(e => {
            console.error(`⚠️ SushiSwap getReserves call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useArbswap) {
      pricePromises.push(
        arbswapPool.getReserves({ blockTag })
          .then(reserves => calculateV2Price(reserves, arbswapIsTokenAFirst))
          .catch(e => {
            console.error(`⚠️ Arbswap getReserves call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useSwaprum) {
      pricePromises.push(
        swaprumPool.getReserves({ blockTag })
          .then(reserves => calculateV2Price(reserves, swaprumIsTokenAFirst))
          .catch(e => {
            console.error(`⚠️ Swaprum getReserves call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useCurve) {
      const dx = ethers.parseUnits("1", TOKEN_A_DECIMALS);
      pricePromises.push(
        curvePool.get_dy(ZRO_INDEX, WETH_INDEX, dx, { blockTag })
          .then(dy => Number(ethers.formatUnits(dy, TOKEN_B_DECIMALS)))
          .catch(e => {
            console.error(`⚠️ Curve get_dy call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useArbidex) {
      pricePromises.push(
        arbidexPool.getReserves({ blockTag })
          .then(reserves => calculateV2Price(reserves, arbidexIsTokenAFirst))
          .catch(e => {
            console.error(`⚠️ Arbidex getReserves call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (useCamelotV3) {
      pricePromises.push(
        camelotV3Pool.slot0({ blockTag })
          .then(slot0 => {
            const sqrtPriceX96 = slot0.sqrtPriceX96;
            if (typeof sqrtPriceX96 === 'bigint') {
              return calculateV3Price(sqrtPriceX96, camelotIsTokenAFirst);
            } else {
              throw new Error('sqrtPriceX96 is not a BigInt');
            }
          })
          .catch(e => {
            console.error(`⚠️ Camelot V3 slot0 call failed: ${e.message}`);
            return null;
          })
      );
    }
    if (usePancakeSwapV3) {
      pricePromises.push(
        pancakeswapV3Pool.slot0({ blockTag })
          .then(slot0 => {
            const sqrtPriceX96 = slot0.sqrtPriceX96;
            if (typeof sqrtPriceX96 === 'bigint') {
              return calculateV3Price(sqrtPriceX96, pancakeswapIsTokenAFirst);
            } else {
              throw new Error('sqrtPriceX96 is not a BigInt');
            }
          })
          .catch(e => {
            console.error(`⚠️ PancakeSwap V3 slot0 call failed: ${e.message}`);
            return null;
          })
      );
    }

    const pricesArray = await Promise.all(pricePromises);

    const prices = {};
    let index = 0;
    if (useUniswap) prices.uniswap = pricesArray[index++];
    if (useSushiSwap) prices.sushiSwap = pricesArray[index++];
    if (useArbswap) prices.arbswap = pricesArray[index++];
    if (useSwaprum) prices.swaprum = pricesArray[index++];
    if (useCurve) prices.curve = pricesArray[index++];
    if (useArbidex) prices.arbidex = pricesArray[index++];
    if (useCamelotV3) prices.camelotV3 = pricesArray[index++];
    if (usePancakeSwapV3) prices.pancakeSwapV3 = pricesArray[index++];

    // Update cached prices only if fetch was successful
    if (useUniswap && prices.uniswap !== null) cachedUniswapPrice = prices.uniswap;
    if (useSushiSwap && prices.sushiSwap !== null) cachedSushiSwapPrice = prices.sushiSwap;
    if (useArbswap && prices.arbswap !== null) cachedArbswapPrice = prices.arbswap;
    if (useSwaprum && prices.swaprum !== null) cachedSwaprumPrice = prices.swaprum;
    if (useCurve && prices.curve !== null) cachedCurvePrice = prices.curve;
    if (useArbidex && prices.arbidex !== null) cachedArbidexPrice = prices.arbidex;
    if (useCamelotV3 && prices.camelotV3 !== null) cachedCamelotV3Price = prices.camelotV3;
    if (usePancakeSwapV3 && prices.pancakeSwapV3 !== null) cachedPancakeSwapV3Price = prices.pancakeSwapV3;

    console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
    return prices;
  } catch (error) {
    console.error(`⚠️ Failed to update prices for blockTag ${blockTag}: ${error.message}`);
    throw error;
  }
};

/** Calculate WETH per ZRO price from sqrtPriceX96 (V3 pools) */
const calculateV3Price = (sqrtPriceX96, isTokenAFirst) => {
  const Q96 = BigInt(2) ** BigInt(96);
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const price = (priceX192 * BigInt(10 ** 18)) / (Q96 * Q96);
  
  let adjustedPrice;
  if (isTokenAFirst) {
    adjustedPrice = price;
  } else {
    adjustedPrice = (BigInt(10 ** 36)) / price;
  }

  const decimalAdjustment = BigInt(10 ** (TOKEN_B_DECIMALS - TOKEN_A_DECIMALS));
  const finalPrice = (adjustedPrice * decimalAdjustment).toString();
  return Number(ethers.formatUnits(finalPrice, 18));
};

/** Calculate TOKEN_B per TOKEN_A price from V2 reserves */
const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = Number(reserves.reserve0.toString());
  const reserve1 = Number(reserves.reserve1.toString());
  const price = isTokenAFirst ? reserve1 / reserve0 : reserve0 / reserve1;
  return price * Math.pow(10, TOKEN_A_DECIMALS - TOKEN_B_DECIMALS);
};

/** Log arbitrage event */
const logArbitrageEvent = (eventType, priceDiff, maxPrice, minPrice, duration = null, highestDiff = null) => {
  const timestamp = new Date().toISOString();
  let logMessage = `🕒 ${timestamp} | ${eventType}\n`;
  logMessage += `📊 Max Price: ${maxPrice.toFixed(18)}\n`;
  logMessage += `📊 Min Price: ${minPrice.toFixed(18)}\n`;
  logMessage += `📊 Price Difference: ${priceDiff.toFixed(18)}\n`;
  if (duration !== null) {
    logMessage += `⏱️ Duration: ${duration} ms\n`;
  }
  if (highestDiff !== null) {
    logMessage += `📈 Highest Price Difference in Opportunity: ${highestDiff.toFixed(18)}\n`;
  }
  logMessage += `📈 All-Time Highest Price Difference: ${allTimeHighestPriceDiff.toFixed(18)}\n`;
  logMessage += "--------------------------------------------------\n";
  console.log(logMessage);
  fs.appendFileSync("arbitrage_opportunities.log", logMessage);
};

/** Check for arbitrage opportunities */
const checkArbitrage = async (context) => {
  console.log(`🔍 Checking arbitrage for context: ${context}`);
  const enabledPrices = [];

  if (useUniswap && cachedUniswapPrice) enabledPrices.push(cachedUniswapPrice);
  if (useSushiSwap && cachedSushiSwapPrice) enabledPrices.push(cachedSushiSwapPrice);
  if (useArbswap && cachedArbswapPrice) enabledPrices.push(cachedArbswapPrice);
  if (useSwaprum && cachedSwaprumPrice) enabledPrices.push(cachedSwaprumPrice);
  if (useCurve && cachedCurvePrice) enabledPrices.push(cachedCurvePrice);
  if (useArbidex && cachedArbidexPrice) enabledPrices.push(cachedArbidexPrice);
  if (useCamelotV3 && cachedCamelotV3Price) enabledPrices.push(cachedCamelotV3Price);
  if (usePancakeSwapV3 && cachedPancakeSwapV3Price) enabledPrices.push(cachedPancakeSwapV3Price);

  if (enabledPrices.length < 2) {
    console.log("⚠️ Not enough pools enabled for arbitrage check.");
    return;
  }

  const maxPrice = Math.max(...enabledPrices);
  const minPrice = Math.min(...enabledPrices);
  const priceDiff = maxPrice - minPrice;

  let pricesLog = "";
  if (useUniswap) pricesLog += `Uniswap: ${cachedUniswapPrice.toFixed(18)} `;
  if (useSushiSwap) pricesLog += `SushiSwap: ${cachedSushiSwapPrice.toFixed(18)} `;
  if (useArbswap) pricesLog += `Arbswap: ${cachedArbswapPrice.toFixed(18)} `;
  if (useSwaprum) pricesLog += `Swaprum: ${cachedSwaprumPrice.toFixed(18)} `;
  if (useCurve) pricesLog += `Curve: ${cachedCurvePrice.toFixed(18)} `;
  if (useArbidex) pricesLog += `Arbidex: ${cachedArbidexPrice.toFixed(18)} `;
  if (useCamelotV3) pricesLog += `CamelotV3: ${cachedCamelotV3Price.toFixed(18)} `;
  if (usePancakeSwapV3) pricesLog += `PancakeSwapV3: ${cachedPancakeSwapV3Price.toFixed(18)} `;
  console.log(`📊 Current prices: ${pricesLog.trim()} | Price difference: ${priceDiff.toFixed(18)} (Max: ${maxPrice.toFixed(18)}, Min: ${minPrice.toFixed(18)})`);

  if (priceDiff > allTimeHighestPriceDiff) {
    allTimeHighestPriceDiff = priceDiff;
    console.log(`📈 New all-time highest price difference: ${allTimeHighestPriceDiff.toFixed(18)}`);
  }

  if (priceDiff > ARBITRAGE_THRESHOLD) {
    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      opportunityHighestPriceDiff = priceDiff;
      console.log(`💡 Arbitrage opportunity detected at ${arbOpportunityStartTime}`);
      logArbitrageEvent("Opportunity Detected", priceDiff, maxPrice, minPrice);
    } else {
      opportunityHighestPriceDiff = Math.max(opportunityHighestPriceDiff, priceDiff);
    }
  } else {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now();
      const duration = vanishTime - arbOpportunityStartTime;
      console.log(`⏱️ Arbitrage opportunity vanished after ${duration} ms`);
      logArbitrageEvent("Opportunity Vanished", priceDiff, maxPrice, minPrice, duration, opportunityHighestPriceDiff);
      arbOpportunityStartTime = null;
      opportunityHighestPriceDiff = 0;
    }
  }
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

  // Fetch token decimals
  try {
    const tokenAContract = new ethers.Contract(TOKEN_A_ADDRESS, ERC20_ABI, wsProvider);
    TOKEN_A_DECIMALS = await tokenAContract.decimals();
    const tokenBContract = new ethers.Contract(TOKEN_B_ADDRESS, ERC20_ABI, wsProvider);
    TOKEN_B_DECIMALS = await tokenBContract.decimals();
    console.log(`ℹ️ TOKEN_A (ZRO) decimals: ${TOKEN_A_DECIMALS}`);
    console.log(`ℹ️ TOKEN_B (WETH) decimals: ${TOKEN_B_DECIMALS}`);
  } catch (error) {
    console.error(`⚠️ Failed to fetch token decimals: ${error.message}`);
    TOKEN_A_DECIMALS = 18; // Default for ZRO
    TOKEN_B_DECIMALS = 18; // Default for WETH
  }

  console.log("📦 Initializing contracts...");
  if (useUniswap) uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
  if (useSushiSwap) sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useArbswap) arbswapPool = new ethers.Contract(ARBSWAP_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useSwaprum) swaprumPool = new ethers.Contract(SWAPRUM_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useCurve) curvePool = new ethers.Contract(CURVE_POOL_ADDRESS, CURVE_POOL_ABI, wsProvider);
  if (useArbidex) arbidexPool = new ethers.Contract(ARBIDEX_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useCamelotV3) camelotV3Pool = new ethers.Contract(CAMELOT_V3_POOL_ADDRESS, CAMELOT_V3_POOL_ABI, wsProvider);
  if (usePancakeSwapV3) pancakeswapV3Pool = new ethers.Contract(PANCAKESWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);

  try {
    if (useUniswap) {
      const [uniToken0, uniToken1] = await Promise.all([uniswapV3Pool.token0(), uniswapV3Pool.token1()]);
      console.log(`ℹ️ Uniswap token0: ${uniToken0}, token1: ${uniToken1}`);
      uniswapIsTokenAFirst = uniToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ Uniswap isTokenAFirst: ${uniswapIsTokenAFirst}`);
      const uniFee = await uniswapV3Pool.fee();
      const uniFeePercent = (Number(uniFee) / 10000).toFixed(2) + '%';
      console.log(`💸 Uniswap V3 fee: ${uniFeePercent}`);
    }
    if (useSushiSwap) {
      const [sushiToken0, sushiToken1] = await Promise.all([sushiswapV2Pool.token0(), sushiswapV2Pool.token1()]);
      console.log(`ℹ️ SushiSwap token0: ${sushiToken0}, token1: ${sushiToken1}`);
      sushiswapIsTokenAFirst = sushiToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ SushiSwap isTokenAFirst: ${sushiswapIsTokenAFirst}`);
      console.log(`💸 SushiSwap V2 fee: 0.30%`);
    }
    if (useArbswap) {
      const [arbswapToken0, arbswapToken1] = await Promise.all([arbswapPool.token0(), arbswapPool.token1()]);
      console.log(`ℹ️ Arbswap token0: ${arbswapToken0}, token1: ${arbswapToken1}`);
      arbswapIsTokenAFirst = arbswapToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ Arbswap isTokenAFirst: ${arbswapIsTokenAFirst}`);
      console.log(`💸 Arbswap fee: 0.30%`);
    }
    if (useSwaprum) {
      const [swaprumToken0, swaprumToken1] = await Promise.all([swaprumPool.token0(), swaprumPool.token1()]);
      console.log(`ℹ️ Swaprum token0: ${swaprumToken0}, token1: ${swaprumToken1}`);
      swaprumIsTokenAFirst = swaprumToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ Swaprum isTokenAFirst: ${swaprumIsTokenAFirst}`);
      console.log(`💸 Swaprum fee: 0.30%`);
    }
    if (useCurve) {
      const tokens = await Promise.all([
        curvePool.coins(0),
        curvePool.coins(1),
        curvePool.coins(2).catch(() => null)
      ]);
      console.log(`ℹ️ Curve pool tokens: ${tokens.filter(t => t).join(", ")}`);
      ZRO_INDEX = tokens.findIndex(t => t && t.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase());
      WETH_INDEX = tokens.findIndex(t => t && t.toLowerCase() === TOKEN_B_ADDRESS.toLowerCase());
      if (ZRO_INDEX === -1 || WETH_INDEX === -1) {
        console.error(`⚠️ ZRO or WETH not found in Curve pool`);
        return;
      }
      console.log(`ℹ️ Curve ZRO_INDEX: ${ZRO_INDEX}, WETH_INDEX: ${WETH_INDEX}`);
      try {
        const curveFee = await curvePool.fee();
        curveFeePercent = (Number(curveFee) / 1e10 * 100).toFixed(2) + '%';
        console.log(`💸 Curve fee: ${curveFeePercent}`);
      } catch (e) {
        console.log(`⚠️ Curve fee fetch failed, using default: ${curveFeePercent}`);
      }
    }
    if (useArbidex) {
      const [arbidexToken0, arbidexToken1] = await Promise.all([arbidexPool.token0(), arbidexPool.token1()]);
      console.log(`ℹ️ Arbidex token0: ${arbidexToken0}, token1: ${arbidexToken1}`);
      arbidexIsTokenAFirst = arbidexToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ Arbidex isTokenAFirst: ${arbidexIsTokenAFirst}`);
      console.log(`💸 Arbidex fee: 0.30%`);
    }
    if (useCamelotV3) {
      const [camelotToken0, camelotToken1] = await Promise.all([camelotV3Pool.token0(), camelotV3Pool.token1()]);
      console.log(`ℹ️ Camelot V3 token0: ${camelotToken0}, token1: ${camelotToken1}`);
      camelotIsTokenAFirst = camelotToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ Camelot V3 isTokenAFirst: ${camelotIsTokenAFirst}`);
      const camelotFee = await camelotV3Pool.fee();
      const camelotFeePercent = (Number(camelotFee) / 10000).toFixed(2) + '%';
      console.log(`💸 Camelot V3 fee: ${camelotFeePercent}`);
    }
    if (usePancakeSwapV3) {
      const [pancakeToken0, pancakeToken1] = await Promise.all([pancakeswapV3Pool.token0(), pancakeswapV3Pool.token1()]);
      console.log(`ℹ️ PancakeSwap V3 token0: ${pancakeToken0}, token1: ${pancakeToken1}`);
      pancakeswapIsTokenAFirst = pancakeToken0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      console.log(`ℹ️ PancakeSwap V3 isTokenAFirst: ${pancakeswapIsTokenAFirst}`);
      const pancakeFee = await pancakeswapV3Pool.fee();
      const pancakeFeePercent = (Number(pancakeFee) / 10000).toFixed(2) + '%';
      console.log(`💸 PancakeSwap V3 fee: ${pancakeFeePercent}`);
    }
  } catch (error) {
    console.error(`⚠️ Failed to fetch pool token details or fees: ${error.message}`);
    return;
  }

  try {
    await updatePrices();
    console.log(`📊 Initial prices fetched: Uniswap=${cachedUniswapPrice}, SushiSwap=${cachedSushiSwapPrice}, Arbswap=${cachedArbswapPrice}, Swaprum=${cachedSwaprumPrice}, Curve=${cachedCurvePrice}, Arbidex=${cachedArbidexPrice}, CamelotV3=${cachedCamelotV3Price}, PancakeSwapV3=${cachedPancakeSwapV3Price}`);
  } catch (error) {
    console.error(`⚠️ Initial price fetch failed: ${error.message}`);
    return;
  }

  await checkArbitrage("Initial");

  if (useUniswap) {
    uniswapV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Uniswap V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Uniswap V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useSushiSwap) {
    sushiswapV2Pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on SushiSwap V2 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on SushiSwap V2 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useArbswap) {
    arbswapPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Arbswap at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Arbswap at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useSwaprum) {
    swaprumPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Swaprum at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Swaprum at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useCurve) {
    curvePool.on("TokenExchange", async (buyer, sold_id, tokens_sold, bought_id, tokens_bought, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Curve at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Curve at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useArbidex) {
    arbidexPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Arbidex at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Arbidex at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useCamelotV3) {
    camelotV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap event detected on Camelot V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        await checkArbitrage(`Swap on Camelot V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }
};

// ========== INITIALIZATION ==========
(async () => {
  try {
    console.log("🛠️ Initializing...");
    await connectWebSocket();

    // Periodic price updates to ensure prices are current
    const PERIODIC_CHECK_INTERVAL = 60000; // 1 minute
    setInterval(async () => {
      try {
        await updatePrices();
        await checkArbitrage("Periodic Check");
      } catch (error) {
        console.error(`⚠️ Periodic price update failed: ${error.message}`);
      }
    }, PERIODIC_CHECK_INTERVAL);
  } catch (error) {
    console.error(`⚠️ Initialization failed: ${error.message}`);
  }
})().catch(console.error);