const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ========== CONFIGURATION ==========
const ARB_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // ARB on Arbitrum
const WETH_ADDRESS = "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"; // WETH on Arbitrum
const UNISWAP_V3_POOL_ADDRESS = "0x641c00a822e8b671738d32a431a4fb6074e5c79d"; // Uniswap V3 ARB/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0xcb0e5bfa72bbb4d16ab5aa0c60601c438f04b4ad"; // SushiSwap V2 ARB/WETH
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0x98A652b3beB8508d6bfa62E464732DBdC69394A2";
const BORROW_VALUE_USD = 1; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 1;
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_ETH_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Chainlink ETH/USD on Arbitrum
const AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Aave V3 Pool on Arbitrum
const POLLING_INTERVAL = 50; // Poll every 50ms

// ========== ABI DEFINITIONS ==========
const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)"
];

const V2_POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const FLASHLOAN_ARBITRAGE_ABI = [
  "function executeArbitrage(address token, uint256 amount, bool direction, uint256 minAmountOut1, uint256 minAmountOut2, uint256 deadline, uint24 fee1, uint24 fee2) external",
  "event ArbitrageExecuted(uint256 profit, bool success)"
];

const CHAINLINK_ABI = [
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)"
];

const AAVE_POOL_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint256)"
];

// ========== GLOBAL STATE ==========
let uniswapProvider, sushiProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, flashLoanArbitrage, chainlinkEthUsd;
let uniswapIsARBFirst, sushiswapIsARBFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0;
let cachedWethUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedFlashloanPremium;
let highestPriceDiff = 0;
let arbitrageCount = 0;
let cumulativePnLInWETH = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 2;
let currentNonce;
let pollingInterval;
let pollingActive = true; // Controls polling loop
let opportunityActive = false; // Tracks if an arbitrage opportunity is active
let opportunityStartTime = null; // Timer start for opportunity detection

// ========== CORE FUNCTIONS ==========

/** Initialize providers and contracts */
const initialize = async () => {
  try {
    uniswapProvider = new ethers.JsonRpcProvider(process.env.UNISWAP_RPC_URL);
    sushiProvider = new ethers.JsonRpcProvider(process.env.SUSHISWAP_RPC_URL);
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, uniswapProvider);
    currentNonce = await signer.provider.getTransactionCount(signer.address, "pending");

    uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, uniswapProvider);
    sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, sushiProvider);
    flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, signer);
    chainlinkEthUsd = new ethers.Contract(CHAINLINK_ETH_USD_ADDRESS, CHAINLINK_ABI, uniswapProvider);
    const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, uniswapProvider);

    const [uniToken0, uniToken1, sushiToken0, sushiToken1] = await Promise.all([
      uniswapV3Pool.token0(),
      uniswapV3Pool.token1(),
      sushiswapV2Pool.token0(),
      sushiswapV2Pool.token1()
    ]);
    uniswapIsARBFirst = uniToken0.toLowerCase() === ARB_ADDRESS.toLowerCase();
    sushiswapIsARBFirst = sushiToken0.toLowerCase() === ARB_ADDRESS.toLowerCase();

    cachedUniswapFee = await uniswapV3Pool.fee();
    cachedSushiSwapFee = 3000; // Assumed fixed fee for V2 pairs
    cachedFlashloanPremium = await aavePool.FLASHLOAN_PREMIUM_TOTAL();

    await updateWethUsdPrice();
    await updateFeeData();
  } catch (error) {
    console.error("Initialization failed:", error.message);
  }
};

/** Update WETH/USD price from Chainlink */
const updateWethUsdPrice = async () => {
  try {
    const price = await chainlinkEthUsd.latestAnswer();
    const decimals = Number(await chainlinkEthUsd.decimals());
    cachedWethUsdPrice = Number(price) / 10 ** decimals;
  } catch (error) {
    console.error("Failed to update WETH/USD price:", error.message);
  }
};

/** Update gas fee data */
const updateFeeData = async () => {
  try {
    cachedFeeData = await uniswapProvider.getFeeData();
  } catch (error) {
    console.error("Gas update failed:", error.message);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("1", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      maxFeePerGas: ethers.parseUnits("2", "gwei")
    };
  }
};

