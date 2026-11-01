const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Custom provider to disable ENS resolution for WebSocket
class NoEnsWebSocketProvider extends ethers.WebSocketProvider {
    async resolveName(name) {
        if (ethers.isAddress(name)) {
            return name; // Return the address if it's a valid hex address
        }
        throw new Error(`ENS not supported on this network: ${name}`);
    }
}

// Custom provider to disable ENS resolution for JSON-RPC
class NoEnsJsonRpcProvider extends ethers.JsonRpcProvider {
    async resolveName(name) {
        if (ethers.isAddress(name)) {
            return name; // Return the address if it's a valid hex address
        }
        throw new Error(`ENS not supported on this network: ${name}`);
    }
}

// ========== CONFIGURATION ==========

const TOKEN_A_ADDRESS = "0x160345fc359604fc6e70e3c5facbde5f7a9342d8"; // Sei V2 token A address
const TOKEN_B_ADDRESS = "0xe30fedd158a2e3b13e9badaeabafc5516e95e8c7"; // Sei V2 token B address

const DRAGONSWAP_V2_POOL_ADDRESS = "0xe0f20947365d2fcf5fabd14ad4415ab18191bd3a"; // DragonSwap V2 pool address
const SAILOR_POOL_ADDRESS = "0x28634b5703542037565b99ee8b6f0efbd864588d";        // Sailor pool address
const OKU_TRADE_POOL_ADDRESS = "0xa3a573c8d14c93fca8fdecb7db168619563d9b00";     // Oku Trade pool address
const JELLYVERSE_POOL_ADDRESS = "0x...";    // Jellyverse pool address (placeholder)
const YAKA_FINANCE_V3_POOL_ADDRESS = "0xe8d281401801ab38118f83bc5493c4bd60bab262"; // Yaka Finance V3 pool address
const DRAGONSWAP_V1_POOL_ADDRESS = "0x..."; // Dragon Swap V1 pool address (placeholder)

let useDragonSwapV2 = true;
let useSailor = true;
let useOkuTrade = true;
let useJellyverse = false;
let useYakaFinanceV3 = true;
let useDragonSwapV1 = false;

const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x76d8a81e59a5E3503C2F34629932557B68797b4b"; // Sei V2 flashloan contract address
const BORROW_VALUE_USD = 50;
const ARBITRAGE_THRESHOLD = 8;
const ARBITRAGE_THRESHOLD_PERCENT = 0.39; // 0.39% threshold
const ARB_BY_PERCENT = true; // Use percentage threshold if true
const MIN_PRICE_DIFF_THRESHOLD = 0.0;
const MIN_ARBITRAGE_THRESHOLD_PERCENT = 0.41; // 0.41% minimum threshold
const MAX_ARBITRAGE_TRANSACTIONS = 1;
const STOP_LOSS_USD = 2.5;
const CHAINLINK_TOKEN_B_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Sei V2 Chainlink price feed
const GAS_FEE_MULTIPLIER = 1;
const AUTO_THRESHOLD = false;
const GAS_TOLERANCE = 0.3; // in gwei, maximum gas fee tolerance

const LOSE_TOLERANCE = 3;
const COOLDOWN_PERIOD = 60000; // 1 minute
const LOSING_STREAK_THRESHOLD = 1;
const PAUSE_PERIOD = 60000; // 1 minute
const MAX_TOTAL_LOSSES = 3;

const OPTIMISE_SWAP_TOKEN = true; // Use optimized borrow amount for V2 pools

// ========== POOL TYPES ==========
const DRAGONSWAP_V2_POOL_TYPE = 'V3';
const SAILOR_POOL_TYPE = 'V3';
const OKU_TRADE_POOL_TYPE = 'V3';
const JELLYVERSE_POOL_TYPE = 'V2';
const YAKA_FINANCE_V3_POOL_TYPE = 'V3';
const DRAGONSWAP_V1_POOL_TYPE = 'V2';

const poolTypes = {
    [DRAGONSWAP_V2_POOL_ADDRESS]: DRAGONSWAP_V2_POOL_TYPE,
    [SAILOR_POOL_ADDRESS]: SAILOR_POOL_TYPE,
    [OKU_TRADE_POOL_ADDRESS]: OKU_TRADE_POOL_TYPE,
    [JELLYVERSE_POOL_ADDRESS]: JELLYVERSE_POOL_TYPE,
    [YAKA_FINANCE_V3_POOL_ADDRESS]: YAKA_FINANCE_V3_POOL_TYPE,
    [DRAGONSWAP_V1_POOL_ADDRESS]: DRAGONSWAP_V1_POOL_TYPE
};

// ========== ABI DEFINITIONS ==========

const V2_POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

