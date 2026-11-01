const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ========== CONFIGURATION ==========
const TOKEN_A_ADDRESS = "0xbaadcc2962417c01af99fb2b7c75706b9bd6babe"; // BERA on Bera
const TOKEN_B_ADDRESS = "0x6969696969696969696969696969696969696969"; // WETH on Bera

const KODIAK_V3_POOL_ADDRESS = "0xf6feb2c0ce85be768b380c96297bb49d42fe5670"; // Kodiak V3 BERA/WETH
const KODIAK_V2_POOL_ADDRESS = "0x..."; // Kodiak V2 BERA/WETH
const BEX_POOL_ADDRESS = "0x705fc16ba5a1eb67051934f2fb17eacae660f6c7"; // BEX BERA/WETH
const BULLA_POOL_ADDRESS = "0x..."; // Bulla BERA/WETH
const BURRBEAR_POOL_ADDRESS = "0x..."; // Burrbear BERA/WETH
const HOLDSTATION_POOL_ADDRESS = "0x..."; // Holdstation BERA/WETH
const DYOR_SWAP_POOL_ADDRESS = "0x..."; // Dyor Swap BERA/WETH

const useKodiakV3 = true;
const useKodiakV2 = false;
const useBex = true;
const useBulla = false;
const useBurrbear = false;
const useHoldstation = false;
const useDyorSwap = false;

const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x830d692C06295601aAdEeD71CA98ACc55433D480"; // Deployed contract address on Bera

const BORROW_VALUE_USD = 1; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 0.00000106; // Manual threshold
const MIN_PRICE_DIFF_THRESHOLD = 0.0006; // Minimum price difference required to execute trade
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x..."; // Chainlink WETH/USD on Bera
const BALANCER_VAULT_ADDRESS = "0x830d692C06295601aAdEeD71CA98ACc55433D480"; // Balancer V2 Vault on Bera
const GAS_FEE_MULTIPLIER = 1.2; // Gas fee multiplier to ensure transaction inclusion
const AUTO_THRESHOLD = true; // Toggle for automatic threshold calculation

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute in milliseconds
const LOSING_STREAK_THRESHOLD = 2; // Pause trading after 2 consecutive losses
const PAUSE_PERIOD = 300000; // 5 minutes in milliseconds
const MAX_TOTAL_LOSSES = 3; // Stop bot after 3 total losses

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
let kodiakV3Pool, kodiakV2Pool, bexPool, bullaPool, burrbearPool, holdstationPool, dyorSwapPool, flashLoanArbitrage, chainlinkTokenBUsd;
let kodiakV3IsTokenAFirst, kodiakV2IsTokenAFirst, bexIsTokenAFirst, bullaIsTokenAFirst, burrbearIsTokenAFirst, holdstationIsTokenAFirst, dyorSwapIsTokenAFirst;
let cachedKodiakV3Price = 0, cachedKodiakV2Price = 0, cachedBexPrice = 0, cachedBullaPrice = 0, cachedBurrbearPrice = 0, cachedHoldstationPrice = 0, cachedDyorSwapPrice = 0;
let cachedTokenBUsdPrice = 0;
let cachedKodiakV3Fee, cachedKodiakV2Fee, cachedBexFee, cachedBullaFee, cachedBurrbearFee, cachedHoldstationFee, cachedDyorSwapFee, cachedFlashloanPremium;
let highestPriceDiff = 0;
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
const PRESIGN_INTERVAL = 300000; // 5 minutes in milliseconds
let LOSING_STREAK = 0;
let WINNING_STREAK = 0;
let lastLosingPriceDiff = 0;
let lastLosingTime = 0;
let totalWins = 0;
let totalLosses = 0;
let pauseUntil = 0;

// ========== CORE FUNCTIONS ==========

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

