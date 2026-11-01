const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with the deployer account:", deployer.address);

  // Deploy WETH contract
  const WETH = await hre.ethers.getContractFactory("WETH");
  const weth = await WETH.deploy("Wrapped Ether", "WETH"); // Provide constructor arguments if any
  await weth.waitForDeployment(); // Corrected function
  console.log("WETH deployed at:", weth.target);

  // Deploy USDC contract
  const USDC = await hre.ethers.getContractFactory("WETH"); // Replace this with a proper USDC contract if applicable
  const usdc = await USDC.deploy("USD Coin", "USDC"); // Provide constructor arguments if any
  await usdc.waitForDeployment(); // Corrected function
  console.log("USDC deployed at:", usdc.target);

  // Optionally fund your deployer with tokens for testing
  const wethAmount = hre.ethers.parseEther("1000"); // 1000 WETH
  const usdcAmount = hre.ethers.parseUnits("1000000", 6); // 1,000,000 USDC
  await weth.transfer(deployer.address, wethAmount);
  await usdc.transfer(deployer.address, usdcAmount);

  console.log("Tokens deployed and funded to deployer account.");
}

main().catch((error) => {
  console.error("Error deploying tokens:", error.message);
  process.exitCode = 1;
});