const V3_POOL_ABI = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function fee() view returns (uint24)",
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const DRAGONSWAP_V1_ABI = [
    "function tokenAddress() view returns (address)",
    "function getTokenToSeiOutputPrice(uint256 seiSold) view returns (uint256)",
    "event TokenPurchase(address indexed buyer, uint256 seiSold, uint256 tokensBought)"
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
let wsProvider, httpProvider, txProvider, signer, cachedFeeData;
let dragonSwapV2Pool, sailorPool, okuTradePool, jellyversePool, yakaFinanceV3Pool, dragonSwapV1Pool, flashLoanArbitrage, chainlinkTokenBUsd;
let dragonSwapV2IsTokenAFirst, sailorIsTokenAFirst, okuTradeIsTokenAFirst, jellyverseIsTokenAFirst, yakaFinanceV3IsTokenAFirst, dragonSwapV1IsTokenAFirst;
let cachedDragonSwapV2Price = 0, cachedSailorPrice = 0, cachedOkuTradePrice = 0, cachedJellyversePrice = 0, cachedYakaFinanceV3Price = 0, cachedDragonSwapV1Price = 0;
let cachedTokenBUsdPrice = 0;
let cachedDragonSwapV2Fee, cachedSailorFee, cachedOkuTradeFee, cachedJellyverseFee, cachedYakaFinanceV3Fee, cachedDragonSwapV1Fee;
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
    const decimalsA = BigInt(10) ** BigInt(isTokenAFirst ? tokenADecimals : tokenBDecimals);
    const decimalsB = BigInt(10) ** BigInt(isTokenAFirst ? tokenBDecimals : tokenADecimals);
    const precision = BigInt(10) ** BigInt(18);
    const priceScaled = (reserve1 * precision * decimalsA) / (reserve0 * decimalsB);
    return Number(priceScaled) / 1e18;
};

/** Calculate price for Dragon Swap V1 (simplified, assuming token to SEI) */
const calculateDragonSwapV1Price = async (pool) => {
    const tokenAddr = await pool.tokenAddress();
    const seiSold = ethers.parseUnits("1", tokenBDecimals); // Assuming TOKEN_B is SEI-like
    const tokensBought = await pool.getTokenToSeiOutputPrice(seiSold);
    const price = Number(ethers.formatUnits(tokensBought, tokenADecimals));
    return tokenAddr.toLowerCase() === TOKEN_A_ADDRESS.toLowerCase() ? price : (1 / price);
};

