const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  // Define contract addresses for Arbitrum
  const balancerVault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault
  const uniswapV3Router = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router
  const sushiSwapRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router
  const camelotRouter = "0xc873fEcbd354f5A56E00E710B90EF4201db2448d"; // Camelot Router
  const arbswapRouter = "0xD01319f4b65b79124549dE409D36F25e04B3e551"; // Arbswap Router address
  const arbidexRouter = "0x7238FB45146BD8FcB2c463Dc119A53494be57Aac"; // Arbidex Router address
  const pancakeSwapV3Router = "0x1b81D678ffb9C0263b24A97847620C99d213eB14"; // PancakeSwap V3 Router
  const uniswapV3Pool = "0x2f5e87c9312fa29aed5c179e456625d79015299c"; // Uniswap V3 TBTC/WBTC pool
  const sushiSwapV2Pool = "0x515e252b2b5c22b4b2b6df66c2ebeea871aa4d69"; // SushiSwap V2 TBTC/WBTC pool
  const camelotV3Pool = "0xd845f7d4f4deb9ff5bcf09d140ef13718f6f6c71"; // Camelot V3 TBTC/WBTC pool
  const arbswapPool = "0x4832e0a194281d1ffE464C654E4E938f642DD362"; // Arbswap pool address
  const arbidexPool = "0x39511b74722afe77d532eb70632b4b59c559019b"; // Arbidex pool address
  const pancakeSwapV3Pool = "0x4bfc22a4da7f31f8a912a79a7e44a822398b4390"; // PancakeSwap V3 pool (Note: This is ARB/WETH, adjust if needed)
  const tokenA = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"; // TBTC
  const tokenB = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WBTC
  const profitReceiver = deployer.address;

  // Get the contract factory
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");

  // Deploy the contract
  const contract = await FlashLoanArbitrage.deploy(
    balancerVault,
    uniswapV3Router,
    sushiSwapRouter,
    camelotRouter,
    arbswapRouter,
    arbidexRouter,
    pancakeSwapV3Router, // Added PancakeSwap V3 Router
    uniswapV3Pool,
    sushiSwapV2Pool,
    camelotV3Pool,
    arbswapPool,
    arbidexPool,
    pancakeSwapV3Pool, // Added PancakeSwap V3 Pool
    tokenA,
    tokenB,
    profitReceiver
  );

  const txReceipt = await contract.deploymentTransaction().wait();
  if (txReceipt.status === 1) {
    console.log("FlashLoanArbitrage deployed to:", contract.target);
  } else {
    console.error("Deployment failed. Transaction receipt status:", txReceipt.status);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });