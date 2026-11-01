const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ========== CONFIGURATION ==========

const TOKEN_A_ADDRESS = "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"; // WAVAX
const TOKEN_B_ADDRESS = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"; // USDC

// DEX pool addresses
const LFJV22_POOL_ADDRESS = "0xf4003f4efbe8691b60249e6afbd307abe7758adb"; // Trader Joe V2 WAVAX-USDC pool
const PHARAOH_EXCHANGE_POOL_ADDRESS = "0xa20c959b19f114e9c2d81547734cdc1110bd773d"; // Pharaoh Exchange pool
const PHARAOH_EXCHANGE_V1_POOL_ADDRESS = "0x..."; // Pharaoh Exchange V1 pool address (placeholder)
const UNISWAP_V3_POOL_ADDRESS = "0xfae3f424a0a47706811521e3ee268f00cfb5c45e"; // Uniswap V3 pool on Avalanche
const LFJV21_POOL_ADDRESS = "0x..."; // LFJV2.1 pool address (placeholder)
const LFJ_POOL_ADDRESS = "0x..."; // LFJ (Trader Joe) pool address (placeholder)
const ARENA_DEX_POOL_ADDRESS = "0x..."; // Arena DEX pool address (placeholder)

let useLFJV22 = true;
let usePharaohExchange = true;
let usePharaohExchangeV1 = false;
let useUniswapV3 = true;
let useLFJV21 = false;
let useLFJ = false;
let useArenaDEX = false;

// Contract addresses
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x76d8a81e59a5E3503C2F34629932557B68797b4a"; // Flashloan contract on Avalanche
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0xF096872672F44d6EBA71458D74fe67F9a77a23B9"; // USDC/USD on Avalanche

// Pool types for price fetching
const poolTypes = {
    [LFJV22_POOL_ADDRESS]: 'V2',
    [PHARAOH_EXCHANGE_POOL_ADDRESS]: 'V3',
    [UNISWAP_V3_POOL_ADDRESS]: 'V3',
    [PHARAOH_EXCHANGE_V1_POOL_ADDRESS]: 'V2',
    [LFJV21_POOL_ADDRESS]: 'V2',
    [LFJ_POOL_ADDRESS]: 'V2',
    [ARENA_DEX_POOL_ADDRESS]: 'V2'
};

// Other configurations
const BORROW_VALUE_USD = 50;
const ARBITRAGE_THRESHOLD = 8;
const ARBITRAGE_THRESHOLD_PERCENT = 0.39; // 0.39% threshold
const ARB_BY_PERCENT = true; // Use percentage threshold if true
const MIN_PRICE_DIFF_THRESHOLD = 0.0;
const MIN_ARBITRAGE_THRESHOLD_PERCENT = 0.39; // 0.39% minimum threshold
const MAX_ARBITRAGE_TRANSACTIONS = 1;
const STOP_LOSS_USD = 2.5;
const GAS_FEE_MULTIPLIER = 1;
const AUTO_THRESHOLD = false;
const GAS_TOLERANCE = 0.3; // in gwei, maximum gas fee tolerance

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute
const LOSING_STREAK_THRESHOLD = 1;
const PAUSE_PERIOD = 60000; // 1 minute
const MAX_TOTAL_LOSSES = 3;

const OPTIMISE_SWAP_TOKEN = true; // Set to true to use optimized borrow amount for V2 pools

// ========== ABI DEFINITIONS ==========

// Uniswap V3 ABI
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

// V2 Pool ABI
const V2_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

// Flashloan Arbitrage ABI
const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address poolBuy, address poolSell, address token, uint256 amount, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 feeBuy, uint24 feeSell) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

// Chainlink ABI
const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function decimals() view returns (uint8)"
];

// ========== GLOBAL STATE ==========
let wsProvider, httpProvider, txProvider, signer, cachedFeeData;
let lfjV22Pool, pharaohExchangePool, pharaohExchangeV1Pool, uniswapV3Pool, lfjV21Pool, lfjPool, arenaDEXPool, flashLoanArbitrage, chainlinkTokenBUsd;
let lfjV22IsTokenAFirst, pharaohExchangeIsTokenAFirst, pharaohExchangeV1IsTokenAFirst, uniswapIsTokenAFirst, lfjV21IsTokenAFirst, lfjIsTokenAFirst, arenaDEXIsTokenAFirst;
let cachedLFJV22Price = 0, cachedPharaohExchangePrice = 0, cachedPharaohExchangeV1Price = 0, cachedUniswapV3Price = 0, cachedLFJV21Price = 0, cachedLFJPrice = 0, cachedArenaDEXPrice = 0;
let cachedTokenBUsdPrice = 0;
let cachedLFJV22Fee, cachedPharaohExchangeFee, cachedPharaohExchangeV1Fee, cachedUniswapV3Fee, cachedLFJV21Fee, cachedLFJFee, cachedArenaDEXFee;
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
const poolIsTokenAFirst = {};

