const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// Mock contract deployment script for simulation
async function main() {
  console.log("Deploying mock contracts for simulation...");

  // Deploy mock tokens
  const TokenA = await ethers.getContractFactory("ERC20Mock");
  const tokenA = await TokenA.deploy("Mock Token A", "MTA", "1000000000000000000000000"); // 1 million tokens with 18 decimals
  await tokenA.waitForDeployment();
  console.log("Token A deployed to:", tokenA.address);

  const TokenB = await ethers.getContractFactory("ERC20Mock");
  const tokenB = await TokenB.deploy("Mock Token B", "MTB", "1000000000000000000000000"); // 1 million tokens with 18 decimals
  await tokenB.waitForDeployment();
  console.log("Token B deployed to:", tokenB.address);

  // Deploy mock Uniswap V3 Pool
  const UniswapV3Pool = await ethers.getContractFactory("UniswapV3PoolMock");
  const uniswapV3Pool = await UniswapV3Pool.deploy(tokenA.address, tokenB.address);
  await uniswapV3Pool.waitForDeployment();
  console.log("Uniswap V3 Pool deployed to:", uniswapV3Pool.address);

  // Deploy mock SushiSwap V2 Pool
  const SushiSwapV2Pool = await ethers.getContractFactory("UniswapV2PairMock");
  const sushiSwapV2Pool = await SushiSwapV2Pool.deploy(tokenA.address, tokenB.address);
  await sushiSwapV2Pool.waitForDeployment();
  console.log("SushiSwap V2 Pool deployed to:", sushiSwapV2Pool.address);

  // Deploy mock Balancer Vault
  const BalancerVault = await ethers.getContractFactory("BalancerVaultMock");
  const balancerVault = await BalancerVault.deploy();
  await balancerVault.waitForDeployment();
  console.log("Balancer Vault deployed to:", balancerVault.address);

  // Deploy mock Chainlink Oracle
  const ChainlinkOracle = await ethers.getContractFactory("ChainlinkOracleMock");
  const chainlinkOracle = await ChainlinkOracle.deploy();
  await chainlinkOracle.waitForDeployment();
  console.log("Chainlink Oracle deployed to:", chainlinkOracle.address);

  // Deploy FlashLoanArbitrage contract with mock addresses
  const FlashLoanArbitrage = await ethers.getContractFactory("FlashLoanArbitrage");
  const flashLoanArbitrage = await FlashLoanArbitrage.deploy(
    balancerVault.address,
    "0x0000000000000000000000000000000000000000", // Mock Uniswap V3 Router
    "0x0000000000000000000000000000000000000000", // Mock SushiSwap Router
    "0x0000000000000000000000000000000000000000", // Mock SushiSwap Factory
    uniswapV3Pool.address,
    tokenA.address,
    tokenB.address,
    "0x0000000000000000000000000000000000000000" // Mock Profit Receiver
  );
  await flashLoanArbitrage.waitForDeployment();
  console.log("FlashLoanArbitrage deployed to:", flashLoanArbitrage.address);

  // Save addresses to a config file for the simulation script
  const config = {
    TOKEN_A_ADDRESS: tokenA.address,
    TOKEN_B_ADDRESS: tokenB.address,
    UNISWAP_V3_POOL_ADDRESS: uniswapV3Pool.address,
    SUSHISWAP_V2_POOL_ADDRESS: sushiSwapV2Pool.address,
    FLASHLOAN_ARBITRAGE_CONTRACT_ADDRESS: flashLoanArbitrage.address,
    CHAINLINK_TOKEN_B_USD_ADDRESS: chainlinkOracle.address,
    BALANCER_VAULT_ADDRESS: balancerVault.address
  };

  fs.writeFileSync("./scripts/mock-config.json", JSON.stringify(config, null, 2));
  console.log("Mock configuration saved to mock-config.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
