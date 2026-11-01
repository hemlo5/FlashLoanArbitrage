const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// ### Configuration
const RDNT_ADDRESS = "0x0c4681e6c0235179ec3d4f4fc4df3d14fdd96017"; // RDNT on Arbitrum
const WETH_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH on Arbitrum
const UNISWAP_V3_POOL_ADDRESS = "0x2334d412da299a21486b663d12c392185b313aaa"; // Uniswap V3 RDNT/WETH
const SUSHISWAP_V2_POOL_ADDRESS = "0x24704aff49645d32655a76df6d407e02d146dafc"; // SushiSwap V2 RDNT/WETH
const FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS = "0xeE86F87D9C7F753170cf0C4D81b41aAAFc0843B7";
const BORROW_VALUE_USD = 10; // Desired borrow amount in USD
const ARBITRAGE_THRESHOLD = 0.00000017;
const MAX_ARBITRAGE_TRANSACTIONS = 1; // Stop after max arbitrage transactions
const STOP_LOSS_USD = 2.5; // Stop when net loss reaches $2.5
const CHAINLINK_ETH_USD_ADDRESS = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // Chainlink ETH/USD on Arbitrum
const AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Aave V3 Pool on Arbitrum

// ### ABI Definitions
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

// ### Global State
let wsProvider, httpProvider, signer, cachedFeeData;
let uniswapV3Pool, sushiswapV2Pool, flashLoanArbitrage, chainlinkEthUsd;
let uniswapIsRDNTFirst, sushiswapIsRDNTFirst;
let cachedUniswapPrice = 0, cachedSushiSwapPrice = 0;
let cachedWethUsdPrice = 0;
let cachedUniswapFee, cachedSushiSwapFee, cachedFlashloanPremium;
const swapEventTimestamps = {};
let highestPriceDiff = 0;
let arbitrageCount = 0;
let arbOpportunityStartTime = null;
let cumulativePnLInWETH = 0;
let shouldStop = false;
let executingTransactions = 0;
const MAX_EXECUTING_TRANSACTIONS = 2;
let currentNonce;

// ### Core Functions