// ========== HELPER FUNCTIONS ==========

// Helper functions for setting up event listeners
const setupV2SwapListener = (pool, dexName) => {
    pool.on("Swap", async (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
        if (shouldStop) return;
        const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
        console.log(`🔔 Swap on ${dexName} at block ${blockNumber}`);
        try {
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on ${dexName} at block ${blockNumber}`);
        } catch (error) {
            console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
        }
    });
};

const setupV3SwapListener = (pool, dexName) => {
    pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
        if (shouldStop) return;
        const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
        console.log(`🔔 Swap on ${dexName} at block ${blockNumber}`);
        try {
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on ${dexName} at block ${blockNumber}`);
        } catch (error) {
            console.error(`⚠️ Error updating prices for block ${blockNumber}: ${error.message}`);
        }
    });
};

/** Function to calculate optimal borrow amount for Token A */
function getMaxProfitBorrowAmountA(A_sell, B_sell, A_buy, B_buy, fee = 0.003) {
    const f = (x) => {
        if (x <= 0 || x >= A_sell * 0.5) return -Infinity;

        const xEff = x * (1 - fee);
        const y = (B_sell * xEff) / (A_sell + xEff);
        const yEff = y * (1 - fee);
        const z = (A_buy * yEff) / (B_buy + yEff);

        return z - x; // profit in A
    };

    const tol = 1e-6;
    const gr = (Math.sqrt(5) + 1) / 2;
    let a = 0.001, b = A_sell * 0.5;
    let c = b - (b - a) / gr;
    let d = a + (b - a) / gr;

    while (Math.abs(b - a) > tol) {
        if (f(c) > f(d)) {
            b = d;
        } else {
            a = c;
        }
        c = b - (b - a) / gr;
        d = a + (b - a) / gr;
    }

    const optimalX = (b + a) / 2;
    const maxProfit = f(optimalX);
    return {
        optimalAIn: parseFloat(optimalX.toFixed(6)),
        maxProfitA: parseFloat(maxProfit.toFixed(6))
    };
}

