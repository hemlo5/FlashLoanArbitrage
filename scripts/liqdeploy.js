const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  // Define contract addresses for Arbitrum
  const balancerVault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault
  const uniswapV3Router = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router
  const sushiSwapRouter = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // SushiSwap Router
  const sushiSwapFactory = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"; // SushiSwap Factory on Arbitrum
  const uniswapV3Pool = "0x446bf9748b4ea044dd759d9b9311c70491df8f29"; // Uniswap V3 RDNT/WETH Pool
  const tokenA = "0x3082cc23568ea640225c2467653db90e9250aaa0"; // RDNT
  const tokenB = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"; // WETH
  const profitReceiver = deployer.address;

  // Get the contract factory
  const FlashLoanArbitrage = await hre.ethers.getContractFactory("FlashLoanArbitrage");

  // Deploy the contract with the correct parameters
  const contract = await FlashLoanArbitrage.deploy(
    balancerVault,
    uniswapV3Router,
    sushiSwapRouter,
    sushiSwapFactory,
    uniswapV3Pool,
    tokenA,
    tokenB,
    profitReceiver
  );

  // Wait for the deployment to be mined
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