/** Connect to WebSocket and initialize contracts */
const connectWebSocket = async () => {
  wsProvider = new ethers.WebSocketProvider(process.env.ARBITRUM_WS_RPC_URL);

  wsProvider.websocket.on("close", (code) => {
    console.error(`WebSocket closed (${code}). Reconnecting...`);
    setTimeout(connectWebSocket, 3000);
  });

  wsProvider.websocket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    wsProvider.websocket.close();
  });

  try {
    await wsProvider.getNetwork();
    console.log("✅ WebSocket connected");
  } catch (error) {
    console.error("WebSocket connection failed:", error.message);
    return;
  }

  uniswapV3Pool = new ethers.Contract(UNISWAP_V3_POOL_ADDRESS, V3_POOL_ABI, wsProvider);
  sushiswapV2Pool = new ethers.Contract(SUSHISWAP_V2_POOL_ADDRESS, V2_POOL_ABI, wsProvider);
  flashLoanArbitrage = new ethers.Contract(FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS, FLASHLOAN_ARBITRAGE_ABI, wsProvider);
  chainlinkEthUsd = new ethers.Contract(CHAINLINK_ETH_USD_ADDRESS, CHAINLINK_ABI, wsProvider);
  const aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, wsProvider);

  try {
    const [uniToken0, uniToken1, sushiToken0, sushiToken1] = await Promise.all([
      uniswapV3Pool.token0(),
      uniswapV3Pool.token1(),
      sushiswapV2Pool.token0(),
      sushiswapV2Pool.token1()
    ]);
    console.log(`Uniswap token0: ${uniToken0}, token1: ${uniToken1}`);
    console.log(`SushiSwap token0: ${sushiToken0}, token1: ${sushiToken1}`);
    uniswapIsRDNTFirst = uniToken0.toLowerCase() === RDNT_ADDRESS.toLowerCase();
    sushiswapIsRDNTFirst = sushiToken0.toLowerCase() === RDNT_ADDRESS.toLowerCase();
    console.log(`Uniswap isRDNTFirst: ${uniswapIsRDNTFirst}`);
    console.log(`SushiSwap isRDNTFirst: ${sushiswapIsRDNTFirst}`);
  } catch (error) {
    console.error("Failed to fetch pool token details:", error.message);
    return;
  }

  try {
    cachedUniswapFee = await uniswapV3Pool.fee();
    cachedSushiSwapFee = 3000; // SushiSwap V2 fixed fee (0.3%)
    cachedFlashloanPremium = await aavePool.FLASHLOAN_PREMIUM_TOTAL();
    console.log(`Uniswap V3 Pool Fee: ${cachedUniswapFee} (${(Number(cachedUniswapFee) / 1e6) * 100}%)`);
    console.log(`SushiSwap V2 Pool Fee (assumed): ${cachedSushiSwapFee} (${(cachedSushiSwapFee / 1e6) * 100}%)`);
    console.log(`Aave Flashloan Premium: ${cachedFlashloanPremium} bps (${Number(cachedFlashloanPremium) / 10000}%)`);
  } catch (error) {
    console.error("Failed to fetch fees or premium:", error.message);
    return;
  }

  await updateWethUsdPrice();
  try {
    const { freshPriceUni, freshPriceSushi } = await fetchFreshPrices();
    cachedUniswapPrice = freshPriceUni;
    cachedSushiSwapPrice = freshPriceSushi;
  } catch (error) {
    console.error("Initial price fetch failed:", error.message);
  }

  await updateFeeData();
  checkArbitrage("Initial");
  setupEventListeners();

  setInterval(updateFeeData, 10000);
  setInterval(updateWethUsdPrice, 60000);
};

/** Update WETH/USD price from Chainlink */
const updateWethUsdPrice = async () => {
  try {
    const price = await chainlinkEthUsd.latestAnswer();
    const decimals = Number(await chainlinkEthUsd.decimals());
    cachedWethUsdPrice = Number(price) / 10 ** decimals;
    console.log(`💵 Updated WETH/USD price: ${cachedWethUsdPrice}`);
  } catch (error) {
    console.error("Failed to update WETH/USD price:", error.message);
  }
};

