require("dotenv").config(); // Optional: for loading environment variables from .env
require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  solidity: {
    
    version: "0.8.20", // Compiler for your contract
      
    settings: {
      optimizer: {
        enabled: true, // Enable optimizer to reduce stack usage
        runs: 200 // Number of optimization runs; adjust as needed
      },
      viaIR: true // Enable IR compilation to handle complex contracts
    }
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.ARBITRUM_HTTP_RPC_URL || "https://arb-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY",
        blockNumber: 12345678, // Optional: Specify a block number for consistency
      },
      chainId: 42161, // Arbitrum Mainnet chain ID
      accounts: {
        mnemonic: process.env.MNEMONIC || "test test test test test test test test test test test junk",
      },
    },
    arbitrum: {
      url: process.env.ARBITRUM_HTTP_RPC_URL, // Public Arbitrum RPC URL
      accounts: [process.env.PRIVATE_KEY] // Load private key from .env
    }
    // Add other networks as needed
  },
  // Optional: Add Etherscan config for Arbiscan verification
  etherscan: {
    apiKey: {
      arbitrumOne: process.env.ARBISCAN_API_KEY // Add your Arbiscan API key in .env
    }
  }
};