// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Router02.sol";
import "hardhat/console.sol";

contract FlashLoanArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    IVault public immutable balancerVault;
    ISwapRouter public immutable uniswapV3Router;
    IUniswapV2Router02 public immutable sushiSwapRouter;
    ISwapRouter public immutable camelotRouter;
    IUniswapV2Router02 public immutable arbswapRouter;
    IUniswapV2Router02 public immutable arbidexRouter;
    ISwapRouter public immutable pancakeSwapV3Router; // Added PancakeSwap V3 Router

    address public immutable UNISWAP_V3_POOL_ADDRESS;
    address public immutable SUSHISWAP_V2_POOL_ADDRESS;
    address public immutable CAMELOT_V3_POOL_ADDRESS;
    address public immutable ARBSWAP_POOL_ADDRESS;
    address public immutable ARBIDEX_POOL_ADDRESS;
    address public immutable PANCAKESWAP_V3_POOL_ADDRESS; // Added PancakeSwap V3 Pool
    address public immutable tokenA; // TBTC
    address public immutable tokenB; // WBTC
    address public profitReceiver;

    enum DEXType { V3, V2 }

    event ArbitrageExecuted(uint256 profit, bool success);
    event FlashLoanRepaid(uint256 amountA);
    event ProfitSent(address indexed receiver, uint256 amountA, uint256 amountB);
    event SwapExecuted(address indexed dexRouter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(
        address _balancerVault,
        address _uniswapV3Router,
        address _sushiSwapRouter,
        address _camelotRouter,
        address _arbswapRouter,
        address _arbidexRouter,
        address _pancakeSwapV3Router, // Added parameter
        address _uniswapV3Pool,
        address _sushiSwapV2Pool,
        address _camelotV3Pool,
        address _arbswapPool,
        address _arbidexPool,
        address _pancakeSwapV3Pool, // Added parameter
        address _tokenA,
        address _tokenB,
        address _profitReceiver
    ) Ownable(_profitReceiver) {
        balancerVault = IVault(_balancerVault);
        uniswapV3Router = ISwapRouter(_uniswapV3Router);
        sushiSwapRouter = IUniswapV2Router02(_sushiSwapRouter);
        camelotRouter = ISwapRouter(_camelotRouter);
        arbswapRouter = IUniswapV2Router02(_arbswapRouter);
        arbidexRouter = IUniswapV2Router02(_arbidexRouter);
        pancakeSwapV3Router = ISwapRouter(_pancakeSwapV3Router); // Initialize new router
        UNISWAP_V3_POOL_ADDRESS = _uniswapV3Pool;
        SUSHISWAP_V2_POOL_ADDRESS = _sushiSwapV2Pool;
        CAMELOT_V3_POOL_ADDRESS = _camelotV3Pool;
        ARBSWAP_POOL_ADDRESS = _arbswapPool;
        ARBIDEX_POOL_ADDRESS = _arbidexPool;
        PANCAKESWAP_V3_POOL_ADDRESS = _pancakeSwapV3Pool; // Initialize new pool
        tokenA = _tokenA;
        tokenB = _tokenB;
        profitReceiver = _profitReceiver;
    }

    function executeArbitrage(
        address poolBuy,
        address poolSell,
        address token,
        uint256 amount,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 feeBuy,
        uint24 feeSell
    ) external onlyOwner nonReentrant {
        console.log(">>> executeArbitrage: Starting arbitrage process <<<");
        console.log(" - poolBuy: %s", poolBuy);
        console.log(" - poolSell: %s", poolSell);
        console.log(" - token: %s", token);
        console.log(" - amount: %s", amount);

        require(token == tokenA, "Invalid token");
        require(amount > 0, "Invalid amount");
        require(deadline > block.timestamp, "Deadline expired");

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        bytes memory userData = abi.encode(
            poolBuy,
            poolSell,
            minAmountOut1,
            minAmountOut2,
            deadline,
            feeBuy,
            feeSell,
            amount
        );

        console.log(" - Requesting flash loan: %s tokenA", amount);
        balancerVault.flashLoan(this, tokens, amounts, userData);
        console.log(">>> executeArbitrage: Flash loan request sent <<<");
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(balancerVault), "Unauthorized caller");
        require(tokens.length == 1 && address(tokens[0]) == tokenA, "Invalid tokens");

        console.log(">>> receiveFlashLoan: Flash loan received <<<");
        console.log(" - tokenA borrowed: %s", amounts[0]);
        console.log(" - feeA: %s", feeAmounts[0]);

        (
            address poolBuy,
            address poolSell,
            uint256 minAmountOut1,
            uint256 minAmountOut2,
            uint256 deadline,
            uint24 feeBuy,
            uint24 feeSell,
            uint256 amount
        ) = abi.decode(userData, (address, address, uint256, uint256, uint256, uint24, uint24, uint256));

        executeArbitrageTrade(poolBuy, poolSell, amount, minAmountOut1, minAmountOut2, deadline, feeBuy, feeSell);

        uint256 repayAmountA = amounts[0] + feeAmounts[0];
        console.log(" - Repayment amount for tokenA: %s", repayAmountA);

        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        console.log(" - Current balance of tokenA: %s", balanceA);
        require(balanceA >= repayAmountA, "Insufficient balance to repay loan");

        tokens[0].transfer(address(balancerVault), repayAmountA);
        console.log(" - Repaid %s tokenA to Balancer Vault", repayAmountA);
        emit FlashLoanRepaid(repayAmountA);

        uint256 profit = balanceA > repayAmountA ? balanceA - repayAmountA : 0;
        console.log(" - Calculated profit: %s tokenA", profit);
        emit ArbitrageExecuted(profit, profit > 0);

        if (profit > 0) {
            IERC20(tokenA).transfer(profitReceiver, profit);
            console.log(" - Sent %s tokenA to profit receiver: %s", profit, profitReceiver);
            emit ProfitSent(profitReceiver, profit, 0);
        }

        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));
        if (balanceB > 0) {
            IERC20(tokenB).transfer(profitReceiver, balanceB);
            console.log(" - Sent %s tokenB to profit receiver: %s", balanceB, profitReceiver);
            emit ProfitSent(profitReceiver, 0, balanceB);
        }

        console.log(">>> receiveFlashLoan: Flash loan process completed <<<");
    }

    function executeArbitrageTrade(
        address poolBuy,
        address poolSell,
        uint256 amountIn,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 feeBuy,
        uint24 feeSell
    ) internal {
        console.log(">>> executeArbitrageTrade: Starting arbitrage <<<");
        console.log(" - poolBuy: %s", poolBuy);
        console.log(" - poolSell: %s", poolSell);
        console.log(" - amountIn: %s", amountIn);

        (address routerBuy, DEXType dexTypeBuy) = getRouterAndType(poolBuy);
        (address routerSell, DEXType dexTypeSell) = getRouterAndType(poolSell);

        uint256 amountOut1;
        if (dexTypeBuy == DEXType.V3) {
            checkAndApprove(tokenA, routerBuy, amountIn, "V3 Router for tokenA");
            amountOut1 = swapV3(routerBuy, tokenA, tokenB, amountIn, feeBuy, deadline, minAmountOut1);
        } else {
            checkAndApprove(tokenA, routerBuy, amountIn, "V2 Router for tokenA");
            amountOut1 = swapV2(routerBuy, tokenA, tokenB, amountIn, minAmountOut1, deadline);
        }

        uint256 amountOut2;
        if (dexTypeSell == DEXType.V3) {
            checkAndApprove(tokenB, routerSell, amountOut1, "V3 Router for tokenB");
            amountOut2 = swapV3(routerSell, tokenB, tokenA, amountOut1, feeSell, deadline, minAmountOut2);
        } else {
            checkAndApprove(tokenB, routerSell, amountOut1, "V2 Router for tokenB");
            amountOut2 = swapV2(routerSell, tokenB, tokenA, amountOut1, minAmountOut2, deadline);
        }

        console.log(" - Arbitrage result: started with %s tokenA, ended with %s tokenA", amountIn, amountOut2);
        console.log(">>> executeArbitrageTrade: Completed <<<");
    }

    function swapV3(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint256 deadline,
        uint256 amountOutMin
    ) internal returns (uint256 amountOut) {
        console.log(">>> swapV3: Starting swap <<<");
        ISwapRouter swapRouter = ISwapRouter(router);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });

        try swapRouter.exactInputSingle(params) returns (uint256 _amountOut) {
            amountOut = _amountOut;
            console.log(" - Swap completed, received: %s", amountOut);
        } catch Error(string memory reason) {
            revert(string(abi.encodePacked("SwapV3 failed: ", reason)));
        } catch {
            revert("SwapV3: Unknown error during swap");
        }

        emit SwapExecuted(router, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        console.log(">>> swapV2: Starting swap <<<");
        IUniswapV2Router02 swapRouter = IUniswapV2Router02(router);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint[] memory amounts = swapRouter.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );
        amountOut = amounts[1];
        console.log(" - Swap completed, received: %s", amountOut);
        emit SwapExecuted(router, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function getRouterAndType(address pool) internal view returns (address router, DEXType dexType) {
        if (pool == UNISWAP_V3_POOL_ADDRESS) {
            return (address(uniswapV3Router), DEXType.V3);
        } else if (pool == CAMELOT_V3_POOL_ADDRESS) {
            return (address(camelotRouter), DEXType.V3);
        } else if (pool == PANCAKESWAP_V3_POOL_ADDRESS) { // Added PancakeSwap V3
            return (address(pancakeSwapV3Router), DEXType.V3);
        } else if (pool == SUSHISWAP_V2_POOL_ADDRESS) {
            return (address(sushiSwapRouter), DEXType.V2);
        } else if (pool == ARBSWAP_POOL_ADDRESS) {
            return (address(arbswapRouter), DEXType.V2);
        } else if (pool == ARBIDEX_POOL_ADDRESS) {
            return (address(arbidexRouter), DEXType.V2);
        } else {
            revert("Unknown pool");
        }
    }

    function checkAndApprove(address token, address spender, uint256 amount, string memory logLabel) internal {
        uint256 allowance = IERC20(token).allowance(address(this), spender);
        console.log(" - Checking allowance for %s at %s: %s", logLabel, spender, allowance);
        if (allowance < amount) {
            console.log(" - Approving %s for %s", spender, amount);
            IERC20(token).approve(spender, type(uint256).max);
        }
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        console.log(">>> withdraw: Withdrawing %s of token %s <<<", amount, token);
        IERC20(token).transfer(msg.sender, amount);
    }

    function setProfitReceiver(address _newReceiver) external onlyOwner {
        require(_newReceiver != address(0), "Invalid address");
        console.log(">>> setProfitReceiver: Updating to %s <<<", _newReceiver);
        profitReceiver = _newReceiver;
    }

    receive() external payable {
        console.log(">>> receive: Received %s wei <<<", msg.value);
    }
}