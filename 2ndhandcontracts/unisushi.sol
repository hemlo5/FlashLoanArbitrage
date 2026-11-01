// for normal uni sushi arbitrage
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Factory.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Router02.sol";
import "hardhat/console.sol";

contract FlashLoanArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    IVault public immutable balancerVault;
    ISwapRouter public immutable uniswapV3Router;
    IUniswapV2Router02 public immutable sushiSwapRouter;
    IUniswapV2Factory public immutable sushiSwapFactory;
    IUniswapV3Pool public immutable uniswapV3Pool;

    address public immutable tokenA; // ARB
    address public immutable tokenB; // WETH

    address public profitReceiver;

    event ArbitrageExecuted(uint256 profit, bool success);
    event FlashLoanRepaid(uint256 amountA);
    event ProfitSent(address indexed receiver, uint256 amountA, uint256 amountB);
    event SwapExecuted(address indexed dexRouter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(
        address _balancerVault,
        address _uniswapV3Router,
        address _sushiSwapRouter,
        address _sushiSwapFactory,
        address _uniswapV3Pool,
        address _tokenA,
        address _tokenB,
        address _profitReceiver
    ) Ownable(_profitReceiver) {
        balancerVault = IVault(_balancerVault);
        uniswapV3Router = ISwapRouter(_uniswapV3Router);
        sushiSwapRouter = IUniswapV2Router02(_sushiSwapRouter);
        sushiSwapFactory = IUniswapV2Factory(_sushiSwapFactory);
        uniswapV3Pool = IUniswapV3Pool(_uniswapV3Pool);
        tokenA = _tokenA;
        tokenB = _tokenB;
        profitReceiver = _profitReceiver;
    }

    function executeArbitrage(
        address token,
        uint256 amount,
        bool direction,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 fee1,
        uint24 fee2
    ) external onlyOwner nonReentrant {
        console.log(">>> executeArbitrage: Starting arbitrage process <<<");
        console.log(" - token: %s", token);
        console.log(" - amount: %s", amount);
        console.log(" - direction: %s (true: Sushi->Uni, false: Uni->Sushi)", direction);
        console.log(" - minAmountOut1: %s", minAmountOut1);
        console.log(" - minAmountOut2: %s", minAmountOut2);
        console.log(" - deadline: %s", deadline);
        console.log(" - fee1: %s", fee1);
        console.log(" - fee2: %s", fee2);

        require(token == tokenA, "Invalid token");
        require(amount > 0, "Invalid amount");
        require(deadline > block.timestamp, "Deadline expired");

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        bytes memory userData = abi.encode(
            direction,
            minAmountOut1,
            minAmountOut2,
            deadline,
            fee1,
            fee2,
            amount
        );

        console.log(" - Requesting flash loan: %s tokenA", amount);
        balancerVault.flashLoan(this, tokens, amounts, userData);
        console.log(">>> executeArbitrage: Flash loan request sent to Balancer <<<");
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
            bool direction,
            uint256 minAmountOut1,
            uint256 minAmountOut2,
            uint256 deadline,
            uint24 fee1,
            uint24 fee2,
            uint256 amount
        ) = abi.decode(userData, (bool, uint256, uint256, uint256, uint24, uint24, uint256));

        console.log(" - Decoded userData:");
        console.log("   - direction: %s", direction);
        console.log("   - minAmountOut1: %s", minAmountOut1);
        console.log("   - minAmountOut2: %s", minAmountOut2);
        console.log("   - deadline: %s", deadline);
        console.log("   - fee1: %s", fee1);
        console.log("   - fee2: %s", fee2);
        console.log("   - amount: %s", amount);

        uint24 feeUniswap = direction ? fee2 : fee1;

        executeArbitrageTrade(direction, amount, minAmountOut1, minAmountOut2, deadline, feeUniswap);

        uint256 repayAmountA = amounts[0] + feeAmounts[0];
        console.log(" - Calculated repayment amount for tokenA: %s", repayAmountA);

        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        console.log(" - Current balance of tokenA: %s", balanceA);
        require(balanceA >= repayAmountA, "Insufficient balance to repay loan");

        tokens[0].transfer(address(balancerVault), repayAmountA);
        console.log(" - Transferred %s tokenA to Balancer Vault for repayment", repayAmountA);
        emit FlashLoanRepaid(repayAmountA);

        uint256 profit = balanceA - repayAmountA;
        console.log(" - Calculated profit: %s tokenA", profit);
        emit ArbitrageExecuted(profit, true);

        if (profit > 0) {
            IERC20(tokenA).transfer(profitReceiver, profit);
            console.log(" - Sent %s tokenA to profit receiver: %s", profit, profitReceiver);
            emit ProfitSent(profitReceiver, profit, 0);
        }

        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));
        console.log(" - Current balance of tokenB: %s", balanceB);
        if (balanceB > 0) {
            IERC20(tokenB).transfer(profitReceiver, balanceB);
            console.log(" - Sent %s tokenB to profit receiver: %s", balanceB, profitReceiver);
            emit ProfitSent(profitReceiver, 0, balanceB);
        }

        console.log(">>> receiveFlashLoan: Flash loan process completed <<<");
    }

    function executeArbitrageTrade(
        bool direction,
        uint256 amountIn,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 feeUniswap
    ) internal {
        console.log(">>> executeArbitrageTrade: Starting arbitrage <<<");
        console.log(" - direction: %s", direction);
        console.log(" - amountIn: %s", amountIn);
        console.log(" - minAmountOut1: %s", minAmountOut1);
        console.log(" - minAmountOut2: %s", minAmountOut2);
        console.log(" - deadline: %s", deadline);
        console.log(" - feeUniswap: %s", feeUniswap);

        uint256 amountOut1;
        uint256 amountOut2;

        if (direction) {
            console.log(" - Direction: SushiSwap (TOKEN_A -> TOKEN_B) -> Uniswap V3 (TOKEN_B -> TOKEN_A)");
            checkAndApprove(tokenA, address(sushiSwapRouter), amountIn, "SushiSwap router for tokenA");
            amountOut1 = swapSushiV2(tokenA, tokenB, amountIn, minAmountOut1, deadline);
            console.log(" - Swapped %s tokenA for %s tokenB on SushiSwap", amountIn, amountOut1);
            checkAndApprove(tokenB, address(uniswapV3Router), amountOut1, "Uniswap V3 router for tokenB");
            amountOut2 = swapUniswapV3(tokenB, tokenA, amountOut1, feeUniswap, deadline, minAmountOut2);
            console.log(" - Swapped %s tokenB for %s tokenA on Uniswap V3", amountOut1, amountOut2);
        } else {
            console.log(" - Direction: Uniswap V3 (TOKEN_A -> TOKEN_B) -> SushiSwap (TOKEN_B -> TOKEN_A)");
            checkAndApprove(tokenA, address(uniswapV3Router), amountIn, "Uniswap V3 router for tokenA");
            amountOut1 = swapUniswapV3(tokenA, tokenB, amountIn, feeUniswap, deadline, minAmountOut1);
            console.log(" - Swapped %s tokenA for %s tokenB on Uniswap V3", amountIn, amountOut1);
            checkAndApprove(tokenB, address(sushiSwapRouter), amountOut1, "SushiSwap router for tokenB");
            amountOut2 = swapSushiV2(tokenB, tokenA, amountOut1, minAmountOut2, deadline);
            console.log(" - Swapped %s tokenB for %s tokenA on SushiSwap", amountOut1, amountOut2);
        }

        if (direction) {
            console.log(" - Arbitrage result (Sushi->Uni): started with %s tokenA, ended with %s tokenA", amountIn, amountOut2);
        } else {
            console.log(" - Arbitrage result (Uni->Sushi): started with %s tokenA, ended with %s tokenA", amountIn, amountOut2);
        }
        if (amountOut2 > amountIn) {
            console.log(" - Profit: %s tokenA", amountOut2 - amountIn);
        } else {
            console.log(" - Loss: %s tokenA", amountIn - amountOut2);
        }
        console.log(">>> executeArbitrageTrade: Completed <<<");
    }

    function swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint256 deadline,
        uint256 amountOutMin
    ) internal returns (uint256 amountOut) {
        console.log(">>> swapUniswapV3: Starting swap <<<");
        console.log(" - tokenIn: %s, tokenOut: %s", tokenIn, tokenOut);
        console.log(" - amountIn: %s, amountOutMin: %s", amountIn, amountOutMin);
        console.log(" - fee: %s, deadline: %s", fee, deadline);

        checkAndApprove(tokenIn, address(uniswapV3Router), amountIn, "Uniswap V3 router");

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

        amountOut = uniswapV3Router.exactInputSingle(params);
        console.log(" - Swap completed, received: %s %s", amountOut, tokenOut);
        console.log(" - Effective price: %s %s per %s", (amountOut * 1e18) / amountIn, tokenOut, tokenIn);
        emit SwapExecuted(address(uniswapV3Router), tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function swapSushiV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        console.log(">>> swapSushiV2: Starting swap <<<");
        console.log(" - tokenIn: %s, tokenOut: %s", tokenIn, tokenOut);
        console.log(" - amountIn: %s, amountOutMin: %s", amountIn, amountOutMin);
        console.log(" - deadline: %s", deadline);

        checkAndApprove(tokenIn, address(sushiSwapRouter), amountIn, "SushiSwap router");

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint[] memory amounts = sushiSwapRouter.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );
        amountOut = amounts[1];
        console.log(" - Swap completed, received: %s %s", amountOut, tokenOut);
        console.log(" - Effective price: %s %s per %s", (amountOut * 1e18) / amountIn, tokenOut, tokenIn);
        emit SwapExecuted(address(sushiSwapRouter), tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function checkAndApprove(address token, address spender, uint256 amount, string memory logLabel) internal {
        uint256 allowance = IERC20(token).allowance(address(this), spender);
        console.log(" - Checking allowance for %s at %s: %s", logLabel, spender, allowance);
        if (allowance < amount) {
            console.log(" - Approving %s for %s %s", spender, amount, token);
            IERC20(token).approve(spender, type(uint256).max);
            console.log(" - Approval set to max for %s", spender);
        }
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        console.log(">>> withdraw: Withdrawing %s of token %s <<<", amount, token);
        IERC20(token).transfer(msg.sender, amount);
        console.log(" - Withdrawn %s to %s", amount, msg.sender);
    }

    function setProfitReceiver(address _newReceiver) external onlyOwner {
        require(_newReceiver != address(0), "Invalid address");
        console.log(">>> setProfitReceiver: Updating profit receiver <<<");
        console.log(" - Old receiver: %s, New receiver: %s", profitReceiver, _newReceiver);
        profitReceiver = _newReceiver;
        console.log(">>> setProfitReceiver: Completed <<<");
    }

    receive() external payable {
        console.log(">>> receive: Received %s wei <<<", msg.value);
    }
}