/** Calculate ARB/WETH price from sqrtPriceX96 (Uniswap V3) */
const calculateV3Price = (sqrtPriceX96, isWETHFirst) => {
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const priceRatio = sqrtPrice * sqrtPrice; // token1 per token0 in smallest units
  let price;

  if (isWETHFirst) {
    // WETH (token0), USDT (token1)
    price = priceRatio * 1e12; // USDT per WETH
  } else {
    // USDT (token0), WETH (token1)
    price = (1 / priceRatio) * 1e-12; // USDT per WETH
  }

  // console.log(`Uniswap V3 price: ${price} USDT per WETH`);
  return price;
};
/** Calculate WETH/USDT price from SushiSwap V2 reserves */
/** Calculate USDT per WETH price from SushiSwap V2 reserves */
const calculateV2Price = (reserves, isWETHFirst) => {
  const reserve0 = Number(reserves.reserve0);
  const reserve1 = Number(reserves.reserve1);
  let price;

  if (isWETHFirst) {
    // WETH (token0), USDT (token1)
    price = (reserve1 / reserve0) * 1e12; // USDT per WETH
  } else {
    // USDT (token0), WETH (token1)
    price = (reserve0 / reserve1) * 1e12; // USDT per WETH
  }

  // console.log(`SushiSwap V2 price: ${price} USDT per WETH`);
  return price;
};

/** Poll Uniswap V3 price */
const pollUniswapPrice = async () => {
  try {
    const slot0 = await uniswapV3Pool.slot0();
    cachedUniswapPrice = calculateV3Price(slot0.sqrtPriceX96, uniswapIsARBFirst);
  } catch (error) {
    console.error("Failed to poll Uniswap V3 price:", error.message);
  }
};

/** Poll SushiSwap V2 price */
const pollSushiSwapPrice = async () => {
  try {
    const reserves = await sushiswapV2Pool.getReserves();
    cachedSushiSwapPrice = calculateV2Price(reserves, sushiswapIsARBFirst);
  } catch (error) {
    console.error("Failed to poll SushiSwap V2 price:", error.message);
  }
};

/** Poll both prices and check arbitrage */
const pollAndCheck = async () => {
  if (!pollingActive) return;
  await Promise.all([pollUniswapPrice(), pollSushiSwapPrice()]);
  checkArbitrage();
};

/** Start polling prices */
const startPolling = () => {
  pollingInterval = setInterval(pollAndCheck, POLLING_INTERVAL);
  setInterval(updateWethUsdPrice, 60000); // Update WETH/USD price every minute
  setInterval(updateFeeData, 10000); // Update gas fees every 10 seconds
};

/** Stop polling */
const stopPolling = () => {
  clearInterval(pollingInterval);
  pollingActive = false;
  console.log("Bot stopped completely.");
};

/** Calculate loan amount in ARB based on USD value */
const calculateLoanAmount = (targetPrice) => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price not available for loan calculation");
    throw new Error("WETH/USD price not available");
  }
  const borrowValueWeth = BORROW_VALUE_USD / cachedWethUsdPrice;
  const ARBAmountFloat = borrowValueWeth / targetPrice;
  const ARBAmountStr = ARBAmountFloat.toFixed(18);
  return ethers.parseUnits(ARBAmountStr, 18);
};

/** Check for arbitrage opportunities */
const checkArbitrage = () => {
  if (shouldStop && executingTransactions === 0) {
    stopPolling();
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    if (!shouldStop) {
      console.log(`No more transactions: Reached max arbitrage transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
      shouldStop = true;
    }
    // Continue polling to track opportunity vanish time
  }

  if (executingTransactions >= MAX_EXECUTING_TRANSACTIONS) {
    console.log("Max executing transactions reached, waiting for completion.");
    return;
  }

  if (!cachedUniswapPrice || !cachedSushiSwapPrice) {
    console.log("Price data missing - Uniswap:", cachedUniswapPrice, "SushiSwap:", cachedSushiSwapPrice);
    return;
  }

  const priceDiff = Math.abs(cachedUniswapPrice - cachedSushiSwapPrice);
  if (priceDiff > highestPriceDiff) highestPriceDiff = priceDiff;

  if (priceDiff > ARBITRAGE_THRESHOLD) {
    if (!opportunityActive) {
      opportunityActive = true;
      opportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity detected, timer started`);
    }
    console.log(`🚨 Arbitrage #${arbitrageCount + 1}: Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
    if (arbitrageCount < MAX_ARBITRAGE_TRANSACTIONS) {
      arbitrageCount++;
      const direction = cachedSushiSwapPrice > cachedUniswapPrice;
      executePresignedArbitrage(direction, opportunityStartTime);
    }
  } else if (opportunityActive) {
    const vanishDuration = Date.now() - opportunityStartTime;
    console.log(`😟 Arbitrage opportunity vanished after ${vanishDuration} ms`);
    opportunityActive = false;
    opportunityStartTime = null;
  } else {
    console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)}) | Count: ${arbitrageCount}`);
  }
};

