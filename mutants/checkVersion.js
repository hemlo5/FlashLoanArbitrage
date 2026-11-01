import fetch from "node-fetch"; // Only if using CommonJS (not needed for ES Modules)
const { ethers } = hre;

async function main() {
  // Output the version of Hardhat
  console.log("Hardhat version:", hre.config.solidity.version);

  // Output the version of ethers.js
  console.log("Ethers version:", ethers.version);

  // Output the version of the @nomicfoundation/hardhat-ethers plugin
  const hardhatEthersPlugin = require("@nomicfoundation/hardhat-ethers/package.json");
  console.log(
    "@nomicfoundation/hardhat-ethers version:",
    hardhatEthersPlugin.version
  );

  // Check other dependencies
  const packageJson = require("./package.json");
  console.log("Other dependencies:");
  Object.keys(packageJson.dependencies).forEach((dep) => {
    console.log(`${dep}: ${packageJson.dependencies[dep]}`);
  });
  Object.keys(packageJson.devDependencies).forEach((dep) => {
    console.log(`${dep}: ${packageJson.devDependencies[dep]}`);
  });
}

main().catch((error) => {
  console.error("Error in version check:", error.message);
  process.exitCode = 1;
});