/** Update prices from pool states */
const updatePrices = async (blockTag = "latest") => {
  console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
  try {
    const prices = {};

    if (useKodiakV3) {
      try {
        const slot0KodiakV3 = await kodiakV3Pool.slot0({ blockTag });
        prices.kodiakV3 = calculateV3Price(slot0KodiakV3.sqrtPriceX96, kodiakV3IsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Kodiak V3 slot0 call failed: ${e.message}`);
      }
    }

    if (useKodiakV2) {
      try {
        const reservesKodiakV2 = await kodiakV2Pool.getReserves({ blockTag });
        prices.kodiakV2 = calculateV2Price(reservesKodiakV2, kodiakV2IsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Kodiak V2 getReserves call failed: ${e.message}`);
      }
    }

    if (useBex) {
      try {
        const reservesBex = await bexPool.getReserves({ blockTag });
        prices.bex = calculateV2Price(reservesBex, bexIsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ BEX getReserves call failed: ${e.message}`);
      }
    }

    if (useBulla) {
      try {
        const reservesBulla = await bullaPool.getReserves({ blockTag });
        prices.bulla = calculateV2Price(reservesBulla, bullaIsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Bulla getReserves call failed: ${e.message}`);
      }
    }

    if (useBurrbear) {
      try {
        const reservesBurrbear = await burrbearPool.getReserves({ blockTag });
        prices.burrbear = calculateV2Price(reservesBurrbear, burrbearIsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Burrbear getReserves call failed: ${e.message}`);
      }
    }

    if (useHoldstation) {
      try {
        const reservesHoldstation = await holdstationPool.getReserves({ blockTag });
        prices.holdstation = calculateV2Price(reservesHoldstation, holdstationIsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Holdstation getReserves call failed: ${e.message}`);
      }
    }

    if (useDyorSwap) {
      try {
        const reservesDyorSwap = await dyorSwapPool.getReserves({ blockTag });
        prices.dyorSwap = calculateV2Price(reservesDyorSwap, dyorSwapIsTokenAFirst);
      } catch (e) {
        console.error(`⚠️ Dyor Swap getReserves call failed: ${e.message}`);
      }
    }

    if (useKodiakV3 && prices.kodiakV3) cachedKodiakV3Price = prices.kodiakV3;
    if (useKodiakV2 && prices.kodiakV2) cachedKodiakV2Price = prices.kodiakV2;
    if (useBex && prices.bex) cachedBexPrice = prices.bex;
    if (useBulla && prices.bulla) cachedBullaPrice = prices.bulla;
    if (useBurrbear && prices.burrbear) cachedBurrbearPrice = prices.burrbear;
    if (useHoldstation && prices.holdstation) cachedHoldstationPrice = prices.holdstation;
    if (useDyorSwap && prices.dyorSwap) cachedDyorSwapPrice = prices.dyorSwap;

    console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
    return prices;
  } catch (error) {
    console.error(`⚠️ Failed to update prices for blockTag ${blockTag}: ${error.message}`);
    throw error;
  }
};

/** Calculate price (tokenB/tokenA) from sqrtPriceX96 (Kodiak V3) */
const calculateV3Price = (sqrtPriceX96, isTokenAFirst) => {
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2; // token1/token0
  return isTokenAFirst ? priceRatio : (1 / priceRatio); // tokenB/tokenA
};

