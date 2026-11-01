const { ethers } = require("ethers");
const hre = require("hardhat");
require("dotenv").config();

// Constants
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
const USDC_ADDRESS = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"; // USDC on Arbitrum
const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory
const ROUTER_ADDRESS = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // Universal Router
const FEE = 500; // 0.05% fee tier
const PATTERN1 = "82af49447d8a07e3bd95bd0d56f35241523fbab10001f4ff970a61a04b1ca14834a43f5de4533ebddb5cc8"; // WETH → USDC path
const PATTERN2 = "ff970a61a04b1ca14834a43f5de4533ebddb5cc80001f482af49447d8a07e3bd95bd0d56f35241523fbab1"; // USDC → WETH path

// Contract ABIs
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const ROUTER_ABI = [
  "function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable",
];

// Initialize Provider
function initializeProvider() {
  const provider = new ethers.JsonRpcProvider(
    `https://arb-mainnet.g.alchemy.com/v2/TLXJHWufU3J51tQl4mOxpVTyKSLOVOA7`
  );
  return provider;
}

// Get Pool Address
async function getPoolAddress(provider) {
  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(WETH_ADDRESS, USDC_ADDRESS, FEE);
  if (poolAddress === ethers.ZeroAddress) {
    throw new Error("WETH/USDC pool with fee 500 does not exist on Arbitrum");
  }
  console.log(`Uniswap V3 WETH/USDC Pool Address: ${poolAddress}`);
  return poolAddress;
}

// Get Current Pool Price
async function getCurrentPrice(pool) {
  const slot0 = await pool.slot0();
  const sqrtPriceX96 = slot0.sqrtPriceX96;
  // Price = (sqrtPriceX96^2 * 10^6) / 2^192 (adjusting for USDC decimals = 6, WETH = 18)
  const price = (sqrtPriceX96 * sqrtPriceX96 * BigInt(10**6)) / (BigInt(2)**192n);
  return Number(price) / 10**6; // Convert to WETH/USDC price
}

// Decode and Process Pending Transaction
async function processPendingTransaction(txHash, provider, cumulativeReserves, initialPrice) {
  const tx = await provider.getTransaction(txHash);
  if (!tx || !tx.to || tx.to.toLowerCase() !== ROUTER_ADDRESS.toLowerCase()) return null;

  const dataLower = tx.data.toLowerCase();
  let swapDirection = null;
  if (dataLower.includes(PATTERN1)) {
    swapDirection = "WETH → USDC";
  } else if (dataLower.includes(PATTERN2)) {
    swapDirection = "USDC → WETH";
  } else {
    return null; // Not a WETH/USDC swap
  }

  // Decode the execute function
  const iface = new ethers.Interface(ROUTER_ABI);
  const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });
  const commands = decoded.args.commands;
  const inputs = decoded.args.inputs;

  const V3_SWAP_EXACT_IN = "0x00"; // Command for exact input swap
  const commandsHex = ethers.hexlify(commands);
  if (!commandsHex.includes(V3_SWAP_EXACT_IN)) return null;

  let amountIn, amountOutMin;
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].toString(16) === "0") { // V3_SWAP_EXACT_IN
      const input = inputs[i];
      const [recipient, _amountIn, _amountOutMin, path, payerIsUser] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "uint256", "uint256", "bytes", "bool"],
        input
      );
      amountIn = _amountIn;
      amountOutMin = _amountOutMin;
    }
  }

  // Update cumulative reserves (in wei)
  if (swapDirection === "WETH → USDC") {
    cumulativeReserves.weth -= amountIn;
    cumulativeReserves.usdc += amountOutMin;
  } else {
    cumulativeReserves.weth += amountOutMin;
    cumulativeReserves.usdc -= amountIn;
  }

  // Estimate new price (simplified: reserves ratio)
  const wethReserve = Number(cumulativeReserves.weth) / 10**18; // WETH decimals
  const usdcReserve = Number(cumulativeReserves.usdc) / 10**6;  // USDC decimals
  const estimatedPrice = usdcReserve / wethReserve;

  return {
    txHash,
    swapDirection,
    amountIn: Number(amountIn) / (swapDirection === "WETH → USDC" ? 10**18 : 10**6),
    amountOutMin: Number(amountOutMin) / (swapDirection === "WETH → USDC" ? 10**6 : 10**18),
    estimatedPrice,
    priceChange: Math.abs(estimatedPrice - initialPrice) / initialPrice * 100
  };
}

// Poll for Pending Transactions
async function pollForPendingTransactions(provider, pool, poolAddress) {
  let initialReserves = { weth: BigInt(10**18 * 1000), usdc: BigInt(10**6 * 2000000) }; // Example: 1000 WETH, 2M USDC
  const initialPrice = await getCurrentPrice(pool);
  console.log(`Initial Pool Price (WETH/USDC): ${initialPrice}`);

  const externalPrice = 2000; // Hypothetical external price (e.g., from another exchange)
  const arbitrageThreshold = 0.6; // 1% price difference

  setInterval(async () => {
    try {
      const block = await provider.getBlock("pending");
      console.log(`\nFetched block with transactions: ${block.transactions.length}`);
      if (!block || !block.transactions) return;

      let cumulativeReserves = { ...initialReserves };
      let arbitrageDetected = false;

      for (let i = 0; i < block.transactions.length; i++) {
        const txHash = block.transactions[i];
        const result = await processPendingTransaction(txHash, provider, cumulativeReserves, initialPrice);

        if (result) {
          console.log(`\nTransaction ${i + 1}: ${result.txHash}`);
          console.log(`Swap Direction: ${result.swapDirection}`);
          console.log(`Amount In: ${result.amountIn} ${result.swapDirection.split(" → ")[0]}`);
          console.log(`Amount Out Min: ${result.amountOutMin} ${result.swapDirection.split(" → ")[1]}`);
          console.log(`Estimated Pool Price: ${result.estimatedPrice.toFixed(6)}`);
          console.log(`Price Change: ${result.priceChange.toFixed(2)}%`);

          // Check for arbitrage opportunity
          const priceDiff = Math.abs(result.estimatedPrice - externalPrice) / externalPrice * 100;
          if (priceDiff > arbitrageThreshold) {
            console.log(`*** Arbitrage Opportunity Detected ***`);
            console.log(`Estimated Price: ${result.estimatedPrice.toFixed(6)}`);
            console.log(`External Price: ${externalPrice}`);
            console.log(`Price Difference: ${priceDiff.toFixed(2)}%`);
            arbitrageDetected = true;
            break; // Stop after detecting the first arbitrage opportunity
          }
        }
      }

      if (!arbitrageDetected) {
        console.log("No significant arbitrage opportunities detected in this block.");
      }
    } catch (error) {
      console.error(`Polling Error: ${error.message}`);
    }
  }, 5000); // Poll every 2 seconds to avoid rate limits
}

// Main Function
async function main() {
  try {
    const provider = initializeProvider();
    await provider.ready;
    console.log("Connected to Arbitrum via Alchemy");

    const poolAddress = await getPoolAddress(provider);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    console.log("Polling for pending transactions to Uniswap V3 WETH/USDC pool...");
    await pollForPendingTransactions(provider, pool, poolAddress);

    process.on("SIGINT", () => {
      console.log("\nShutting down gracefully...");
      process.exit(0);
    });
  } catch (error) {
    console.error("Initialization Error:", error.message);
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  console.error("Unhandled Error:", error);
  process.exit(1);
});