/** Update prices from pool states */
const updatePrices = async (blockTag = "latest") => {
    console.log(`🔄 Updating prices for blockTag: ${blockTag}`);
    const prices = {};

    if (useDragonSwapV2) {
        try {
            if (poolTypes[DRAGONSWAP_V2_POOL_ADDRESS] === 'V3') {
                const slot0 = await dragonSwapV2Pool.slot0({ blockTag });
                prices.dragonSwapV2 = calculateV3Price(slot0.sqrtPriceX96, dragonSwapV2IsTokenAFirst);
            } else {
                const reserves = await dragonSwapV2Pool.getReserves({ blockTag });
                prices.dragonSwapV2 = calculateV2Price(reserves, dragonSwapV2IsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ DragonSwap V2 price fetch failed: ${e.message}`);
        }
    }

    if (useSailor) {
        try {
            if (poolTypes[SAILOR_POOL_ADDRESS] === 'V3') {
                const slot0 = await sailorPool.slot0({ blockTag });
                prices.sailor = calculateV3Price(slot0.sqrtPriceX96, sailorIsTokenAFirst);
            } else {
                const reserves = await sailorPool.getReserves({ blockTag });
                prices.sailor = calculateV2Price(reserves, sailorIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Sailor price fetch failed: ${e.message}`);
        }
    }

    if (useOkuTrade) {
        try {
            if (poolTypes[OKU_TRADE_POOL_ADDRESS] === 'V3') {
                const slot0 = await okuTradePool.slot0({ blockTag });
                prices.okuTrade = calculateV3Price(slot0.sqrtPriceX96, okuTradeIsTokenAFirst);
            } else {
                const reserves = await okuTradePool.getReserves({ blockTag });
                prices.okuTrade = calculateV2Price(reserves, okuTradeIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Oku Trade price fetch failed: ${e.message}`);
        }
    }

    if (useJellyverse) {
        try {
            if (poolTypes[JELLYVERSE_POOL_ADDRESS] === 'V3') {
                const slot0 = await jellyversePool.slot0({ blockTag });
                prices.jellyverse = calculateV3Price(slot0.sqrtPriceX96, jellyverseIsTokenAFirst);
            } else {
                const reserves = await jellyversePool.getReserves({ blockTag });
                prices.jellyverse = calculateV2Price(reserves, jellyverseIsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Jellyverse price fetch failed: ${e.message}`);
        }
    }

    if (useYakaFinanceV3) {
        try {
            if (poolTypes[YAKA_FINANCE_V3_POOL_ADDRESS] === 'V3') {
                const slot0 = await yakaFinanceV3Pool.slot0({ blockTag });
                prices.yakaFinanceV3 = calculateV3Price(slot0.sqrtPriceX96, yakaFinanceV3IsTokenAFirst);
            } else {
                const reserves = await yakaFinanceV3Pool.getReserves({ blockTag });
                prices.yakaFinanceV3 = calculateV2Price(reserves, yakaFinanceV3IsTokenAFirst);
            }
        } catch (e) {
            console.error(`⚠️ Yaka Finance V3 price fetch failed: ${e.message}`);
        }
    }

    if (useDragonSwapV1) {
        try {
            prices.dragonSwapV1 = await calculateDragonSwapV1Price(dragonSwapV1Pool);
        } catch (e) {
            console.error(`⚠️ Dragon Swap V1 price fetch failed: ${e.message}`);
        }
    }

    if (useDragonSwapV2 && prices.dragonSwapV2) cachedDragonSwapV2Price = prices.dragonSwapV2;
    if (useSailor && prices.sailor) cachedSailorPrice = prices.sailor;
    if (useOkuTrade && prices.okuTrade) cachedOkuTradePrice = prices.okuTrade;
    if (useJellyverse && prices.jellyverse) cachedJellyversePrice = prices.jellyverse;
    if (useYakaFinanceV3 && prices.yakaFinanceV3) cachedYakaFinanceV3Price = prices.yakaFinanceV3;
    if (useDragonSwapV1 && prices.dragonSwapV1) cachedDragonSwapV1Price = prices.dragonSwapV1;

    console.log(`📊 Prices updated: ${JSON.stringify(prices)}`);
    return prices;
};

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
    console.log("🌐 Connecting to Sei V2 WebSocket...");
    wsProvider = new NoEnsWebSocketProvider(process.env.SEI_V2_WS_RPC_URL);

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
        console.log(`✅ WebSocket connected to Sei V2: ${network.name} (chainId: ${network.chainId})`);
    } catch (error) {
        console.error(`⚠️ WebSocket connection failed: ${error.message}`);
        return;
    }

    console.log("📦 Initializing contracts...");

    if (useDragonSwapV2) {
        try {
            const abi = poolTypes[DRAGONSWAP_V2_POOL_ADDRESS] === 'V3' ? V3_POOL_ABI : V2_POOL_ABI;
            dragonSwapV2Pool = new ethers.Contract(DRAGONSWAP_V2_POOL_ADDRESS, abi, wsProvider);
            dragonSwapV2IsTokenAFirst = (await dragonSwapV2Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedDragonSwapV2Fee = poolTypes[DRAGONSWAP_V2_POOL_ADDRESS] === 'V3' ? Number(await dragonSwapV2Pool.fee()) : 3000; // 0.3% default for V2
            poolIsTokenAFirst[DRAGONSWAP_V2_POOL_ADDRESS] = dragonSwapV2IsTokenAFirst;
            console.log(`💲 DragonSwap V2 Fee: ${(cachedDragonSwapV2Fee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize DragonSwap V2: ${e.message}`);
            useDragonSwapV2 = false;
        }
    }

    if (useSailor) {
        try {
            const abi = poolTypes[SAILOR_POOL_ADDRESS] === 'V3' ? V3_POOL_ABI : V2_POOL_ABI;
            sailorPool = new ethers.Contract(SAILOR_POOL_ADDRESS, abi, wsProvider);
            sailorIsTokenAFirst = (await sailorPool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedSailorFee = poolTypes[SAILOR_POOL_ADDRESS] === 'V3' ? Number(await sailorPool.fee()) : 3000;
            poolIsTokenAFirst[SAILOR_POOL_ADDRESS] = sailorIsTokenAFirst;
            console.log(`💲 Sailor Fee: ${(cachedSailorFee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Sailor: ${e.message}`);
            useSailor = false;
        }
    }

    if (useOkuTrade) {
        try {
            const abi = poolTypes[OKU_TRADE_POOL_ADDRESS] === 'V3' ? V3_POOL_ABI : V2_POOL_ABI;
            okuTradePool = new ethers.Contract(OKU_TRADE_POOL_ADDRESS, abi, wsProvider);
            okuTradeIsTokenAFirst = (await okuTradePool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedOkuTradeFee = poolTypes[OKU_TRADE_POOL_ADDRESS] === 'V3' ? Number(await okuTradePool.fee()) : 3000;
            poolIsTokenAFirst[OKU_TRADE_POOL_ADDRESS] = okuTradeIsTokenAFirst;
            console.log(`💲 Oku Trade Fee: ${(cachedOkuTradeFee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Oku Trade: ${e.message}`);
            useOkuTrade = false;
        }
    }

    if (useJellyverse) {
        try {
            const abi = poolTypes[JELLYVERSE_POOL_ADDRESS] === 'V3' ? V3_POOL_ABI : V2_POOL_ABI;
            jellyversePool = new ethers.Contract(JELLYVERSE_POOL_ADDRESS, abi, wsProvider);
            jellyverseIsTokenAFirst = (await jellyversePool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedJellyverseFee = poolTypes[JELLYVERSE_POOL_ADDRESS] === 'V3' ? Number(await jellyversePool.fee()) : 3000;
            poolIsTokenAFirst[JELLYVERSE_POOL_ADDRESS] = jellyverseIsTokenAFirst;
            console.log(`💲 Jellyverse Fee: ${(cachedJellyverseFee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Jellyverse: ${e.message}`);
            useJellyverse = false;
        }
    }

    if (useYakaFinanceV3) {
        try {
            const abi = poolTypes[YAKA_FINANCE_V3_POOL_ADDRESS] === 'V3' ? V3_POOL_ABI : V2_POOL_ABI;
            yakaFinanceV3Pool = new ethers.Contract(YAKA_FINANCE_V3_POOL_ADDRESS, abi, wsProvider);
            yakaFinanceV3IsTokenAFirst = (await yakaFinanceV3Pool.token0()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedYakaFinanceV3Fee = poolTypes[YAKA_FINANCE_V3_POOL_ADDRESS] === 'V3' ? Number(await yakaFinanceV3Pool.fee()) : 3000;
            poolIsTokenAFirst[YAKA_FINANCE_V3_POOL_ADDRESS] = yakaFinanceV3IsTokenAFirst;
            console.log(`💲 Yaka Finance V3 Fee: ${(cachedYakaFinanceV3Fee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Yaka Finance V3: ${e.message}`);
            useYakaFinanceV3 = false;
        }
    }

    if (useDragonSwapV1) {
        try {
            dragonSwapV1Pool = new ethers.Contract(DRAGONSWAP_V1_POOL_ADDRESS, DRAGONSWAP_V1_ABI, wsProvider);
            dragonSwapV1IsTokenAFirst = (await dragonSwapV1Pool.tokenAddress()).toLowerCase() === TOKEN_A_ADDRESS.toLowerCase();
            cachedDragonSwapV1Fee = 3000; // Assuming 0.3% fee
            poolIsTokenAFirst[DRAGONSWAP_V1_POOL_ADDRESS] = dragonSwapV1IsTokenAFirst;
            console.log(`💲 Dragon Swap V1 Fee: ${(cachedDragonSwapV1Fee / 1e6 * 100).toFixed(2)}%`);
        } catch (e) {
            console.error(`⚠️ Failed to initialize Dragon Swap V1: ${e.message}`);
            useDragonSwapV1 = false;
        }
    }

    flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
    chainlinkTokenBUsd = new ethers.Contract(CHAINLINK_TOKEN_B_USD_ADDRESS, CHAINLINK_ABI, wsProvider);

    await fetchTokenDecimals();
    // await updateTokenBUsdPrice();

    try {
        await updatePrices();
        console.log(`📊 Initial prices: DragonSwapV2=${cachedDragonSwapV2Price}, Sailor=${cachedSailorPrice}, OkuTrade=${cachedOkuTradePrice}, Jellyverse=${cachedJellyversePrice}, YakaFinanceV3=${cachedYakaFinanceV3Price}, DragonSwapV1=${cachedDragonSwapV1Price}`);
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

    if (useDragonSwapV2) {
        dragonSwapV2Pool.on("Swap", async (sender, ...args) => {
            if (shouldStop) return;
            const blockNumber = args[args.length - 1].blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Swap on DragonSwap V2 at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on DragonSwap V2 at block ${blockNumber}`);
        });
    }

    if (useSailor) {
        sailorPool.on("Swap", async (sender, ...args) => {
            if (shouldStop) return;
            const blockNumber = args[args.length - 1].blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Swap on Sailor at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on Sailor at block ${blockNumber}`);
        });
    }

    if (useOkuTrade) {
        okuTradePool.on("Swap", async (sender, ...args) => {
            if (shouldStop) return;
            const blockNumber = args[args.length - 1].blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Swap on Oku Trade at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on Oku Trade at block ${blockNumber}`);
        });
    }

    if (useJellyverse) {
        jellyversePool.on("Swap", async (sender, ...args) => {
            if (shouldStop) return;
            const blockNumber = args[args.length - 1].blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Swap on Jellyverse at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on Jellyverse at block ${blockNumber}`);
        });
    }

    if (useYakaFinanceV3) {
        yakaFinanceV3Pool.on("Swap", async (sender, ...args) => {
            if (shouldStop) return;
            const blockNumber = args[args.length - 1].blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Swap on Yaka Finance V3 at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Swap on Yaka Finance V3 at block ${blockNumber}`);
        });
    }

    if (useDragonSwapV1) {
        dragonSwapV1Pool.on("TokenPurchase", async (buyer, seiSold, tokensBought, event) => {
            if (shouldStop) return;
            const blockNumber = event.blockNumber || (await wsProvider.getBlockNumber());
            console.log(`🔔 Token Purchase on Dragon Swap V1 at block ${blockNumber}`);
            await updatePrices(blockNumber);
            checkArbitrage(`Token Purchase on Dragon Swap V1 at block ${blockNumber}`);
        });
    }

    setInterval(updateFeeData, 20000); // Update gas fees every 20 seconds
    setInterval(updateTokenBUsdPrice, 60000);
    setInterval(async () => {
        if (Date.now() - lastPresignTime >= PRESIGN_INTERVAL && executingTransactions === 0) {
            await preparePresignedTransactions();
            lastPresignTime = Date.now();
            console.log("✅ Periodic presigned transactions prepared");
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

/** Update gas fee data (Sei V2 may use different fee model) */
const updateFeeData = async () => {
    console.log("⛽ Updating gas fee data...");
    try {
        const feeData = await signer.provider.getFeeData();
        let gasPrice = feeData.gasPrice || ethers.parseUnits("0.1", "gwei"); // Fallback for Sei V2
        cachedFeeData = {
            gasPrice,
            maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"), // Adjust if Sei V2 supports EIP-1559
            maxFeePerGas: gasPrice // Simplified for Sei V2
        };
        console.log(`✅ Gas Update - Gas Price: ${ethers.formatUnits(gasPrice, "gwei")} Gwei`);
    } catch (error) {
        console.error(`⚠️ Gas update failed: ${error.message}`);
        cachedFeeData = {
            gasPrice: ethers.parseUnits("0.1", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"),
            maxFeePerGas: ethers.parseUnits("0.1", "gwei")
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
            if (useDragonSwapV2) {
                if (poolTypes[DRAGONSWAP_V2_POOL_ADDRESS] === 'V3') {
                    const slot0 = await dragonSwapV2Pool.slot0();
                    prices.dragonSwapV2 = calculateV3Price(slot0.sqrtPriceX96, dragonSwapV2IsTokenAFirst);
                } else {
                    const reserves = await dragonSwapV2Pool.getReserves();
                    prices.dragonSwapV2 = calculateV2Price(reserves, dragonSwapV2IsTokenAFirst);
                }
            }
            if (useSailor) {
                if (poolTypes[SAILOR_POOL_ADDRESS] === 'V3') {
                    const slot0 = await sailorPool.slot0();
                    prices.sailor = calculateV3Price(slot0.sqrtPriceX96, sailorIsTokenAFirst);
                } else {
                    const reserves = await sailorPool.getReserves();
                    prices.sailor = calculateV2Price(reserves, sailorIsTokenAFirst);
                }
            }
            if (useOkuTrade) {
                if (poolTypes[OKU_TRADE_POOL_ADDRESS] === 'V3') {
                    const slot0 = await okuTradePool.slot0();
                    prices.okuTrade = calculateV3Price(slot0.sqrtPriceX96, okuTradeIsTokenAFirst);
                } else {
                    const reserves = await okuTradePool.getReserves();
                    prices.okuTrade = calculateV2Price(reserves, okuTradeIsTokenAFirst);
                }
            }
            if (useJellyverse) {
                if (poolTypes[JELLYVERSE_POOL_ADDRESS] === 'V3') {
                    const slot0 = await jellyversePool.slot0();
                    prices.jellyverse = calculateV3Price(slot0.sqrtPriceX96, jellyverseIsTokenAFirst);
                } else {
                    const reserves = await jellyversePool.getReserves();
                    prices.jellyverse = calculateV2Price(reserves, jellyverseIsTokenAFirst);
                }
            }
            if (useYakaFinanceV3) {
                if (poolTypes[YAKA_FINANCE_V3_POOL_ADDRESS] === 'V3') {
                    const slot0 = await yakaFinanceV3Pool.slot0();
                    prices.yakaFinanceV3 = calculateV3Price(slot0.sqrtPriceX96, yakaFinanceV3IsTokenAFirst);
                } else {
                    const reserves = await yakaFinanceV3Pool.getReserves();
                    prices.yakaFinanceV3 = calculateV2Price(reserves, yakaFinanceV3IsTokenAFirst);
                }
            }
            if (useDragonSwapV1) {
                prices.dragonSwapV1 = await calculateDragonSwapV1Price(dragonSwapV1Pool);
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
            `Insufficient funds: have ${ethers.formatUnits(balance, "ether")} SEI, need ${ethers.formatUnits(requiredFunds, "ether")} SEI`
        );
    }
    console.log(`✅ Balance sufficient: ${ethers.formatUnits(balance, "ether")} SEI available`);
};

/** Prepare presigned transactions for all enabled DEX pairs */
const preparePresignedTransactions = async () => {
    console.log("✍️ Preparing presigned transactions...");
    if (!cachedDragonSwapV2Price || !cachedTokenBUsdPrice) {
        console.log("⚠️ Skipping presigning: Price data incomplete");
        return;
    }

    if (!cachedFeeData) {
        console.log("⚠️ Skipping presigning: Fee data not available");
        await updateFeeData();
        if (!cachedFeeData) return;
    }

    const enabledDEXes = [];
    if (useDragonSwapV2) enabledDEXes.push({ name: 'DragonSwapV2', pool: DRAGONSWAP_V2_POOL_ADDRESS, type: poolTypes[DRAGONSWAP_V2_POOL_ADDRESS], fee: cachedDragonSwapV2Fee });
    if (useSailor) enabledDEXes.push({ name: 'Sailor', pool: SAILOR_POOL_ADDRESS, type: poolTypes[SAILOR_POOL_ADDRESS], fee: cachedSailorFee });
    if (useOkuTrade) enabledDEXes.push({ name: 'OkuTrade', pool: OKU_TRADE_POOL_ADDRESS, type: poolTypes[OKU_TRADE_POOL_ADDRESS], fee: cachedOkuTradeFee });
    if (useJellyverse) enabledDEXes.push({ name: 'Jellyverse', pool: JELLYVERSE_POOL_ADDRESS, type: poolTypes[JELLYVERSE_POOL_ADDRESS], fee: cachedJellyverseFee });
    if (useYakaFinanceV3) enabledDEXes.push({ name: 'YakaFinanceV3', pool: YAKA_FINANCE_V3_POOL_ADDRESS, type: poolTypes[YAKA_FINANCE_V3_POOL_ADDRESS], fee: cachedYakaFinanceV3Fee });
    if (useDragonSwapV1) enabledDEXes.push({ name: 'DragonSwapV1', pool: DRAGONSWAP_V1_POOL_ADDRESS, type: poolTypes[DRAGONSWAP_V1_POOL_ADDRESS], fee: cachedDragonSwapV1Fee });

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
    if (useDragonSwapV2) poolContracts[DRAGONSWAP_V2_POOL_ADDRESS] = dragonSwapV2Pool;
    if (useSailor) poolContracts[SAILOR_POOL_ADDRESS] = sailorPool;
    if (useOkuTrade) poolContracts[OKU_TRADE_POOL_ADDRESS] = okuTradePool;
    if (useJellyverse) poolContracts[JELLYVERSE_POOL_ADDRESS] = jellyversePool;

    const isV2Pool = (poolAddress) => poolTypes[poolAddress] === 'V2';

    Object.keys(presignedTxCache).forEach(key => delete presignedTxCache[key]);

    const nonceToUse = currentNonce;
    const { gasPrice } = cachedFeeData; // Sei V2 may not use EIP-1559
    const multiplier = BigInt(Math.round(GAS_FEE_MULTIPLIER * 100));
    const adjustedGasPrice = (gasPrice * multiplier) / BigInt(100);
    const gasLimit = BigInt(1000000);

    await checkBalance(adjustedGasPrice, gasLimit);

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
                    console.error(`Failed to calculate optimal borrow amount: ${error.message}`);
                    borrowAmount = calculateLoanAmount(cachedDragonSwapV2Price);
                }
            } else {
                borrowAmount = calculateLoanAmount(cachedDragonSwapV2Price);
            }

            const deadline = Math.floor(Date.now() / 1000) + 360;
            const txData = flashLoanArbitrage.interface.encodeFunctionData(
                "executeArbitrage",
                [pair.poolBuy, pair.poolSell, TOKEN_A_ADDRESS, borrowAmount, 0, 0, deadline, pair.feeBuy, pair.feeSell]
            );

            const tx = {
                to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
                data: txData,
                chainId: BigInt(1329), // Sei V2 chain ID (mainnet), adjust for testnet if needed
                gasLimit: gasLimit,
                gasPrice: adjustedGasPrice,
                nonce: nonceToUse
            };

            const signedTx = await signer.signTransaction(tx);
            presignedTxCache[`${pair.poolBuy}-${pair.poolSell}`] = { signedTx, timestamp: Date.now(), nonce: nonceToUse };
            console.log(`✅ Presigned tx for pair ${pair.poolBuy}-${pair.poolSell} at nonce ${nonceToUse}, gasPrice: ${ethers.formatUnits(adjustedGasPrice, "gwei")} Gwei`);
        } catch (error) {
            console.error(`⚠️ Failed to presign tx for pair ${pair.poolBuy}-${pair.poolSell}: ${error.message}`);
        }
    }
};

/** Calculate dynamic arbitrage threshold based on fees */
const calculateDynamicThreshold = (poolBuyFee, poolSellFee) => {
    const swapFeeBuyPercent = Number(poolBuyFee) / 1e6 * 100;
    const swapFeeSellPercent = Number(poolSellFee) / 1e6 * 100;
    const totalFeesPercent = swapFeeBuyPercent + swapFeeSellPercent; // No flashloan fee assumed unless specified
    return totalFeesPercent / 100;
};

/** Check for arbitrage opportunities */
const checkArbitrage = (context) => {
    console.log(`🔍 Checking arbitrage for context: ${context}`);
    if (shouldStop) {
        console.log(`🛑 Bot stopped. WINS: ${WINNING_STREAK} | LOSS: ${LOSING_STREAK}`);
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
    if (useDragonSwapV2 && cachedDragonSwapV2Price) prices.push({ dex: 'DragonSwapV2', price: cachedDragonSwapV2Price, pool: DRAGONSWAP_V2_POOL_ADDRESS, fee: cachedDragonSwapV2Fee });
    if (useSailor && cachedSailorPrice) prices.push({ dex: 'Sailor', price: cachedSailorPrice, pool: SAILOR_POOL_ADDRESS, fee: cachedSailorFee });
    if (useOkuTrade && cachedOkuTradePrice) prices.push({ dex: 'OkuTrade', price: cachedOkuTradePrice, pool: OKU_TRADE_POOL_ADDRESS, fee: cachedOkuTradeFee });
    if (useJellyverse && cachedJellyversePrice) prices.push({ dex: 'Jellyverse', price: cachedJellyversePrice, pool: JELLYVERSE_POOL_ADDRESS, fee: cachedJellyverseFee });
    if (useYakaFinanceV3 && cachedYakaFinanceV3Price) prices.push({ dex: 'YakaFinanceV3', price: cachedYakaFinanceV3Price, pool: YAKA_FINANCE_V3_POOL_ADDRESS, fee: cachedYakaFinanceV3Fee });
    if (useDragonSwapV1 && cachedDragonSwapV1Price) prices.push({ dex: 'DragonSwapV1', price: cachedDragonSwapV1Price, pool: DRAGONSWAP_V1_POOL_ADDRESS, fee: cachedDragonSwapV1Fee });

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
            console.log(`ℹ️ Price diff percent (${priceDiffPercent.toFixed(4)}%) < ${MIN_ARBITRAGE_THRESHOLD_PERCENT}%. Skipping trade.`);
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
        console.log(`ℹ️ Price difference (${priceDiff.toFixed(18)}) < ${MIN_PRICE_DIFF_THRESHOLD}. Skipping trade.`);
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
            console.log(`ℹ️ Skipping trade: Price diff ${priceDiff.toFixed(18)} <= ${requiredDiff.toFixed(18)}`);
            return;
        }
    }

    const gasToleranceWei = ethers.parseUnits(GAS_TOLERANCE.toString(), "gwei");
    if (cachedFeeData.gasPrice > gasToleranceWei) {
        console.log(`💡 Arbitrage opportunity detected but gas fee too high: ${ethers.formatUnits(cachedFeeData.gasPrice, "gwei")} gwei > ${GAS_TOLERANCE} gwei`);
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
    console.log(`📈 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Percent=${priceDiffPercent.toFixed(4)}%)`);
    const poolBuy = maxPriceDex.pool;
    const poolSell = minPriceDex.pool;
    const detectionTime = arbOpportunityStartTime;
    // executePresignedArbitrage(poolBuy, poolSell, detectionTime, priceDiff);
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
    const profitUSD = (profitInTokenA * cachedDragonSwapV2Price) * cachedTokenBUsdPrice;
    const gasCostUSD = gasCostInTokenB * cachedTokenBUsdPrice;
    const netPnLUSD = netPnL * cachedTokenBUsdPrice;
    const cumulativePnLUSD = cumulativePnL * cachedTokenBUsdPrice;
    const loanAmountInTokenA = Number(ethers.formatUnits(loanAmount, tokenADecimals));
    const loanAmountUSD = (loanAmountInTokenA * cachedDragonSwapV2Price) * cachedTokenBUsdPrice;

    const logMessage = `
🕒 Timestamp: ${timestamp}
🔢 Transaction #${serial}
ℹ️ Status: ${statusText}
📜 Transaction Hash: ${txHash || 'N/A'}
↔️ Path: ${poolBuy} -> ${poolSell}
💸 Loan Amount: ${loanAmountInTokenA.toFixed(18)} TOKEN_A (≈$${loanAmountUSD.toFixed(2)} USD)
💰 Profit: ${profitInTokenA.toFixed(18)} TOKEN_A (≈$${profitUSD.toFixed(2)} USD)
⛽ Gas Cost: ${gasCostInTokenB.toFixed(18)} TOKEN_B (≈$${gasCostUSD.toFixed(2)} USD)
📈 Net PnL: ${netPnL.toFixed(18)} TOKEN_B (≈$${netPnLUSD.toFixed(2)} USD)
📊 Cumulative PnL: ${cumulativePnL.toFixed(18)} TOKEN_B (≈$${cumulativePnLUSD.toFixed(2)} USD)
⏱️ Timing Details:
- Detection to retrieve/generate: ${timingDetails.timeToRetrieveOrGenerate} ms
- Retrieve/generate to send: ${timingDetails.timeToSend} ms
- Send to confirm: ${timingDetails.timeSendToConfirm} ms
- Total execution time: ${timingDetails.totalTime} ms
🔍 Opportunity Status: ${opportunityStatus}${errorMessage}
--------------------------------------------------
`;
    fs.appendFileSync(path.join(__dirname, "p&l.txt"), logMessage);
};

/** Execute arbitrage using presigned transaction */
const executePresignedArbitrage = async (poolBuy, poolSell, detectionTime, priceDiff) => {
    console.log(`🚀 Starting arbitrage execution #${arbitrageCount} for ${poolBuy} -> ${poolSell}`);
    executingTransactions++;
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
        console.log(`📤 Sending tx to Sei V2 sequencer at ${sendStartTime}`);
        const txHash = await txProvider.send("eth_sendRawTransaction", [presigned.signedTx]);
        const hashReceivedTime = Date.now();
        console.log(`✅ Tx hash received: ${txHash} at ${hashReceivedTime}`);

        currentNonce++;
        await preparePresignedTransactions();

        const waitStartTime = Date.now();
        console.log(`⏳ Waiting for tx confirmation at ${waitStartTime}`);
        const receipt = await httpProvider.waitForTransaction(txHash);
        const confirmTime = Date.now();
        console.log(`✅ Tx confirmed at ${confirmTime}`);

        const timeToRetrieveOrGenerate = retrieveOrGenerateTime - detectionTime;
        const timeToSend = sendStartTime - retrieveOrGenerateTime;
        const timeSendToConfirm = confirmTime - sendStartTime;
        const totalTime = confirmTime - detectionTime;

        if (receipt) {
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
            const profitInTokenB = profitInTokenA * cachedDragonSwapV2Price;
            const netPnLInTokenB = profitInTokenB - gasCostInTokenB;
            cumulativePnLInTokenB += netPnLInTokenB;

            const isSuccess = receipt.status === 1;
            updateStreaks(isSuccess, priceDiff);

            await updatePrices();
            const prices = [];
            if (useDragonSwapV2 && cachedDragonSwapV2Price) prices.push({ dex: 'DragonSwapV2', price: cachedDragonSwapV2Price });
            if (useSailor && cachedSailorPrice) prices.push({ dex: 'Sailor', price: cachedSailorPrice });
            if (useOkuTrade && cachedOkuTradePrice) prices.push({ dex: 'OkuTrade', price: cachedOkuTradePrice });
            if (useJellyverse && cachedJellyversePrice) prices.push({ dex: 'Jellyverse', price: cachedJellyversePrice });
            if (useYakaFinanceV3 && cachedYakaFinanceV3Price) prices.push({ dex: 'YakaFinanceV3', price: cachedYakaFinanceV3Price });
            if (useDragonSwapV1 && cachedDragonSwapV1Price) prices.push({ dex: 'DragonSwapV1', price: cachedDragonSwapV1Price });

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
        if (useDragonSwapV2 && cachedDragonSwapV2Price) prices.push({ dex: 'DragonSwapV2', price: cachedDragonSwapV2Price });
        if (useSailor && cachedSailorPrice) prices.push({ dex: 'Sailor', price: cachedSailorPrice });
        if (useOkuTrade && cachedOkuTradePrice) prices.push({ dex: 'OkuTrade', price: cachedOkuTradePrice });
        if (useJellyverse && cachedJellyversePrice) prices.push({ dex: 'Jellyverse', price: cachedJellyversePrice });
        if (useYakaFinanceV3 && cachedYakaFinanceV3Price) prices.push({ dex: 'YakaFinanceV3', price: cachedYakaFinanceV3Price });
        if (useDragonSwapV1 && cachedDragonSwapV1Price) prices.push({ dex: 'DragonSwapV1', price: cachedDragonSwapV1Price });

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
        console.log("🛠️ Initializing Sei V2 HTTP provider and signer...");
        httpProvider = new NoEnsJsonRpcProvider(process.env.SEI_V2_HTTP_RPC_URL);
        txProvider = new NoEnsJsonRpcProvider(process.env.SEI_V2_SEQUENCER_RPC_URL);
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