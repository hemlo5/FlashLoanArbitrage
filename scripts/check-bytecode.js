const hre = require("hardhat");

async function main() {
  const contractAddress = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";  // Replace this with the actual contract address

  // Fetch the bytecode of the contract
  const bytecode = await hre.ethers.provider.getCode(contractAddress);

  // Output the bytecode to the terminal
  console.log(`Bytecode at ${contractAddress}:`, bytecode);
}

main().catch((error) => {
  console.error("Error fetching bytecode:", error.message);
  process.exitCode = 1;
});