/** Update gas fee data */
const updateFeeData = async () => {
  try {
    cachedFeeData = await wsProvider.getFeeData();
    console.log("⛽ Gas Update - Base:", ethers.formatUnits(cachedFeeData.gasPrice, "gwei"), "Gwei");
  } catch (error) {
    console.error("Gas update failed:", error.message);
    cachedFeeData = {
      gasPrice: ethers.parseUnits("1", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      maxFeePerGas: ethers.parseUnits("2", "gwei")
    };
  }
};

/** Calculate RDNT/WETH price from sqrtPriceX96 (Uniswap V3) */
const calculateV3Price = (sqrtPriceX96, isRDNTFirst) => {
  const decimalsRDNT = 18;
  const decimalsWETH = 18;
  const sqrtPrice = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const priceRatio = sqrtPrice ** 2;
  const price = isRDNTFirst 
    ? priceRatio * 10 ** (decimalsRDNT - decimalsWETH)
    : (1 / priceRatio) * 10 ** (decimalsWETH - decimalsRDNT);
  console.log(`Calculated V3 price: ${price} (isRDNTFirst: ${isRDNTFirst})`);
  return price;
};

/** Calculate RDNT/WETH price from SushiSwap V2 reserves */
const calculateV2Price = (reserves, isRDNTFirst) => {
  const reserve0 = Number(reserves.reserve0.toString());
  const reserve1 = Number(reserves.reserve1.toString());
  const price = isRDNTFirst ? reserve1 / reserve0 : reserve0 / reserve1;
  console.log(`Calculated V2 price: ${price} (isRDNTFirst: ${isRDNTFirst})`);
  return price;
};

/** Fetch and log prices from both DEXes in parallel */
const fetchAndLogPrices = async (context = "general") => {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const [slot0Uni, reservesSushi] = await Promise.all([
        uniswapV3Pool.slot0(),
        sushiswapV2Pool.getReserves()
      ]);

      const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsRDNTFirst);
      const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsRDNTFirst);
      const priceDiff = Math.abs(freshPriceUni - freshPriceSushi);
      const timestamp = Date.now();

      const logMessage = `⭕Double check (${context}): Uniswap=${freshPriceUni.toFixed(18)}, SushiSwap=${freshPriceSushi.toFixed(18)}, PriceDiff=${priceDiff.toFixed(18)} at ${timestamp}\n`;
      console.log(logMessage);
      fs.appendFileSync("logs/time.txt", logMessage);
      return { freshPriceUni, freshPriceSushi, priceDiff };
    } catch (err) {
      console.error(`Fetch and log prices attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === maxRetries - 1) {
        const errorMessage = `Failed to fetch prices after ${maxRetries} attempts: ${err.message}\n`;
        console.error(errorMessage);
        fs.appendFileSync("logs/time.txt", errorMessage);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return null;
};

/** Fetch initial prices for initialization */
const fetchFreshPrices = async () => {
  try {
    const slot0Uni = await uniswapV3Pool.slot0();
    const freshPriceUni = calculateV3Price(slot0Uni.sqrtPriceX96, uniswapIsRDNTFirst);
    const reservesSushi = await sushiswapV2Pool.getReserves();
    const freshPriceSushi = calculateV2Price(reservesSushi, sushiswapIsRDNTFirst);
    console.log(`Fresh UniswapV3 price: ${freshPriceUni}`);
    console.log(`Fresh SushiSwapV2 price: ${freshPriceSushi}`);
    return { freshPriceUni, freshPriceSushi };
  } catch (error) {
    console.error("Failed to fetch fresh prices during initialization:", error.message);
    throw error;
  }
};

/** Set up swap event listeners for price updates */
const setupEventListeners = () => {
  uniswapV3Pool.removeAllListeners("Swap");
  sushiswapV2Pool.removeAllListeners("Swap");

  uniswapV3Pool.on("Swap", (_, __, ___, ____, sqrtPriceX96) => {
    const price = calculateV3Price(sqrtPriceX96, uniswapIsRDNTFirst);
    cachedUniswapPrice = price;
    swapEventTimestamps["Uniswap"] = Date.now();
    console.log(`🔄 [UniswapV3] Swap event at RDNT Price: ${price}`);
    checkArbitrage("Uniswap");
  });

  sushiswapV2Pool.on("Swap", async () => {
    try {
      const reserves = await sushiswapV2Pool.getReserves();
      const price = calculateV2Price(reserves, sushiswapIsRDNTFirst);
      cachedSushiSwapPrice = price;
      swapEventTimestamps["SushiSwap"] = Date.now();
      console.log(`🔄 [SushiSwapV2] Swap event updated RDNT Price: ${price}`);
      checkArbitrage("SushiSwap");
    } catch (error) {
      console.error("Error updating SushiSwap V2 price from event:", error.message);
    }
  });
};

/** Calculate loan amount in WETH based on USD value */
const calculateLoanAmount = () => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price not available for loan calculation");
    throw new Error("WETH/USD price not available");
  }
  const loanAmountWethFloat = BORROW_VALUE_USD / cachedWethUsdPrice;
  const loanAmountWethStr = loanAmountWethFloat.toFixed(18);
  const loanAmount = ethers.parseUnits(loanAmountWethStr, 18);
  const loanAmountUSD = loanAmountWethFloat * cachedWethUsdPrice;
  console.log(`Calculated loan amount: ${ethers.formatUnits(loanAmount, 18)} WETH (≈$${loanAmountUSD.toFixed(2)} USD)`);
  return loanAmount;
};

/** Check for arbitrage opportunities */
const checkArbitrage = (dex) => {
  if (shouldStop) {
    console.log("Bot stopped due to stop loss condition.");
    return;
  }

  if (arbitrageCount >= MAX_ARBITRAGE_TRANSACTIONS) {
    console.log(`Bot stopped: Reached maximum arbitrage transactions (${MAX_ARBITRAGE_TRANSACTIONS}).`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    sushiswapV2Pool.removeAllListeners("Swap");
    wsProvider.websocket.close();
    return;
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
    fetchAndLogPrices("opportunity_detected");
    setTimeout(() => fetchAndLogPrices("2s_after_opportunity"), 2000);

    if (arbOpportunityStartTime === null) {
      arbOpportunityStartTime = Date.now();
      console.log(`📈 Arbitrage opportunity started at ${arbOpportunityStartTime}`);
    }
    arbitrageCount++;
    console.log(`🚨 Arbitrage #${arbitrageCount}: Price diff ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)})`);
    console.log(`Uniswap: 1 RDNT = ${cachedUniswapPrice} WETH (≈$${(cachedUniswapPrice * cachedWethUsdPrice).toFixed(6)} USD)`);
    console.log(`SushiSwap: 1 RDNT = ${cachedSushiSwapPrice} WETH (≈$${(cachedSushiSwapPrice * cachedWethUsdPrice).toFixed(6)} USD)`);
    const direction = cachedSushiSwapPrice > cachedUniswapPrice;
    console.log(`Direction: ${direction ? "Uniswap -> SushiSwap" : "SushiSwap -> Uniswap"}`);
    executePresignedArbitrage(direction, swapEventTimestamps[dex] || Date.now());
  } else {
    if (arbOpportunityStartTime !== null) {
      const vanishTime = Date.now() - arbOpportunityStartTime;
      console.log(`😟 Arbitrage vanished after ${vanishTime} ms.`);
      fs.appendFileSync("logs/time.txt", `Opportunity lasted: ${vanishTime} ms, pricediff: ${priceDiff.toFixed(10)}\n`);
      arbOpportunityStartTime = null;
    }
    console.log(`ℹ️ No arbitrage. Price diff: ${priceDiff.toFixed(10)} (Highest: ${highestPriceDiff.toFixed(10)}) | Count: ${arbitrageCount}`);
  }
};