/** Execute arbitrage transaction with ms logging */
const executePresignedArbitrage = async (direction, detectionTime) => {
  executingTransactions++;
  let loanAmount;

  try {
    const prepStart = Date.now();
    console.log(`Starting arbitrage prep ${prepStart - detectionTime} ms after detection`);

    const targetPrice = direction ? cachedSushiSwapPrice : cachedUniswapPrice;
    if (!targetPrice) throw new Error("Target price unavailable");
    loanAmount = calculateLoanAmount(targetPrice);

    const uniswapFeeFactor = 1 - Number(cachedUniswapFee) / 1e6;
    const sushiswapFeeFactor = 1 - Number(cachedSushiSwapFee) / 1e6;
    const feeFactorFirst = direction ? sushiswapFeeFactor : uniswapFeeFactor;
    const feeFactorSecond = direction ? uniswapFeeFactor : sushiswapFeeFactor;

    const slippageTolerance = 0.2;
    let minAmountOut1, minAmountOut2;
    const loanAmountFloat = Number(ethers.formatUnits(loanAmount, 18));

    if (direction) {
      const expectedWETHFloat = loanAmountFloat * cachedSushiSwapPrice * feeFactorFirst;
      const expectedWETH = ethers.parseUnits(expectedWETHFloat.toFixed(18), 18);
      minAmountOut1 = (expectedWETH * BigInt(Math.floor((1 - slippageTolerance) * 10000))) / 10000n;

      const expectedARBFloat = expectedWETHFloat / cachedUniswapPrice * feeFactorSecond;
      const expectedARB = ethers.parseUnits(expectedARBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedARB * BigInt(Math.floor((1 - slippageTolerance) * 10000))) / 10000n;
    } else {
      const expectedWETHFloat = loanAmountFloat * cachedUniswapPrice * feeFactorFirst;
      const expectedWETH = ethers.parseUnits(expectedWETHFloat.toFixed(18), 18);
      minAmountOut1 = (expectedWETH * BigInt(Math.floor((1 - slippageTolerance) * 10000))) / 10000n;

      const expectedARBFloat = expectedWETHFloat / cachedSushiSwapPrice * feeFactorSecond;
      const expectedARB = ethers.parseUnits(expectedARBFloat.toFixed(18), 18);
      minAmountOut2 = (expectedARB * BigInt(Math.floor((1 - slippageTolerance) * 10000))) / 10000n;
    }

    const premiumRate = Number(cachedFlashloanPremium) / 10000;
    const totalDebtFloat = loanAmountFloat * (1 + premiumRate);
    const totalDebt = ethers.parseUnits(totalDebtFloat.toFixed(18), 18);

    const deadline = Math.floor(Date.now() / 1000) + 45;
    const feeFirst = direction ? cachedSushiSwapFee : cachedUniswapFee;
    const feeSecond = direction ? cachedUniswapFee : cachedSushiSwapFee;

    const txData = flashLoanArbitrage.interface.encodeFunctionData(
      "executeArbitrage",
      [ARB_ADDRESS, loanAmount, direction, minAmountOut1, minAmountOut2, deadline, feeFirst, feeSecond]
    );

    const fetchedFeeData = cachedFeeData || { gasPrice: ethers.parseUnits("1", "gwei") };
    const baseFeePerGas = fetchedFeeData.lastBaseFeePerGas || fetchedFeeData.gasPrice;
    const suggestedMaxPriorityFeePerGas = fetchedFeeData.maxPriorityFeePerGas || fetchedFeeData.gasPrice;
    const reasonableTip = suggestedMaxPriorityFeePerGas * 2n;
    const buffer = ethers.parseUnits("0.1", "gwei");
    let maxFeePerGas = baseFeePerGas + reasonableTip + buffer;
    const suggestedMaxFeePerGas = fetchedFeeData.maxFeePerGas || (baseFeePerGas + suggestedMaxPriorityFeePerGas);
    if (maxFeePerGas < suggestedMaxFeePerGas) maxFeePerGas = suggestedMaxFeePerGas;

    const tx = {
      to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      data: txData,
      nonce: currentNonce,
      chainId: 42161n,
      type: 2,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: reasonableTip,
      gasLimit: 1000000n
    };

    const signedTx = await signer.signTransaction(tx);
    const sendTime = Date.now();
    console.log(`⚡ TX sent ${sendTime - detectionTime} ms after detection`);
    const txHash = await uniswapProvider.send("eth_sendRawTransaction", [signedTx]);
    currentNonce++;

    const receipt = await uniswapProvider.waitForTransaction(txHash);
    const confirmTime = Date.now();
    console.log(`✅ TX confirmed ${confirmTime - detectionTime} ms after detection - Status: ${receipt.status}`);

    const prepDuration = sendTime - prepStart;
    const confirmDuration = confirmTime - sendTime;
    const totalDuration = confirmTime - detectionTime;

    if (receipt && receipt.status === 1) {
      let profitInARB = 0n;
      for (const log of receipt.logs) {
        try {
          const parsedLog = flashLoanArbitrage.interface.parseLog(log);
          if (parsedLog.name === "ArbitrageExecuted") {
            profitInARB = parsedLog.args.profit;
            break;
          }
        } catch (e) {
          // Skip non-matching logs
        }
      }

      const sellPrice = direction ? cachedSushiSwapPrice : cachedUniswapPrice;
      const profitInWETH = Number(ethers.formatUnits(profitInARB, 18)) * sellPrice;
      const gasCostInWei = receipt.gasUsed * (receipt.effectiveGasPrice || cachedFeeData.gasPrice);
      const gasCostInWETH = Number(ethers.formatUnits(gasCostInWei, 18));

      const netPnL = profitInWETH - gasCostInWETH;
      cumulativePnLInWETH += netPnL;

      console.log(`Profit: ${profitInWETH.toFixed(18)} WETH, Gas Cost: ${gasCostInWETH.toFixed(18)} WETH, Net PnL: ${netPnL.toFixed(18)} WETH`);
      console.log(`Timings - Prep: ${prepDuration} ms, Confirm: ${confirmDuration} ms, Total: ${totalDuration} ms`);
      logTransactionDetails(
        arbitrageCount,
        txHash,
        direction,
        loanAmount,
        profitInWETH,
        gasCostInWETH,
        netPnL,
        cumulativePnLInWETH,
        receipt.status,
        null,
        prepDuration,
        confirmDuration,
        totalDuration
      );
      checkStopCondition();
    } else {
      console.log(`❌ TX failed after ${totalDuration} ms`);
      logTransactionDetails(
        arbitrageCount,
        txHash,
        direction,
        loanAmount,
        0,
        0,
        0,
        cumulativePnLInWETH,
        receipt.status,
        "Transaction reverted",
        prepDuration,
        confirmDuration,
        totalDuration
      );
    }
  } catch (error) {
    const failTime = Date.now();
    const prepDuration = prepStart ? (failTime - prepStart) : 0;
    const totalDuration = failTime - detectionTime;
    console.error(`Execution failed after ${totalDuration} ms: ${error.message}`);
    logTransactionDetails(
      arbitrageCount,
      null,
      direction,
      loanAmount || 0n,
      0,
      0,
      0,
      cumulativePnLInWETH,
      0,
      error.message,
      prepDuration,
      null,
      totalDuration
    );
  } finally {
    executingTransactions--;
    if (shouldStop && executingTransactions === 0) {
      stopPolling();
    }
  }
};

