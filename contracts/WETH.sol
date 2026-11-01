// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WETH is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        // Optionally mint some initial supply to the deployer
        _mint(msg.sender, 1000000 * (10 ** decimals())); // 1,000,000 tokens
    }
}