/** Log transaction details to p&l.txt with USD values */
const logTransactionDetails = (serial, txHash, direction, loanAmount, profitInWETH, gasCostInWETH, swapFeeUniswap, swapFeeSushiSwap, netPnL, cumulativePnL, txStatus, error = null) => {
  const timestamp = new Date().toISOString();
  const statusText = txStatus === 1 ? "Success" : "Failed";
  const errorMessage = error ? `\nError: ${error}` : '';
  const loanAmountUSD = Number(ethers.formatUnits(loanAmount, 18)) * cachedWethUsdPrice;
  const profitUSD = profitInWETH * cachedWethUsdPrice;
  const gasCostUSD = gasCostInWETH * cachedWethUsdPrice;
  const swapFeeUniswapUSD = swapFeeUniswap * cachedWethUsdPrice;
  const swapFeeSushiSwapUSD = swapFeeSushiSwap * cachedWethUsdPrice;
  const netPnLUSD = netPnL * cachedWethUsdPrice;
  const cumulativePnLUSD = cumulativePnL * cachedWethUsdPrice;

  const logMessage = `
Timestamp: ${timestamp}
Transaction #${serial}
Status: ${statusText}
Transaction Hash: ${txHash || 'N/A'}
Direction: ${direction ? "Uniswap -> SushiSwap" : "SushiSwap -> Uniswap"}
Loan Amount: ${ethers.formatUnits(loanAmount, 18)} WETH (≈$${loanAmountUSD.toFixed(2)} USD)
Profit (before gas and swap fees): ${profitInWETH.toFixed(18)} WETH (≈$${profitUSD.toFixed(2)} USD)
Gas Cost: ${gasCostInWETH.toFixed(18)} WETH (≈$${gasCostUSD.toFixed(2)} USD)
Uniswap V3 Swap Fee: ${swapFeeUniswap.toFixed(18)} WETH (≈$${swapFeeUniswapUSD.toFixed(2)} USD)
SushiSwap V2 Swap Fee: ${swapFeeSushiSwap.toFixed(18)} WETH (≈$${swapFeeSushiSwapUSD.toFixed(2)} USD)
Net PnL: ${netPnL.toFixed(18)} WETH (≈$${netPnLUSD.toFixed(2)} USD)
Cumulative PnL: ${cumulativePnL.toFixed(18)} WETH (≈$${cumulativePnLUSD.toFixed(2)} USD)${errorMessage}
--------------------------------------------------
`;
  fs.appendFileSync("logs/p&l.txt", logMessage);
};