/** Log transaction details to p&l.txt with ms durations */
const logTransactionDetails = (
  serial,
  txHash,
  direction,
  loanAmount,
  profitInWETH,
  gasCostInWETH,
  netPnL,
  cumulativePnL,
  txStatus,
  error,
  prepDuration,
  confirmDuration,
  totalDuration
) => {
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const arbUsdPrice = cachedUniswapPrice * cachedWethUsdPrice;
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * arbUsdPrice;
  const profitUSD = profitInWETH * cachedWethUsdPrice;
  const gasCostUSD = gasCostInWETH * cachedWethUsdPrice;
  const netPnLUSD = netPnL * cachedWethUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedWethUsdPrice;

  const logMessage = `
Transaction #${serial}
Status: ${statusText}
Transaction Hash: ${txHash || 'N/A'}
Direction: ${direction ? "SushiSwap -> Uniswap" : "Uniswap -> SushiSwap"}
Loan Amount: ${ethers.formatUnits(loanAmount, 18)} ARB (≈$${loanAmountUSD.toFixed(2)} USD)
Profit: ${profitInWETH.toFixed(18)} WETH (≈$${profitUSD.toFixed(2)} USD)
Gas Cost: ${gasCostInWETH.toFixed(18)} WETH (≈$${gasCostUSD.toFixed(2)} USD)
Net PnL: ${netPnL.toFixed(18)} WETH (≈$${netPnLUSD.toFixed(2)} USD)
Cumulative PnL: ${cumulativePnL.toFixed(18)} WETH (≈$${cumulativePnLUSD.toFixed(2)} USD)
Timings:
- Prep: ${prepDuration} ms
- Confirm: ${confirmDuration || 'N/A'} ms
- Total: ${totalDuration} ms${errorMessage}
--------------------------------------------------
`;
  fs.appendFileSync("logs/p&l.txt", logMessage);
};

/** Check stop-loss condition dynamically */
const checkStopCondition = () => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price is zero, cannot check stop condition");
    return;
  }
  const stopLossWeth = STOP_LOSS_USD / cachedWethUsdPrice;
  if (cumulativePnLInWETH <= -stopLossWeth) {
    console.log(`Net PnL ${cumulativePnLInWETH} WETH (≈$${cumulativePnLInWETH * cachedWethUsdPrice} USD) hit stop loss. Stopping bot.`);
    shouldStop = true;
    if (executingTransactions === 0) {
      stopPolling();
    }
  }
};

// ========== INITIALIZATION ==========
(async () => {
  await initialize();
  startPolling();
})().catch(console.error);