/** Fetch token decimals as Numbers */
const fetchTokenDecimals = async () => {
    const tokenAContract = new ethers.Contract(TOKEN_A_ADDRESS, ERC20_ABI, wsProvider);
    const tokenBContract = new ethers.Contract(TOKEN_B_ADDRESS, ERC20_ABI, wsProvider);
    tokenADecimals = Number(await tokenAContract.decimals());
    tokenBDecimals = Number(await tokenBContract.decimals());
    console.log(`TOKEN_A (WAVAX) decimals: ${tokenADecimals}, TOKEN_B (USDC) decimals: ${tokenBDecimals}`);
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

    if (useLFJV22) {
        try {
            if (poolTypes[LFJV22_POOL_ADDRESS] === 'V2') {
                const reserves = await lfjV22Pool.getReserves({ blockTag });
                prices.lfjV22 = calculateV2Price(reserves, lfjV22IsTokenAFirst);
            } else if (poolTypes[LFJV22_POOL_ADDRESS] === 'V3') {
                const slot0 = await lfjV22Pool.slot0({ blockTag });
                prices.lfjV22 = calculateV3Price(slot0.sqrtPriceX96, lfjV22IsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ LFJV2.2 price fetch failed: ${e.message}`);
        }
    }

    if (usePharaohExchange) {
        try {
            if (poolTypes[PHARAOH_EXCHANGE_POOL_ADDRESS] === 'V3') {
                const slot0 = await pharaohExchangePool.slot0({ blockTag });
                prices.pharaohExchange = calculateV3Price(slot0.sqrtPriceX96, pharaohExchangeIsTokenAFirst);
            } else if (poolTypes[PHARAOH_EXCHANGE_POOL_ADDRESS] === 'V2') {
                const reserves = await pharaohExchangePool.getReserves({ blockTag });
                prices.pharaohExchange = calculateV2Price(reserves, pharaohExchangeIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Pharaoh Exchange price fetch failed: ${e.message}`);
        }
    }

    if (usePharaohExchangeV1) {
        try {
            if (poolTypes[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] === 'V2') {
                const reserves = await pharaohExchangeV1Pool.getReserves({ blockTag });
                prices.pharaohExchangeV1 = calculateV2Price(reserves, pharaohExchangeV1IsTokenAFirst);
            } else if (poolTypes[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] === 'V3') {
                const slot0 = await pharaohExchangeV1Pool.slot0({ blockTag });
                prices.pharaohExchangeV1 = calculateV3Price(slot0.sqrtPriceX96, pharaohExchangeV1IsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Pharaoh Exchange V1 price fetch failed: ${e.message}`);
        }
    }

    if (useUniswapV3) {
        try {
            if (poolTypes[UNISWAP_V3_POOL_ADDRESS] === 'V3') {
                const slot0 = await uniswapV3Pool.slot0({ blockTag });
                prices.uniswapV3 = calculateV3Price(slot0.sqrtPriceX96, uniswapIsTokenAFirst);
            } else if (poolTypes[UNISWAP_V3_POOL_ADDRESS] === 'V2') {
                const reserves = await uniswapV3Pool.getReserves({ blockTag });
                prices.uniswapV3 = calculateV2Price(reserves, uniswapIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Uniswap V3 price fetch failed: ${e.message}`);
        }
    }

    if (useLFJV21) {
        try {
            if (poolTypes[LFJV21_POOL_ADDRESS] === 'V2') {
                const reserves = await lfjV21Pool.getReserves({ blockTag });
                prices.lfjV21 = calculateV2Price(reserves, lfjV21IsTokenAFirst);
            } else if (poolTypes[LFJV21_POOL_ADDRESS] === 'V3') {
                const slot0 = await lfjV21Pool.slot0({ blockTag });
                prices.lfjV21 = calculateV3Price(slot0.sqrtPriceX96, lfjV21IsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ LFJV2.1 price fetch failed: ${e.message}`);
        }
    }

    if (useLFJ) {
        try {
            if (poolTypes[LFJ_POOL_ADDRESS] === 'V2') {
                const reserves = await lfjPool.getReserves({ blockTag });
                prices.lfj = calculateV2Price(reserves, lfjIsTokenAFirst);
            } else if (poolTypes[LFJ_POOL_ADDRESS] === 'V3') {
                const slot0 = await lfjPool.slot0({ blockTag });
                prices.lfj = calculateV3Price(slot0.sqrtPriceX96, lfjIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ LFJ price fetch failed: ${e.message}`);
        }
    }

    if (useArenaDEX) {
        try {
            if (poolTypes[ARENA_DEX_POOL_ADDRESS] === 'V2') {
                const reserves = await arenaDEXPool.getReserves({ blockTag });
                prices.arenaDEX = calculateV2Price(reserves, arenaDEXIsTokenAFirst);
            } else if (poolTypes[ARENA_DEX_POOL_ADDRESS] === 'V3') {
                const slot0 = await arenaDEXPool.slot0({ blockTag });
                prices.arenaDEX = calculateV3Price(slot0.sqrtPriceX96, arenaDEXIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Arena DEX price fetch failed: ${e.message}`);
        }
    }

    if (useLFJV22 && prices.lfjV22) cachedLFJV22Price = prices.lfjV22;
    if (usePharaohExchange && prices.pharaohExchange) cachedPharaohExchangePrice = prices.pharaohExchange;
    if (usePharaohExchangeV1 && prices.pharaohExchangeV1) cachedPharaohExchangeV1Price = prices.pharaohExchangeV1;
    if (useUniswapV3 && prices.uniswapV3) cachedUniswapV3Price = prices.uniswapV3;
    if (useLFJV21 && prices.lfjV21) cachedLFJV21Price = prices.lfjV21;
    if (useLFJ && prices.lfj) cachedLFJPrice = prices.lfj;
    if (useArenaDEX && prices.arenaDEX) cachedArenaDEXPrice = prices.arenaDEX;

    console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
    return prices;
};

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
    console.log("🌐 Connecting to Avalanche WebSocket...");
    wsProvider = new ethers.WebSocketProvider(process.env.AVALANCHE_WS_RPC_URL);

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

    if (useLFJV22) {
        try {
            lfjV22Pool = new ethers.Contract(LFJV22_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
            lfjV22IsTokenAFirst = (await lfjV22Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedLFJV22Fee = 3000; // Assuming 0.3% fee, adjust if different
            poolIsTokenAFirst[LFJV22_POOL_ADDRESS] = lfjV22IsTokenAFirst;
            console.log(`💲 LFJV2.2 Pool Fee: ${cachedLFJV22Fee} (${(cachedLFJV22Fee / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize LFJV2.2: ${e.message}`);
            useLFJV22 = false;
        }
    }

    if (usePharaohExchange) {
        try {
            pharaohExchangePool = new ethers.Contract(PHARAOH_EXCHANGE_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
            pharaohExchangeIsTokenAFirst = (await pharaohExchangePool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedPharaohExchangeFee = await pharaohExchangePool.fee();
            poolIsTokenAFirst[PHARAOH_EXCHANGE_POOL_ADDRESS] = pharaohExchangeIsTokenAFirst;
            console.log(`💲 Pharaoh Exchange Pool Fee: ${cachedPharaohExchangeFee} (${(Number(cachedPharaohExchangeFee) / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Pharaoh Exchange: ${e.message}`);
            usePharaohExchange = false;
        }
    }

    if (usePharaohExchangeV1) {
        try {
            pharaohExchangeV1Pool = new ethers.Contract(PHARAOH_EXCHANGE_V1_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
            pharaohExchangeV1IsTokenAFirst = (await pharaohExchangeV1Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedPharaohExchangeV1Fee = 3000; // Assuming 0.3% fee, adjust if different
            poolIsTokenAFirst[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] = pharaohExchangeV1IsTokenAFirst;
            console.log(`💲 Pharaoh Exchange V1 Pool Fee: ${cachedPharaohExchangeV1Fee} (${(cachedPharaohExchangeV1Fee / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Pharaoh Exchange V1: ${e.message}`);
            usePharaohExchangeV1 = false;
        }
    }

    if (useUniswapV3) {
        try {
            uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
            uniswapIsTokenAFirst = (await uniswapV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedUniswapV3Fee = await uniswapV3Pool.fee();
            poolIsTokenAFirst[UNISWAP_V3_POOL_ADDRESS] = uniswapIsTokenAFirst;
            console.log(`💲 Uniswap V3 Pool Fee: ${cachedUniswapV3Fee} (${(Number(cachedUniswapV3Fee) / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Uniswap V3: ${e.message}`);
            useUniswapV3 = false;
        }
    }

    if (useLFJV21) {
        try {
            lfjV21Pool = new ethers.Contract(LFJV21_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
            lfjV21IsTokenAFirst = (await lfjV21Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedLFJV21Fee = 3000; // Assuming 0.3% fee, adjust if different
            poolIsTokenAFirst[LFJV21_POOL_ADDRESS] = lfjV21IsTokenAFirst;
            console.log(`💲 LFJV2.1 Pool Fee: ${cachedLFJV21Fee} (${(cachedLFJV21Fee / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize LFJV2.1: ${e.message}`);
            useLFJV21 = false;
        }
    }

    if (useLFJ) {
        try {
            lfjPool = new ethers.Contract(LFJ_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
            lfjIsTokenAFirst = (await lfjPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedLFJFee = 3000; // Assuming 0.3% fee, adjust if different
            poolIsTokenAFirst[LFJ_POOL_ADDRESS] = lfjIsTokenAFirst;
            console.log(`💲 LFJ Pool Fee: ${cachedLFJFee} (${(cachedLFJFee / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize LFJ: ${e.message}`);
            useLFJ = false;
        }
    }

    if (useArenaDEX) {
        try {
            arenaDEXPool = new ethers.Contract(ARENA_DEX_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
            arenaDEXIsTokenAFirst = (await arenaDEXPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedArenaDEXFee = 3000; // Assuming 0.3% fee, adjust if different
            poolIsTokenAFirst[ARENA_DEX_POOL_ADDRESS] = arenaDEXIsTokenAFirst;
            console.log(`💲 Arena DEX Pool Fee: ${cachedArenaDEXFee} (${(cachedArenaDEXFee / 1e6) * 100}%)`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Arena DEX: ${e.message}`);
            useArenaDEX = false;
        }
    }

    flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
    chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);

    await fetchTokenDecimals();
    await updateTokenBUsdPrice();

    try {
        await updatePrices();
        console.log(`📊 Initial prices: LFJV2.2=${cachedLFJV22Price}, PharaohExchange=${cachedPharaohExchangePrice}, PharaohExchangeV1=${cachedPharaohExchangeV1Price}, UniswapV3=${cachedUniswapV3Price}, LFJV2.1=${cachedLFJV21Price}, LFJ=${cachedLFJPrice}, ArenaDEX=${cachedArenaDEXPrice}`);
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

    // Set up event listeners based on pool type
    if (useLFJV22 && poolTypes[LFJV22_POOL_ADDRESS] === 'V2') {
        setupV2SwapListener(lfjV22Pool, "LFJV2.2");
    }
    if (usePharaohExchange && poolTypes[PHARAOH_EXCHANGE_POOL_ADDRESS] === 'V3') {
        setupV3SwapListener(pharaohExchangePool, "Pharaoh Exchange");
    }
    if (usePharaohExchangeV1 && poolTypes[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] === 'V2') {
        setupV2SwapListener(pharaohExchangeV1Pool, "Pharaoh Exchange V1");
    }
    if (useUniswapV3 && poolTypes[UNISWAP_V3_POOL_ADDRESS] === 'V3') {
        setupV3SwapListener(uniswapV3Pool, "Uniswap V3");
    }
    if (useLFJV21 && poolTypes[LFJV21_POOL_ADDRESS] === 'V2') {
        setupV2SwapListener(lfjV21Pool, "LFJV2.1");
    }
    if (useLFJ && poolTypes[LFJ_POOL_ADDRESS] === 'V2') {
        setupV2SwapListener(lfjPool, "LFJ");
    }
    if (useArenaDEX && poolTypes[ARENA_DEX_POOL_ADDRESS] === 'V2') {
        setupV2SwapListener(arenaDEXPool, "Arena DEX");
    }

    setInterval(updateFeeData, 20000); // Update gas fees every 20 seconds
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
            if (useLFJV22) {
                if (poolTypes[LFJV22_POOL_ADDRESS] === 'V2') {
                    const reserves = await lfjV22Pool.getReserves();
                    prices.lfjV22 = calculateV2Price(reserves, lfjV22IsTokenAFirst);
                } else {
                    const slot0 = await lfjV22Pool.slot0();
                    prices.lfjV22 = calculateV3Price(slot0.sqrtPriceX96, lfjV22IsTokenAFirst);
                }
            }
            if (usePharaohExchange) {
                if (poolTypes[PHARAOH_EXCHANGE_POOL_ADDRESS] === 'V3') {
                    const slot0 = await pharaohExchangePool.slot0();
                    prices.pharaohExchange = calculateV3Price(slot0.sqrtPriceX96, pharaohExchangeIsTokenAFirst);
                } else {
                    const reserves = await pharaohExchangePool.getReserves();
                    prices.pharaohExchange = calculateV2Price(reserves, pharaohExchangeIsTokenAFirst);
                }
            }
            if (usePharaohExchangeV1) {
                if (poolTypes[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] === 'V2') {
                    const reserves = await pharaohExchangeV1Pool.getReserves();
                    prices.pharaohExchangeV1 = calculateV2Price(reserves, pharaohExchangeV1IsTokenAFirst);
                } else {
                    const slot0 = await pharaohExchangeV1Pool.slot0();
                    prices.pharaohExchangeV1 = calculateV3Price(slot0.sqrtPriceX96, pharaohExchangeV1IsTokenAFirst);
                }
            }
            if (useUniswapV3) {
                if (poolTypes[UNISWAP_V3_POOL_ADDRESS] === 'V3') {
                    const slot0 = await uniswapV3Pool.slot0();
                    prices.uniswapV3 = calculateV3Price(slot0.sqrtPriceX96, uniswapIsTokenAFirst);
                } else {
                    const reserves = await uniswapV3Pool.getReserves();
                    prices.uniswapV3 = calculateV2Price(reserves, uniswapIsTokenAFirst);
                }
            }
            if (useLFJV21) {
                if (poolTypes[LFJV21_POOL_ADDRESS] === 'V2') {
                    const reserves = await lfjV21Pool.getReserves();
                    prices.lfjV21 = calculateV2Price(reserves, lfjV21IsTokenAFirst);
                } else {
                    const slot0 = await lfjV21Pool.slot0();
                    prices.lfjV21 = calculateV3Price(slot0.sqrtPriceX96, lfjV21IsTokenAFirst);
                }
            }
            if (useLFJ) {
                if (poolTypes[LFJ_POOL_ADDRESS] === 'V2') {
                    const reserves = await lfjPool.getReserves();
                    prices.lfj = calculateV2Price(reserves, lfjIsTokenAFirst);
                } else {
                    const slot0 = await lfjPool.slot0();
                    prices.lfj = calculateV3Price(slot0.sqrtPriceX96, lfjIsTokenAFirst);
                }
            }
            if (useArenaDEX) {
                if (poolTypes[ARENA_DEX_POOL_ADDRESS] === 'V2') {
                    const reserves = await arenaDEXPool.getReserves();
                    prices.arenaDEX = calculateV2Price(reserves, arenaDEXIsTokenAFirst);
                } else {
                    const slot0 = await arenaDEXPool.slot0();
                    prices.arenaDEX = calculateV3Price(slot0.sqrtPriceX96, arenaDEXIsTokenAFirst);
                }
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
            `Insufficient funds: have ${ethers.formatUnits(balance, "ether")} AVAX, need ${ethers.formatUnits(requiredFunds, "ether")} AVAX`
        );
    }
    console.log(`✅ Balance sufficient: ${ethers.formatUnits(balance, "ether")} AVAX available`);
};

/** Prepare presigned transactions for all enabled DEX pairs with cached gas fees */
const preparePresignedTransactions = async () => {
    console.log("✍️ Preparing presigned transactions...");
    if (!cachedUniswapV3Price || !cachedTokenBUsdPrice) {
        console.log("⚠️ Skipping presigning: Price data incomplete");
        return;
    }

    if (!cachedFeeData) {
        console.log("⚠️ Skipping presigning: Fee data not available");
        await updateFeeData();
        if (!cachedFeeData) return;
    }

    const enabledDEXes = [];
    if (useLFJV22) enabledDEXes.push({ name: 'LFJV22', pool: LFJV22_POOL_ADDRESS, type: poolTypes[LFJV22_POOL_ADDRESS], fee: cachedLFJV22Fee });
    if (usePharaohExchange) enabledDEXes.push({ name: 'PharaohExchange', pool: PHARAOH_EXCHANGE_POOL_ADDRESS, type: poolTypes[PHARAOH_EXCHANGE_POOL_ADDRESS], fee: cachedPharaohExchangeFee });
    if (usePharaohExchangeV1) enabledDEXes.push({ name: 'PharaohExchangeV1', pool: PHARAOH_EXCHANGE_V1_POOL_ADDRESS, type: poolTypes[PHARAOH_EXCHANGE_V1_POOL_ADDRESS], fee: cachedPharaohExchangeV1Fee });
    if (useUniswapV3) enabledDEXes.push({ name: 'UniswapV3', pool: UNISWAP_V3_POOL_ADDRESS, type: poolTypes[UNISWAP_V3_POOL_ADDRESS], fee: cachedUniswapV3Fee });
    if (useLFJV21) enabledDEXes.push({ name: 'LFJV21', pool: LFJV21_POOL_ADDRESS, type: poolTypes[LFJV21_POOL_ADDRESS], fee: cachedLFJV21Fee });
    if (useLFJ) enabledDEXes.push({ name: 'LFJ', pool: LFJ_POOL_ADDRESS, type: poolTypes[LFJ_POOL_ADDRESS], fee: cachedLFJFee });
    if (useArenaDEX) enabledDEXes.push({ name: 'ArenaDEX', pool: ARENA_DEX_POOL_ADDRESS, type: poolTypes[ARENA_DEX_POOL_ADDRESS], fee: cachedArenaDEXFee });

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

    const poolContracts = {};
    if (useLFJV22) poolContracts[LFJV22_POOL_ADDRESS] = lfjV22Pool;
    if (usePharaohExchange) poolContracts[PHARAOH_EXCHANGE_POOL_ADDRESS] = pharaohExchangePool;
    if (usePharaohExchangeV1) poolContracts[PHARAOH_EXCHANGE_V1_POOL_ADDRESS] = pharaohExchangeV1Pool;
    if (useLFJV21) poolContracts[LFJV21_POOL_ADDRESS] = lfjV21Pool;
    if (useLFJ) poolContracts[LFJ_POOL_ADDRESS] = lfjPool;
    if (useArenaDEX) poolContracts[ARENA_DEX_POOL_ADDRESS] = arenaDEXPool;

    const isV2Pool = (poolAddress) => {
        return Object.keys(poolContracts).includes(poolAddress) && poolTypes[poolAddress] === 'V2';
    };

    Object.keys(presignedTxCache).forEach(key => delete presignedTxCache[key]);

    const nonceToUse = currentNonce;
    const { maxFeePerGas, maxPriorityFeePerGas } = cachedFeeData;
    const multiplier = BigInt(Math.round(GAS_FEE_MULTIPLIER * 100));
    const adjustedMaxFeePerGas = (maxFeePerGas * multiplier) / BigInt(100);
    const adjustedMaxPriorityFeePerGas = (maxPriorityFeePerGas * multiplier) / BigInt(100);
    const gasLimit = BigInt(1000000);

    console.log("⚠️ Ensure your wallet has sufficient AVAX for gas fees.");
    try {
        await checkBalance(adjustedMaxFeePerGas, gasLimit);
    } catch (error) {
        console.error(`⚠️ ${error.message}`);
        console.log("⚠️ Skipping presigning due to insufficient funds.");
        return;
    }

    for (const pair of pairs) {
        try {
            let borrowAmount;
            if (OPTIMISE_SWAP_TOKEN && isV2Pool(pair.poolBuy) && isV2Pool(pair.poolSell)) {
                try {
                    const reservesSell = await poolContracts[pair.poolSell].getReserves();
                    const reservesBuy = await poolContracts[pair.poolBuy].getReserves();
                    let A_sell, B_sell, A_buy, B_buy;
                    const isTokenAFirstSell = poolIsTokenAFirst[pair.poolSell];
                    const isTokenAFirstBuy = poolIsTokenAFirst[pair.poolBuy];
                    if (isTokenAFirstSell) {
                        A_sell = Number(reservesSell.reserve0);
                        B_sell = Number(reservesSell.reserve1);
                    } else {
                        A_sell = Number(reservesSell.reserve1);
                        B_sell = Number(reservesSell.reserve0);
                    }
                    if (isTokenAFirstBuy) {
                        A_buy = Number(reservesBuy.reserve0);
                        B_buy = Number(reservesBuy.reserve1);
                    } else {
                        A_buy = Number(reservesBuy.reserve1);
                        B_buy = Number(reservesBuy.reserve0);
                    }
                    const fee = 0.003; // 0.3% fee for V2 pools
                    const result = getMaxProfitBorrowAmountA(A_sell, B_sell, A_buy, B_buy, fee);
                    borrowAmount = ethers.parseUnits(result.optimalAIn.toString(), tokenADecimals);
                    console.log(`Calculated optimal borrow amount for ${pair.poolBuy}-${pair.poolSell}: ${result.optimalAIn} TOKEN_A`);
                } catch (error) {
                    console.error(`Failed to calculate optimal borrow amount for ${pair.poolBuy}-${pair.poolSell}: ${error.message}`);
                    borrowAmount = calculateLoanAmount(cachedUniswapV3Price);
                }
            } else {
                borrowAmount = calculateLoanAmount(cachedUniswapV3Price);
            }

            const deadline = Math.floor(Date.now() / 1000) + 360;
            const txData = flashLoanArbitrage.interface.encodeFunctionData(
                "executeArbitrage",
                [pair.poolBuy, pair.poolSell, TOKEN_A_ADDRESS, borrowAmount, 0, 0, deadline, pair.feeBuy, pair.feeSell]
            );

            const tx = {
                to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
                data: txData,
                chainId: BigInt(43114), // Avalanche chain ID
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
    if (useLFJV22 && cachedLFJV22Price) prices.push({ dex: 'LFJV22', price: cachedLFJV22Price, pool: LFJV22_POOL_ADDRESS, fee: cachedLFJV22Fee });
    if (usePharaohExchange && cachedPharaohExchangePrice) prices.push({ dex: 'PharaohExchange', price: cachedPharaohExchangePrice, pool: PHARAOH_EXCHANGE_POOL_ADDRESS, fee: cachedPharaohExchangeFee });
    if (usePharaohExchangeV1 && cachedPharaohExchangeV1Price) prices.push({ dex: 'PharaohExchangeV1', price: cachedPharaohExchangeV1Price, pool: PHARAOH_EXCHANGE_V1_POOL_ADDRESS, fee: cachedPharaohExchangeV1Fee });
    if (useUniswapV3 && cachedUniswapV3Price) prices.push({ dex: 'UniswapV3', price: cachedUniswapV3Price, pool: UNISWAP_V3_POOL_ADDRESS, fee: cachedUniswapV3Fee });
    if (useLFJV21 && cachedLFJV21Price) prices.push({ dex: 'LFJV21', price: cachedLFJV21Price, pool: LFJV21_POOL_ADDRESS, fee: cachedLFJV21Fee });
    if (useLFJ && cachedLFJPrice) prices.push({ dex: 'LFJ', price: cachedLFJPrice, pool: LFJ_POOL_ADDRESS, fee: cachedLFJFee });
    if (useArenaDEX && cachedArenaDEXPrice) prices.push({ dex: 'ArenaDEX', price: cachedArenaDEXPrice, pool: ARENA_DEX_POOL_ADDRESS, fee: cachedArenaDEXFee });

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

    const gasToleranceWei = ethers.parseUnits(GAS_TOLERANCE.toString(), "gwei");
    if (cachedFeeData.maxFeePerGas > gasToleranceWei) {
        console.log(`💡 Arbitrage opportunity detected but gas fee too high: ${ethers.formatUnits(cachedFeeData.maxFeePerGas, "gwei")} gwei > ${GAS_TOLERANCE} gwei`);
        return;
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
    executePresignedArbitrage(poolBuy, poolSell, detectionTime, priceDiff);
};

/** Log transaction details with detailed timing breakdown */
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
    const profitUSD = (profitInTokenA * cachedUniswapV3Price) * cachedTokenBUsdPrice;
    const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
    const swapFeeBuyUSD = swapFeeBuy * cachedTokenBUsdPrice;
    const swapFeeSellUSD = swapFeeSell * cachedTokenBUsdPrice;
    const netPnLUSD = netPnL * cachedTokenBUsdPrice;
    const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;
    const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, tokenADecimals));
    const loanAmountUSD = (loanAmountInTokenA * cachedUniswapV3Price) * cachedTokenBUsdPrice;

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
- Send to confirm:
  - Time to get transaction hash: ${timingDetails.timeToGetHash} ms
  - Time from hash to confirmation: ${timingDetails.timeFromHashToConfirm} ms
  - Total send to confirm: ${timingDetails.timeSendToConfirm} ms
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
        const txHash = await txProvider.send("eth_sendRawTransaction", [presigned.signedTx]);
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
        const timeToGetHash = hashReceivedTime - sendStartTime;
        const timeFromHashToConfirm = confirmTime - hashReceivedTime;
        const timeSendToConfirm = confirmTime - sendStartTime;
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
            const profitInTokenB = profitInTokenA * cachedUniswapV3Price;
            const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
            cumulativePnLInTokenB += netPnLInTokenB;

            const isSuccess = receipt.status === 1;
            updateStreaks(isSuccess, priceDiff);

            await updatePrices();
            const prices = [];
            if (useLFJV22 && cachedLFJV22Price) prices.push({ dex: 'LFJV22', price: cachedLFJV22Price });
            if (usePharaohExchange && cachedPharaohExchangePrice) prices.push({ dex: 'PharaohExchange', price: cachedPharaohExchangePrice });
            if (usePharaohExchangeV1 && cachedPharaohExchangeV1Price) prices.push({ dex: 'PharaohExchangeV1', price: cachedPharaohExchangeV1Price });
            if (useUniswapV3 && cachedUniswapV3Price) prices.push({ dex: 'UniswapV3', price: cachedUniswapV3Price });
            if (useLFJV21 && cachedLFJV21Price) prices.push({ dex: 'LFJV21', price: cachedLFJV21Price });
            if (useLFJ && cachedLFJPrice) prices.push({ dex: 'LFJ', price: cachedLFJPrice });
            if (useArenaDEX && cachedArenaDEXPrice) prices.push({ dex: 'ArenaDEX', price: cachedArenaDEXPrice });

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
                const totalFees = calculateDynamicThreshold(cachedUniswapV3Fee, cachedLFJV22Fee);
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
                {
                    timeToRetrieveOrGenerate,
                    timeToSend,
                    timeToGetHash,
                    timeFromHashToConfirm,
                    timeSendToConfirm,
                    totalTime
                },
                opportunityStatus
            );
            checkStopCondition();
        }
    } catch (error) {
        console.error(`⚠️ Execution failed #${arbitrageCount}: ${error.message}`);
        const retrieveOrGenerateTime = Date.now();
        const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
        const timeToSend = 0;
        const timeToGetHash = 0;
        const timeFromHashToConfirm = 0;
        const timeSendToConfirm = 0;
        const totalTime = Date.now() - detectionTime;

        updateStreaks(false, priceDiff);

        if (error.message.includes("nonce too low")) {
            console.log("⚠️ Nonce too low detected, refreshing nonce...");
            currentNonce = await getCurrentNonce();
            await preparePresignedTransactions();
        }

        await updatePrices();
        const prices = [];
        if (useLFJV22 && cachedLFJV22Price) prices.push({ dex: 'LFJV22', price: cachedLFJV22Price });
        if (usePharaohExchange && cachedPharaohExchangePrice) prices.push({ dex: 'PharaohExchange', price: cachedPharaohExchangePrice });
        if (usePharaohExchangeV1 && cachedPharaohExchangeV1Price) prices.push({ dex: 'PharaohExchangeV1', price: cachedPharaohExchangeV1Price });
        if (useUniswapV3 && cachedUniswapV3Price) prices.push({ dex: 'UniswapV3', price: cachedUniswapV3Price });
        if (useLFJV21 && cachedLFJV21Price) prices.push({ dex: 'LFJV21', price: cachedLFJV21Price });
        if (useLFJ && cachedLFJPrice) prices.push({ dex: 'LFJ', price: cachedLFJPrice });
        if (useArenaDEX && cachedArenaDEXPrice) prices.push({ dex: 'ArenaDEX', price: cachedArenaDEXPrice });

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
            const totalFees = calculateDynamicThreshold(cachedUniswapV3Fee, cachedLFJV22Fee);
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
            {
                timeToRetrieveOrGenerate,
                timeToSend,
                timeToGetHash,
                timeFromHashToConfirm,
                timeSendToConfirm,
                totalTime
            },
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
        httpProvider = new ethers.JsonRpcProvider(process.env.AVALANCHE_HTTP_RPC_URL);
        txProvider = httpProvider; // Avalanche doesn't use a sequencer, use the same provider
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