/** Execute arbitrage transaction with detailed timing measurements and presigning */
const executePresignedArbitrage = async (direction, startTime) => {
  executingTransactions++;
  console.log(`Transaction started. Executing transactions: ${executingTransactions}`);
  let loanAmount;

  try {
    const detectionTime = Date.now();
    console.log("Starting arbitrage execution for transaction #" + arbitrageCount);

    try {
      loanAmount = calculateLoanAmount();
    } catch (error) {
      console.error("Loan amount calculation failed:", error.message);
      throw error;
    }
    const loanCalcTime = Date.now();

    const loanAmountWethFloat = Number(ethers.formatUnits(loanAmount, 18));

    // Calculate total debt including premium
    const premiumRate = Number(cachedFlashloanPremium) / 10000;
    const totalDebtFloat = loanAmountWethFloat * (1 + premiumRate);

    // Set minAmountOut1 and minAmountOut2 to 0 for testing purposes
    const minAmountOut1 = 0n;
    const minAmountOut2 = 0n;

    console.log(`minAmountOut1: ${ethers.formatUnits(minAmountOut1, 18)} RDNT (accept any)`);
    console.log(`minAmountOut2: ${ethers.formatUnits(minAmountOut2, 18)} WETH (accept any)`);
    console.log(`Total debt: ${totalDebtFloat.toFixed(18)} WETH`);

    const deadline = Math.floor(Date.now() / 1000) + 45;
    const feeFirst = cachedUniswapFee;
    const feeSecond = cachedUniswapFee;

    let txData;
    try {
      txData = flashLoanArbitrage.interface.encodeFunctionData(
        "executeArbitrage",
        [WETH_ADDRESS, loanAmount, direction, minAmountOut1, minAmountOut2, deadline, feeFirst, feeSecond]
      );
      console.log(`Encoded tx data: ${txData}`);
    } catch (error) {
      console.error("Failed to encode transaction data:", error.message);
      throw error;
    }
    const encodeTime = Date.now();

    let nonce = currentNonce;
    console.log(`Using cached nonce: ${nonce}`);

    const fetchedFeeData = cachedFeeData;
    if (!fetchedFeeData) {
      console.error("Fee data unavailable");
      throw new Error("Fee data unavailable");
    }
    const baseFeePerGas = fetchedFeeData.lastBaseFeePerGas || fetchedFeeData.gasPrice;
    const suggestedMaxPriorityFeePerGas = fetchedFeeData.maxPriorityFeePerGas || fetchedFeeData.gasPrice;
    const reasonableTip = suggestedMaxPriorityFeePerGas * 2n;
    const buffer = ethers.parseUnits("0.1", "gwei");
    let maxFeePerGas = baseFeePerGas + reasonableTip + buffer;
    const suggestedMaxFeePerGas = fetchedFeeData.maxFeePerGas || (baseFeePerGas + suggestedMaxPriorityFeePerGas);
    if (maxFeePerGas < suggestedMaxFeePerGas) maxFeePerGas = suggestedMaxFeePerGas;

    console.log(`Priority Fee: ${ethers.formatUnits(reasonableTip, "gwei")} Gwei`);
    console.log(`Max Fee Per Gas: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);

    const tx = {
      to: FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      data: txData,
      nonce: nonce,
      chainId: 42161n,
      type: 2,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: reasonableTip,
      gasLimit: 1000000n
    };

    console.log("Transaction object prepared:", JSON.stringify(tx, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value, 2));

    let signedTx;
    try {
      signedTx = await signer.signTransaction(tx);
      console.log(`Signed Transaction: ${signedTx}`);
    } catch (signError) {
      console.error("Failed to sign transaction:", signError.message);
      throw new Error(`Signing failed: ${signError.message}`);
    }
    const signTime = Date.now();

    let txHash;
    try {
      txHash = await httpProvider.send("eth_sendRawTransaction", [signedTx]);
      if (!txHash || !txHash.startsWith("0x")) {
        console.error("Invalid transaction hash received:", txHash);
        throw new Error(`Invalid transaction hash: ${txHash}`);
      }
      console.log(`⚡ TX Sent: ${txHash}`);
      currentNonce++;
    } catch (sendError) {
      console.error("Failed to send transaction:", sendError.message);
      if (sendError.message.includes("nonce")) {
        currentNonce = await signer.provider.getTransactionCount(signer.address, "pending");
        console.log(`Resynced nonce: ${currentNonce}`);
      }
      throw new Error(`Transaction submission failed: ${sendError.message}`);
    }
    const sendTime = Date.now();

    let receipt;
    try {
      receipt = await httpProvider.waitForTransaction(txHash);
      if (!receipt) {
        console.error("Transaction receipt is null for hash:", txHash);
        throw new Error("No receipt received");
      }
      console.log(`Transaction receipt received - Status: ${receipt.status}`);
    } catch (waitError) {
      console.error("Failed to wait for transaction confirmation:", waitError.message);
      throw new Error(`Confirmation wait failed: ${waitError.message}`);
    }
    const confirmTime = Date.now();

    const loanCalcDuration = loanCalcTime - detectionTime;
    const encodeDuration = encodeTime - loanCalcTime;
    const prepDuration = signTime - encodeTime;
    const signDuration = sendTime - signTime;
    const confirmDuration = confirmTime - sendTime;
    const totalDuration = confirmTime - detectionTime;

    const timingLog = `Arbitrage #${arbitrageCount} timings:
- Detection to loan calculation: ${loanCalcDuration} ms
- Loan calculation to encoding: ${encodeDuration} ms
- Encoding to signing: ${prepDuration} ms
- Signing to submission: ${signDuration} ms
- Submission to confirmation: ${confirmDuration} ms
- Total from detection to confirmation: ${totalDuration} ms
`;
    console.log(timingLog);
    fs.appendFileSync("logs/timings.txt", timingLog + "\n");

    if (receipt) {
      console.log(`📜 Transaction logs for TX: ${receipt.transactionHash || 'unknown'}`);
      console.log("Number of logs:", receipt.logs.length);

      if (receipt.logs.length === 0) {
        console.log("No logs emitted before revert.");
      } else {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            console.log(`Event: ${parsedLog.name}`);
            parsedLog.fragment.inputs.forEach((input, index) => {
              const argName = input.name || `arg${index}`;
              let argValue = parsedLog.args[index];
              argValue = typeof argValue === 'bigint' ? argValue.toString() : argValue.toString();
              console.log(`  ${argName}: ${argValue}`);
            });
          } catch (e) {
            console.log("Log skipped (not from contract):", log);
          }
        }
      }

      let profitInWETH = 0;
      let success = false;
      if (receipt.status === 1) {
        for (const log of receipt.logs) {
          try {
            const parsedLog = flashLoanArbitrage.interface.parseLog(log);
            if (parsedLog.name === "ArbitrageExecuted") {
              profitInWETH = Number(ethers.formatUnits(parsedLog.args.profit, 18));
              success = parsedLog.args.success;
              console.log(`ArbitrageExecuted event - Profit: ${profitInWETH} WETH, Success: ${success}`);
              if (success) break;
            }
          } catch (e) {
            // Skip non-matching logs
          }
        }
      } else {
        console.log(`Transaction failed with status: ${receipt.status}`);
      }

      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice || cachedFeeData.gasPrice;
      const gasCostInWei = gasUsed * effectiveGasPrice;
      const gasCostInWETH = Number(ethers.formatUnits(gasCostInWei, 18));

      const swapFeeUniswap = loanAmountWethFloat * (Number(cachedUniswapFee) / 1e6);
      const swapFeeSushiSwap = loanAmountWethFloat * (Number(cachedSushiSwapFee) / 1e6);

      const netPnL = profitInWETH - gasCostInWETH;
      cumulativePnLInWETH += netPnL;

      logTransactionDetails(
        arbitrageCount,
        receipt.transactionHash,
        direction,
        loanAmount,
        profitInWETH,
        gasCostInWETH,
        swapFeeUniswap,
        swapFeeSushiSwap,
        netPnL,
        cumulativePnLInWETH,
        receipt.status
      );
      checkStopCondition();
    }

  } catch (error) {
    console.error("Execution failed for transaction #" + arbitrageCount + ":", error.message);
    const timestamp = new Date().toISOString();
    const logMessage = `
Timestamp: ${timestamp}
Transaction #${arbitrageCount}
Status: Failed to send
Error: ${error.message}
--------------------------------------------------
`;
    fs.appendFileSync("logs/p&l.txt", logMessage);
    logTransactionDetails(
      arbitrageCount,
      null,
      direction,
      loanAmount || 0n,
      0,
      0,
      0,
      0,
      0,
      cumulativePnLInWETH,
      0,
      error.message
    );
  } finally {
    executingTransactions--;
    console.log(`Transaction completed. Executing transactions: ${executingTransactions}`);
    if (executingTransactions === 0) {
      checkArbitrage("PostTransaction");
    }
  }
};

/** Check stop-loss condition dynamically */
const checkStopCondition = () => {
  if (cachedWethUsdPrice === 0) {
    console.error("WETH/USD price is zero, cannot check stop condition");
    return;
  }
  const stopLossWeth = STOP_LOSS_USD / cachedWethUsdPrice;
  if (cumulativePnLInWETH <= -stopLossWeth) {
    console.log(`Net PnL ${cumulativePnLInWETH} WETH (≈$${cumulativePnLInWETH * cachedWethUsdPrice} USD) ≤ -${stopLossWeth} WETH (≈$${STOP_LOSS_USD} USD). Stopping bot.`);
    shouldStop = true;
    uniswapV3Pool.removeAllListeners("Swap");
    sushiswapV2Pool.removeAllListeners("Swap");
    wsProvider.websocket.close();
  }
};

// ### Initialization
(async () => {
  try {
    httpProvider = new ethers.JsonRpcProvider(process.env.ARBITRUM_HTTP_RPC_URL);
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, httpProvider);
    console.log("Signer address:", signer.address);
    currentNonce = await signer.provider.getTransactionCount(signer.address, "pending");
    console.log(`Initialized nonce: ${currentNonce}`);

    flashLoanArbitrage = new ethers.Contract(
      FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS,
      FLASHLOAN_ARBITRAGE_ABI,
      signer
    );
    console.log("Flashloan contract initialized at:", FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS);

    await connectWebSocket();
  } catch (error) {
    console.error("Initialization failed:", error.message);
  }
})().catch(console.error);