/** Calculate price (tokenB/tokenA) from V2 reserves */
const calculateV2Price = (reserves, isTokenAFirst) => {
  const reserve0 = Number(reserves.reserve0.toString());
  const reserve1 = Number(reserves.reserve1.toString());
  return isTokenAFirst ? reserve1 / reserve0 : reserve0 / reserve1; // tokenB/tokenA
};

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
  console.log("🌐 Connecting to WebSocket...");
  wsProvider = new ethers.WebSocketProvider(process.env.BERA_WS_RPC_URL, { chainId: 80094, name: 'bera' });

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
  if (useKodiakV3) kodiakV3Pool = new ethers.Contract(KODIAK_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
  if (useKodiakV2) kodiakV2Pool = new ethers.Contract(KODIAK_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useBex) bexPool = new ethers.Contract(BEX_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useBulla) bullaPool = new ethers.Contract(BULLA_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useBurrbear) burrbearPool = new ethers.Contract(BURRBEAR_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useHoldstation) holdstationPool = new ethers.Contract(HOLDSTATION_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  if (useDyorSwap) dyorSwapPool = new ethers.Contract(DYOR_SWAP_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const balancerVault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, wsProvider);

  try {
    const promises = [];
    if (useKodiakV3) {
      promises.push(kodiakV3Pool.token0().then(token0 => {
        kodiakV3IsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      promises.push(kodiakV3Pool.fee().then(fee => cachedKodiakV3Fee = fee));
    }
    if (useKodiakV2) {
      promises.push(kodiakV2Pool.token0().then(token0 => {
        kodiakV2IsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedKodiakV2Fee = 3000; // 0.3% for V2
    }
    if (useBex) {
      promises.push(bexPool.token0().then(token0 => {
        bexIsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedBexFee = 3000; // 0.3% for V2
    }
    if (useBulla) {
      promises.push(bullaPool.token0().then(token0 => {
        bullaIsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedBullaFee = 3000; // 0.3% for V2
    }
    if (useBurrbear) {
      promises.push(burrbearPool.token0().then(token0 => {
        burrbearIsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedBurrbearFee = 3000; // 0.3% for V2
    }
    if (useHoldstation) {
      promises.push(holdstationPool.token0().then(token0 => {
        holdstationIsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedHoldstationFee = 3000; // 0.3% for V2
    }
    if (useDyorSwap) {
      promises.push(dyorSwapPool.token0().then(token0 => {
        dyorSwapIsTokenAFirst = token0.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
      }));
      cachedDyorSwapFee = 3000; // 0.3% for V2
    }
    promises.push(balancerVault.getProtocolFeesCollector().then(addr => {
      const protocolFeesCollector = new ethers.Contract(addr, PROTOCOL_FEES_COLLECTOR_ABI, wsProvider);
      return protocolFeesCollector.getFlashLoanFeePercentage().then(fee => cachedFlashloanPremium = fee);
    }));
    await Promise.all(promises);

    if (useKodiakV3) console.log(`💲 Kodiak V3 Pool Fee: ${cachedKodiakV3Fee} (${(Number(cachedKodiakV3Fee) / 1e6) * 100}%)`);
    if (useKodiakV2) console.log(`💲 Kodiak V2 Pool Fee: ${cachedKodiakV2Fee} (${(cachedKodiakV2Fee / 1e6) * 100}%)`);
    if (useBex) console.log(`💲 BEX Pool Fee: ${cachedBexFee} (${(cachedBexFee / 1e6) * 100}%)`);
    if (useBulla) console.log(`💲 Bulla Pool Fee: ${cachedBullaFee} (${(cachedBullaFee / 1e6) * 100}%)`);
    if (useBurrbear) console.log(`💲 Burrbear Pool Fee: ${cachedBurrbearFee} (${(cachedBurrbearFee / 1e6) * 100}%)`);
    if (useHoldstation) console.log(`💲 Holdstation Pool Fee: ${cachedHoldstationFee} (${(cachedHoldstationFee / 1e6) * 100}%)`);
    if (useDyorSwap) console.log(`💲 Dyor Swap Pool Fee: ${cachedDyorSwapFee} (${(cachedDyorSwapFee / 1e6) * 100}%)`);
    console.log(`💲 Balancer Flashloan Fee: ${cachedFlashloanPremium} (${Number(cachedFlashloanPremium) / 1e18}%)`);
  } catch (error) {
    console.error(`⚠️ Failed to fetch fees or token details: ${error.message}`);
    return;
  }

  await updateTokenBUsdPrice();

  try {
    await updatePrices();
    console.log(`📊 Initial prices: KodiakV3=${cachedKodiakV3Price}, KodiakV2=${cachedKodiakV2Price}, BEX=${cachedBexPrice}, Bulla=${cachedBullaPrice}, Burrbear=${cachedBurrbearPrice}, Holdstation=${cachedHoldstationPrice}, DyorSwap=${cachedDyorSwapPrice}`);
  } catch (error) {
    console.error(`⚠️ Initial price fetch failed: ${error.message}`);
    return;
  }

  try {
    await preparePresignedTransactions();
    lastPresignTime = Date.now();
    console.log("✅ Initial presigned transactions prepared");
  } catch (error) {
    console.error(`⚠️ Initial presigning failed: ${error.message}`);
    return;
  }

  await updateFeeData();
  checkArbitrage("Initial");

  if (useKodiakV3) {
    kodiakV3Pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Kodiak V3 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Kodiak V3 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useKodiakV2) {
    kodiakV2Pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Kodiak V2 at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Kodiak V2 at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useBex) {
    bexPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on BEX at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on BEX at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useBulla) {
    bullaPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Bulla at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Bulla at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useBurrbear) {
    burrbearPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Burrbear at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Burrbear at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useHoldstation) {
    holdstationPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Holdstation at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Holdstation at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  if (useDyorSwap) {
    dyorSwapPool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      if (shouldStop) return;
      const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
      console.log(`🔔 Swap on Dyor Swap at block ${blockNumber}`);
      try {
        await updatePrices(blockNumber);
        checkArbitrage(`Swap on Dyor Swap at block ${blockNumber}`);
      } catch (error) {
        console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
      }
    });
  }

  setInterval(updateFeeData, 10000); // Update gas fees every 10 seconds
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
    console.log("Fee Data:", feeData);
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
      if (useKodiakV3) {
        const slot0KodiakV3 = await kodiakV3Pool.slot0();
        prices.kodiakV3 = calculateV3Price(slot0KodiakV3.sqrtPriceX96, kodiakV3IsTokenAFirst);
      }
      if (useKodiakV2) {
        const reservesKodiakV2 = await kodiakV2Pool.getReserves();
        prices.kodiakV2 = calculateV2Price(reservesKodiakV2, kodiakV2IsTokenAFirst);
      }
      if (useBex) {
        const reservesBex = await bexPool.getReserves();
        prices.bex = calculateV2Price(reservesBex, bexIsTokenAFirst);
      }
      if (useBulla) {
        const reservesBulla = await bullaPool.getReserves();
        prices.bulla = calculateV2Price(reservesBulla, bullaIsTokenAFirst);
      }
      if (useBurrbear) {
        const reservesBurrbear = await burrbearPool.getReserves();
        prices.burrbear = calculateV2Price(reservesBurrbear, burrbearIsTokenAFirst);
      }
      if (useHoldstation) {
        const reservesHoldstation = await holdstationPool.getReserves();
        prices.holdstation = calculateV2Price(reservesHoldstation, holdstationIsTokenAFirst);
      }
      if (useDyorSwap) {
        const reservesDyorSwap = await dyorSwapPool.getReserves();
        prices.dyorSwap = calculateV2Price(reservesDyorSwap, dyorSwapIsTokenAFirst);
      }

      const timestamp = Date.now();
      const logMessage = `⭕ Double check (${context}): ${Object.entries(prices).map(([dex, price]) => `${dex}=${price.toFixed(18)}`).join(", ")} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), logMessage);
      return prices;
    } catch (err) {
      console.error(`⚠️ Fetch prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`);
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
  if (!cachedKodiakV3Price || !cachedKodiakV2Price || !cachedTokenBUsdPrice) {
    console.log("⚠️ Skipping presigning: Price data incomplete");
    return;
  }

  if (!cachedFeeData) {
    console.log("⚠️ Skipping presigning: Fee data not available");
    await updateFeeData();
    if (!cachedFeeData) return;
  }

  const enabledDEXes = [];
  if (useKodiakV3) enabledDEXes.push({ name: 'KodiakV3', pool: KODIAK_V3_POOL_ADDRESS, type: 'V3', fee: cachedKodiakV3Fee });
  if (useKodiakV2) enabledDEXes.push({ name: 'KodiakV2', pool: KODIAK_V2_POOL_ADDRESS, type: 'V2', fee: cachedKodiakV2Fee });
  if (useBex) enabledDEXes.push({ name: 'BEX', pool: BEX_POOL_ADDRESS, type: 'V2', fee: cachedBexFee });
  if (useBulla) enabledDEXes.push({ name: 'Bulla', pool: BULLA_POOL_ADDRESS, type: 'V2', fee: cachedBullaFee });
  if (useBurrbear) enabledDEXes.push({ name: 'Burrbear', pool: BURRBEAR_POOL_ADDRESS, type: 'V2', fee: cachedBurrbearFee });
  if (useHoldstation) enabledDEXes.push({ name: 'Holdstation', pool: HOLDSTATION_POOL_ADDRESS, type: 'V2', fee: cachedHoldstationFee });
  if (useDyorSwap) enabledDEXes.push({ name: 'DyorSwap', pool: DYOR_SWAP_POOL_ADDRESS, type: 'V2', fee: cachedDyorSwapFee });

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

  const loanAmount = calculateLoanAmount(cachedKodiakV3Price); // Use Kodiak V3 as reference price

  // Clear the cache
  Object.keys(presignedTxCache).forEach(key => delete presignedTxCache[key]);

  // Use the same nonce for all presigned transactions
  const nonceToUse = currentNonce;

  // Use cached fee data
  const { maxFeePerGas, maxPriorityFeePerGas } = cachedFeeData;
  const multiplier = BigInt(Math.round(GAS_FEE_MULTIPLIER * 100));
  const adjustedMaxFeePerGas = (maxFeePerGas * multiplier) / 100n;
  const adjustedMaxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / 100n;
  const gasLimit = BigInt(1000000);

  // Check balance before proceeding
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
        chainId: BigInt(80094), // Bera chain ID
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
  const swapFeeBuyPercent = Number(poolBuyFee) / 1e6 * 100; // Convert to percentage
  const swapFeeSellPercent = Number(poolSellFee) / 1e6 * 100;
  const flashloanFeePercent = Number(cachedFlashloanPremium) / 1e18 * 100;
  const totalFeesPercent = swapFeeBuyPercent + swapFeeSellPercent + flashloanFeePercent;
  return totalFeesPercent / 100; // Convert back to decimal
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
  if (useKodiakV3 && cachedKodiakV3Price) prices.push({ dex: 'KodiakV3', price: cachedKodiakV3Price, pool: KODIAK_V3_POOL_ADDRESS, fee: cachedKodiakV3Fee });
  if (useKodiakV2 && cachedKodiakV2Price) prices.push({ dex: 'KodiakV2', price: cachedKodiakV2Price, pool: KODIAK_V2_POOL_ADDRESS, fee: cachedKodiakV2Fee });
  if (useBex && cachedBexPrice) prices.push({ dex: 'BEX', price: cachedBexPrice, pool: BEX_POOL_ADDRESS, fee: cachedBexFee });
  if (useBulla && cachedBullaPrice) prices.push({ dex: 'Bulla', price: cachedBullaPrice, pool: BULLA_POOL_ADDRESS, fee: cachedBullaFee });
  if (useBurrbear && cachedBurrbearPrice) prices.push({ dex: 'Burrbear', price: cachedBurrbearPrice, pool: BURRBEAR_POOL_ADDRESS, fee: cachedBurrbearFee });
  if (useHoldstation && cachedHoldstationPrice) prices.push({ dex: 'Holdstation', price: cachedHoldstationPrice, pool: HOLDSTATION_POOL_ADDRESS, fee: cachedHoldstationFee });
  if (useDyorSwap && cachedDyorSwapPrice) prices.push({ dex: 'DyorSwap', price: cachedDyorSwapPrice, pool: DYOR_SWAP_POOL_ADDRESS, fee: cachedDyorSwapFee });

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
      }
    }
  }
  console.log(`📊 Price diff on ${context}: Max diff=${maxDiff.toFixed(18)}, Percent=${maxDiffPercent.toFixed(4)}%, Pair=${maxDiffPair}, Highest diff ever=${highestPriceDiff.toFixed(18)}`);
  console.log(`Winstreak: ${WINNING_STREAK} | Losestreak: ${LOSING_STREAK} | Total Wins: ${totalWins} | Total Losses: ${totalLosses}`);

  let maxPriceDex, minPriceDex;
  if (AUTO_THRESHOLD) {
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
        fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
        arbOpportunityStartTime = null;
        opportunityVanishedTime = null;
      }
      return;
    }
  } else {
    maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    const priceDiff = maxPriceDex.price - minPriceDex.price;
    if (priceDiff <= ARBITRAGE_THRESHOLD) {
      console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} <= ${ARBITRAGE_THRESHOLD}`);
      if (arbOpportunityStartTime !== null) {
        opportunityVanishedTime = Date.now();
        const duration = opportunityVanishedTime - arbOpportunityStartTime;
        console.log(`⏱️ Arbitrage opportunity vanished after ${duration} ms`);
        fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
        arbOpportunityStartTime = null;
        opportunityVanishedTime = null;
      }
      return;
    }
  }

  const priceDiff = maxPriceDex.price - minPriceDex.price;
  if (priceDiff < MIN_PRICE_DIFF_THRESHOLD) {
    console.log(`ℹ️ Price difference (${priceDiff.toFixed(18)}) is below minimum threshold (${MIN_PRICE_DIFF_THRESHOLD}). Skipping trade.`);
    if (arbOpportunityStartTime !== null) {
      opportunityVanishedTime = Date.now();
      const duration = opportunityVanishedTime - arbOpportunityStartTime;
      console.log(`⏱️ Arbitrage opportunity vanished after ${duration} ms`);
      fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
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

  (async () => {
    await fetchAndLogPrices("opportunity_detected");
    setTimeout(async () => {
      await fetchAndLogPrices("2s_after_opportunity");
    }, 2000);
  })();

  if (arbOpportunityStartTime === null) {
    arbOpportunityStartTime = Date.now();
    console.log(`💡 Arbitrage opportunity detected at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}`);
    fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity detected at ${arbOpportunityStartTime} between ${maxPriceDex.dex} and ${minPriceDex.dex}\n`);
  }
  arbitrageCount++;
  console.log(`📈 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
  const poolBuy = maxPriceDex.pool;
  const poolSell = minPriceDex.pool;
  const detectionTime = arbOpportunityStartTime;
  executePresignedArbitrage(poolBuy, poolSell, detectionTime, priceDiff);
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
  const profitUSD = (profitInTokenA * cachedKodiakV3Price) * cachedTokenBUsdPrice;
  const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
  const swapFeeBuyUSD = swapFeeBuy * cachedTokenBUsdPrice;
  const swapFeeSellUSD = swapFeeSell * cachedTokenBUsdPrice;
  const netPnLUSD = netPnL * cachedTokenBUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;
  const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, 18));
  const loanAmountUSD = (loanAmountInTokenA * cachedKodiakV3Price) * cachedTokenBUsdPrice;

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
  fs.appendFileSync(path.join(__dirname, "scripts/p&l.txt"), logMessage);
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
              profitInTokenA = Number(ethers.formatUnits(parsedLog.args.profit, 18));
              success = parsedLog.args.success;
              console.log(`💰 Profit: ${profitInTokenA} TOKEN_A, Success: ${success}`);
              break;
            }
          } catch (e) {}
        }
      }

      const gasCostInTokenB = Number(ethers.formatUnits(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || cachedFeeData.gasPrice), 18));
      const profitInTokenB = profitInTokenA * cachedKodiakV3Price;
      const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
      cumulativePnLInTokenB += netPnLInTokenB;

      // Determine success based on transaction status
      const isSuccess = receipt.status === 1;
      updateStreaks(isSuccess, priceDiff);

      await updatePrices();
      const prices = [];
      if (useKodiakV3 && cachedKodiakV3Price) prices.push({ dex: 'KodiakV3', price: cachedKodiakV3Price });
      if (useKodiakV2 && cachedKodiakV2Price) prices.push({ dex: 'KodiakV2', price: cachedKodiakV2Price });
      if (useBex && cachedBexPrice) prices.push({ dex: 'BEX', price: cachedBexPrice });
      if (useBulla && cachedBullaPrice) prices.push({ dex: 'Bulla', price: cachedBullaPrice });
      if (useBurrbear && cachedBurrbearPrice) prices.push({ dex: 'Burrbear', price: cachedBurrbearPrice });
      if (useHoldstation && cachedHoldstationPrice) prices.push({ dex: 'Holdstation', price: cachedHoldstationPrice });
      if (useDyorSwap && cachedDyorSwapPrice) prices.push({ dex: 'DyorSwap', price: cachedDyorSwapPrice });

      let opportunityStatus = '';
      const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
      const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
      const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
      if (AUTO_THRESHOLD) {
        const totalFees = calculateDynamicThreshold(cachedKodiakV3Fee, cachedKodiakV2Fee);
        const profitPercent = (currentPriceDiff / minPriceDex.price * 100) - (totalFees * 100);
        if (profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
          opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
        } else {
          opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
          if (arbOpportunityStartTime !== null) {
            opportunityVanishedTime = confirmTime;
            const duration = opportunityVanishedTime - arbOpportunityStartTime;
            opportunityStatus += ` after ${duration} ms`;
            fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
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
            fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
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

    updateStreaks(false, priceDiff); // Count as loss if transaction fails

    if (error.message.includes("nonce too low")) {
      console.log("⚠️ Nonce too low detected, refreshing nonce...");
      currentNonce = await getCurrentNonce();
      await preparePresignedTransactions();
    }

    await updatePrices();
    const prices = [];
    if (useKodiakV3 && cachedKodiakV3Price) prices.push({ dex: 'KodiakV3', price: cachedKodiakV3Price });
    if (useKodiakV2 && cachedKodiakV2Price) prices.push({ dex: 'KodiakV2', price: cachedKodiakV2Price });
    if (useBex && cachedBexPrice) prices.push({ dex: 'BEX', price: cachedBexPrice });
    if (useBulla && cachedBullaPrice) prices.push({ dex: 'Bulla', price: cachedBullaPrice });
    if (useBurrbear && cachedBurrbearPrice) prices.push({ dex: 'Burrbear', price: cachedBurrbearPrice });
    if (useHoldstation && cachedHoldstationPrice) prices.push({ dex: 'Holdstation', price: cachedHoldstationPrice });
    if (useDyorSwap && cachedDyorSwapPrice) prices.push({ dex: 'DyorSwap', price: cachedDyorSwapPrice });

    let opportunityStatus = '';
    const maxPriceDex = prices.reduce((prev, curr) => (prev.price > curr.price) ? prev : curr);
    const minPriceDex = prices.reduce((prev, curr) => (prev.price < curr.price) ? prev : curr);
    const currentPriceDiff = maxPriceDex.price - minPriceDex.price;
    if (AUTO_THRESHOLD) {
      const totalFees = calculateDynamicThreshold(cachedKodiakV3Fee, cachedKodiakV2Fee);
      const profitPercent = (currentPriceDiff / minPriceDex.price * 100) - (totalFees * 100);
      if (profitPercent > 0 && currentPriceDiff >= MIN_PRICE_DIFF_THRESHOLD) {
        opportunityStatus = `Opportunity persists (Price diff: ${currentPriceDiff.toFixed(10)})`;
      } else {
        opportunityStatus = `Opportunity vanished (Price diff: ${currentPriceDiff.toFixed(10)})`;
        if (arbOpportunityStartTime !== null) {
          opportunityVanishedTime = Date.now();
          const duration = opportunityVanishedTime - arbOpportunityStartTime;
          opportunityStatus += ` after ${duration} ms`;
          fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
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
          fs.appendFileSync(path.join(__dirname, "scripts/time.txt"), `Opportunity vanished after ${duration} ms at ${opportunityVanishedTime}\n`);
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
    httpProvider = new ethers.JsonRpcProvider(process.env.BERA_HTTP_RPC_URL, { chainId: 80094, name: 'bera' });
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    console.log(`👤 Signer address: ${signer.address}`);

    currentNonce = await getCurrentNonce();
    flashLoanArbitrage = new ethers.Contract(
      FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      FLASHLOAN_ARBITRAGE_ABI,
      signer
    );
    console.log(`📜 Flashloan contract initialized at: ${FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS}`);

    // Initial gas fee fetch
    await updateFeeData();

    await connectWebSocket();
  } catch (error) {
    console.error(`⚠️ Initialization failed: ${error.message}`);
  }
})().catch(console.error);