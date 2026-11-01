// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Pair.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Factory.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Router02.sol";
import "hardhat/console.sol";

contract FlashLoanArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    IVault public immutable balancerVault;
    ISwapRouter public immutable uniswapV3Router;
    IUniswapV2Router02 public immutable sushiSwapRouter;
    IUniswapV2Factory public immutable sushiSwapFactory;
    IUniswapV3Pool public immutable uniswapV3Pool;

    address public immutable tokenA; // RDNT
    address public immutable tokenB; // WETH
    address public immutable sushiSwapPool;

    address public profitReceiver;

    event LiquidityProvided(uint256 amountA, uint256 amountB, uint256 liquidity);
    event ArbitrageExecuted(uint256 profitA, uint256 profitB, bool success);
    event LiquidityWithdrawn(uint256 amountA, uint256 amountB);
    event FlashLoanRepaid(uint256 amountA, uint256 amountB);
    event ProfitSent(address indexed receiver, uint256 amountA, uint256 amountB);
    event TokenBalanceAdjusted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event SwapExecuted(address indexed dexRouter, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event TransactionStep(string currentStep, string nextStep, string completedSteps);

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
        sushiSwapPool = sushiSwapFactory.getPair(_tokenA, _tokenB);
        profitReceiver = _profitReceiver;

        IERC20(sushiSwapPool).approve(_sushiSwapRouter, type(uint256).max);
        console.log("Constructor: SushiSwap LP token approval set to max for router: %s", _sushiSwapRouter);
    }

    function executeArbitrage(
        uint256 amountAForLiquidity,
        uint256 amountBForLiquidity,
        uint256 amountAForArbitrage,
        bool direction,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 feeUniswap,
        uint256 tokenAUSDPrice,
        uint256 tokenBUSDPrice
    ) external onlyOwner nonReentrant {
        emit TransactionStep("executeArbitrage", "receiveFlashLoan", "");
        require(amountAForLiquidity > 0 && amountBForLiquidity > 0, "Invalid liquidity amounts");
        require(amountAForArbitrage > 0, "Invalid arbitrage amount");
        require(deadline > block.timestamp, "Deadline expired");

        console.log(">>> executeArbitrage: Starting arbitrage process <<<");
        logWithUSD("amountAForLiquidity", amountAForLiquidity, tokenAUSDPrice);
        logWithUSD("amountBForLiquidity", amountBForLiquidity, tokenBUSDPrice);
        logWithUSD("amountAForArbitrage", amountAForArbitrage, tokenAUSDPrice);
        console.log(" - direction: %s (true: Sushi->Uni, false: Uni->Sushi)", direction);
        console.log(" - minAmountOut1: %s", minAmountOut1);
        console.log(" - minAmountOut2: %s", minAmountOut2);
        console.log(" - deadline: %s", deadline);
        console.log(" - feeUniswap: %s", feeUniswap);

        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(tokenA);
        tokens[1] = IERC20(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amountAForLiquidity + amountAForArbitrage;
        amounts[1] = amountBForLiquidity;

        bytes memory userData = abi.encode(
            direction,
            minAmountOut1,
            minAmountOut2,
            deadline,
            feeUniswap,
            amountAForLiquidity,
            amountBForLiquidity,
            amountAForArbitrage,
            tokenAUSDPrice,
            tokenBUSDPrice
        );

        logWithUSD("Requesting flash loan: tokenA", amounts[0], tokenAUSDPrice);
        logWithUSD("Requesting flash loan: tokenB", amounts[1], tokenBUSDPrice);
        balancerVault.flashLoan(this, tokens, amounts, userData);
        console.log(">>> executeArbitrage: Flash loan request sent to Balancer <<<");
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        emit TransactionStep("receiveFlashLoan", "provideLiquidity", "executeArbitrage");
        require(msg.sender == address(balancerVault), "Unauthorized caller");
        require(address(tokens[0]) == tokenA && address(tokens[1]) == tokenB, "Invalid tokens");

        console.log(">>> receiveFlashLoan: Flash loan received <<<");
        logWithUSD("tokenA borrowed", amounts[0], 0); // Price set after decoding
        logWithUSD("tokenB borrowed", amounts[1], 0);
        logWithUSD("feeA", feeAmounts[0], 0);
        logWithUSD("feeB", feeAmounts[1], 0);

        (
            bool direction,
            uint256 minAmountOut1,
            uint256 minAmountOut2,
            uint256 deadline,
            uint24 feeUniswap,
            uint256 amountAForLiquidity,
            uint256 amountBForLiquidity,
            uint256 amountAForArbitrage,
            uint256 tokenAUSDPrice,
            uint256 tokenBUSDPrice
        ) = abi.decode(userData, (bool, uint256, uint256, uint256, uint24, uint256, uint256, uint256, uint256, uint256));

        console.log(" - Decoded userData:");
        console.log("   - direction: %s", direction);
        console.log("   - minAmountOut1: %s", minAmountOut1);
        console.log("   - minAmountOut2: %s", minAmountOut2);
        console.log("   - deadline: %s", deadline);
        console.log("   - feeUniswap: %s", feeUniswap);
        logWithUSD("amountAForLiquidity", amountAForLiquidity, tokenAUSDPrice);
        logWithUSD("amountBForLiquidity", amountBForLiquidity, tokenBUSDPrice);
        logWithUSD("amountAForArbitrage", amountAForArbitrage, tokenAUSDPrice);

        logBalances("Initial balances after receiving flash loan", tokenAUSDPrice, tokenBUSDPrice);

        provideLiquidity(amountAForLiquidity, amountBForLiquidity, deadline, tokenAUSDPrice, tokenBUSDPrice);
        executeArbitrageTrade(direction, amountAForArbitrage, minAmountOut1, minAmountOut2, deadline, feeUniswap, tokenAUSDPrice, tokenBUSDPrice);
        withdrawLiquidity(tokenAUSDPrice, tokenBUSDPrice);

        uint256 repayAmountA = amounts[0] + feeAmounts[0];
        uint256 repayAmountB = amounts[1] + feeAmounts[1];
        logWithUSD("repayAmountA", repayAmountA, tokenAUSDPrice);
        logWithUSD("repayAmountB", repayAmountB, tokenBUSDPrice);
        adjustTokenBalances(repayAmountA, repayAmountB, feeUniswap, tokenAUSDPrice, tokenBUSDPrice);

        repayFlashLoan(tokens, repayAmountA, repayAmountB, tokenAUSDPrice, tokenBUSDPrice);
        sendProfit(tokenAUSDPrice, tokenBUSDPrice);

        emit TransactionStep("receiveFlashLoan completed", "", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade, withdrawLiquidity, adjustTokenBalances, repayFlashLoan, sendProfit");
        console.log(">>> receiveFlashLoan: Flash loan process completed <<<");
    }

    function provideLiquidity(uint256 amountA, uint256 amountB, uint256 deadline, uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        emit TransactionStep("provideLiquidity", "executeArbitrageTrade", "executeArbitrage, receiveFlashLoan");
        console.log(">>> provideLiquidity: Adding liquidity to SushiSwap <<<");
        logWithUSD("amountA", amountA, tokenAUSDPrice);
        logWithUSD("amountB", amountB, tokenBUSDPrice);
        console.log(" - deadline: %s", deadline);

        checkAndApprove(tokenA, address(sushiSwapRouter), amountA, "SushiSwap router for tokenA");
        checkAndApprove(tokenB, address(sushiSwapRouter), amountB, "SushiSwap router for tokenB");

        (uint256 amountAUsed, uint256 amountBUsed, uint256 liquidity) = sushiSwapRouter.addLiquidity(
            tokenA,
            tokenB,
            amountA,
            amountB,
            0,
            0,
            address(this),
            deadline
        );

        console.log(" - Liquidity added successfully:");
        logWithUSD("amountAUsed", amountAUsed, tokenAUSDPrice);
        logWithUSD("amountBUsed", amountBUsed, tokenBUSDPrice);
        console.log(" - liquidity tokens received: %s", liquidity);

        logBalances("After providing liquidity", tokenAUSDPrice, tokenBUSDPrice);
        emit LiquidityProvided(amountAUsed, amountBUsed, liquidity);
        console.log(">>> provideLiquidity: Completed <<<");
    }

    function executeArbitrageTrade(
        bool direction,
        uint256 amountIn,
        uint256 minAmountOut1,
        uint256 minAmountOut2,
        uint256 deadline,
        uint24 feeUniswap,
        uint256 tokenAUSDPrice,
        uint256 tokenBUSDPrice
    ) internal {
        emit TransactionStep("executeArbitrageTrade", "withdrawLiquidity", "executeArbitrage, receiveFlashLoan, provideLiquidity");
        console.log(">>> executeArbitrageTrade: Starting arbitrage <<<");
        console.log(" - direction: %s", direction);
        logWithUSD("amountIn", amountIn, tokenAUSDPrice);
        console.log(" - minAmountOut1: %s", minAmountOut1);
        console.log(" - minAmountOut2: %s", minAmountOut2);

        uint256 amountOut1;
        uint256 amountOut2;

        if (direction) {
            console.log(" - Direction: SushiSwap (RDNT -> WETH) -> Uniswap V3 (WETH -> RDNT)");
            checkAndApprove(tokenA, address(sushiSwapRouter), amountIn, "SushiSwap router for tokenA");
            amountOut1 = swapSushiV2(tokenA, tokenB, amountIn, minAmountOut1, deadline, tokenAUSDPrice, tokenBUSDPrice);
            checkAndApprove(tokenB, address(uniswapV3Router), amountOut1, "Uniswap V3 router for tokenB");
            amountOut2 = swapUniswapV3(tokenB, tokenA, amountOut1, feeUniswap, deadline, minAmountOut2, tokenBUSDPrice, tokenAUSDPrice);
        } else {
            console.log(" - Direction: Uniswap V3 (RDNT -> WETH) -> SushiSwap (WETH -> RDNT)");
            checkAndApprove(tokenA, address(uniswapV3Router), amountIn, "Uniswap V3 router for tokenA");
            amountOut1 = swapUniswapV3(tokenA, tokenB, amountIn, feeUniswap, deadline, minAmountOut1, tokenAUSDPrice, tokenBUSDPrice);
            checkAndApprove(tokenB, address(sushiSwapRouter), amountOut1, "SushiSwap router for tokenB");
            amountOut2 = swapSushiV2(tokenB, tokenA, amountOut1, minAmountOut2, deadline, tokenBUSDPrice, tokenAUSDPrice);
        }

        logBalances("After arbitrage trade", tokenAUSDPrice, tokenBUSDPrice);
        if (direction) {
            logWithUSD("Arbitrage result (Sushi->Uni): started with", amountIn, tokenAUSDPrice);
            logWithUSD("ended with", amountOut2, tokenAUSDPrice);
        } else {
            logWithUSD("Arbitrage result (Uni->Sushi): started with", amountIn, tokenAUSDPrice);
            logWithUSD("ended with", amountOut2, tokenAUSDPrice);
        }
        if (amountOut2 > amountIn) {
            logWithUSD("Profit", amountOut2 - amountIn, tokenAUSDPrice);
        } else {
            logWithUSD("Loss", amountIn - amountOut2, tokenAUSDPrice);
        }
        emit ArbitrageExecuted(amountOut2 > amountIn ? amountOut2 - amountIn : 0, 0, true);
        console.log(">>> executeArbitrageTrade: Completed <<<");
    }

    function adjustTokenBalances(uint256 repayAmountA, uint256 repayAmountB, uint24 feeUniswap, uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        emit TransactionStep("adjustTokenBalances", "repayFlashLoan", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade, withdrawLiquidity");
        console.log(">>> adjustTokenBalances: Adjusting balances for repayment <<<");
        logBalances("Current balances before adjustment", tokenAUSDPrice, tokenBUSDPrice);
        console.log(" - Required repayment:");
        logWithUSD("tokenA", repayAmountA, tokenAUSDPrice);
        logWithUSD("tokenB", repayAmountB, tokenBUSDPrice);

        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));

        if (balanceB < repayAmountB) {
            uint256 shortfallB = repayAmountB - balanceB;
            logWithUSD("Shortfall in tokenB", shortfallB, tokenBUSDPrice);
            uint256 amountAIn = estimateAmountAForB(shortfallB);
            logWithUSD("Estimated tokenA to swap", amountAIn, tokenAUSDPrice);

            if (balanceA >= repayAmountA + amountAIn) {
                console.log(" - Sufficient tokenA available, performing swap");
                checkAndApprove(tokenA, address(uniswapV3Router), amountAIn, "Uniswap V3 router for tokenA");
                uint256 amountOut = swapUniswapV3(tokenA, tokenB, amountAIn, feeUniswap, block.timestamp + 60, shortfallB, tokenAUSDPrice, tokenBUSDPrice);
                logWithUSD("Swapped tokenA for", amountOut, tokenBUSDPrice);
                console.log(" - Effective price: %s tokenB per tokenA", (amountOut * 1e18) / amountAIn);
                emit TokenBalanceAdjusted(tokenA, tokenB, amountAIn, amountOut);
            } else {
                console.log(" - Insufficient tokenA to cover tokenB shortfall");
                revert("Insufficient tokenA for adjustment");
            }
        }

        balanceA = IERC20(tokenA).balanceOf(address(this));
        balanceB = IERC20(tokenB).balanceOf(address(this));
        if (balanceA < repayAmountA) {
            uint256 shortfallA = repayAmountA - balanceA;
            logWithUSD("Shortfall in tokenA", shortfallA, tokenAUSDPrice);
            uint256 amountBIn = estimateAmountBForA(shortfallA);
            logWithUSD("Estimated tokenB to swap", amountBIn, tokenBUSDPrice);

            if (balanceB >= repayAmountB + amountBIn) {
                console.log(" - Sufficient tokenB available, performing swap");
                checkAndApprove(tokenB, address(uniswapV3Router), amountBIn, "Uniswap V3 router for tokenB");
                uint256 amountOut = swapUniswapV3(tokenB, tokenA, amountBIn, feeUniswap, block.timestamp + 60, shortfallA, tokenBUSDPrice, tokenAUSDPrice);
                logWithUSD("Swapped tokenB for", amountOut, tokenAUSDPrice);
                console.log(" - Effective price: %s tokenA per tokenB", (amountOut * 1e18) / amountBIn);
                emit TokenBalanceAdjusted(tokenB, tokenA, amountBIn, amountOut);
            } else {
                console.log(" - Insufficient tokenB to cover tokenA shortfall");
                revert("Insufficient tokenB for adjustment");
            }
        }

        logBalances("Final balances after adjustment", tokenAUSDPrice, tokenBUSDPrice);
        console.log(">>> adjustTokenBalances: Completed <<<");
    }

    function withdrawLiquidity(uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        emit TransactionStep("withdrawLiquidity", "adjustTokenBalances", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade");
        console.log(">>> withdrawLiquidity: Withdrawing liquidity from SushiSwap <<<");
        IUniswapV2Pair pair = IUniswapV2Pair(sushiSwapPool);
        uint256 liquidity = pair.balanceOf(address(this));
        console.log(" - Liquidity tokens to withdraw: %s", liquidity);
        require(liquidity > 0, "No liquidity to withdraw");

        (uint256 amountA, uint256 amountB) = sushiSwapRouter.removeLiquidity(
            tokenA,
            tokenB,
            liquidity,
            0,
            0,
            address(this),
            block.timestamp + 60
        );
        console.log(" - Withdrawn amounts:");
        logWithUSD("tokenA", amountA, tokenAUSDPrice);
        logWithUSD("tokenB", amountB, tokenBUSDPrice);

        logBalances("After withdrawing liquidity", tokenAUSDPrice, tokenBUSDPrice);
        emit LiquidityWithdrawn(amountA, amountB);
        console.log(">>> withdrawLiquidity: Completed <<<");
    }

    function repayFlashLoan(IERC20[] memory tokens, uint256 repayAmountA, uint256 repayAmountB, uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        emit TransactionStep("repayFlashLoan", "sendProfit", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade, withdrawLiquidity, adjustTokenBalances");
        console.log(">>> repayFlashLoan: Repaying flash loan <<<");
        logBalances("Before repayment", tokenAUSDPrice, tokenBUSDPrice);

        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));
        require(balanceA >= repayAmountA, "Insufficient balance for tokenA");
        require(balanceB >= repayAmountB, "Insufficient balance for tokenB");

        tokens[0].transfer(address(balancerVault), repayAmountA);
        tokens[1].transfer(address(balancerVault), repayAmountB);
        logWithUSD("Transferred tokenA to Balancer Vault", repayAmountA, tokenAUSDPrice);
        logWithUSD("Transferred tokenB to Balancer Vault", repayAmountB, tokenBUSDPrice);

        logBalances("After repayment", tokenAUSDPrice, tokenBUSDPrice);
        emit FlashLoanRepaid(repayAmountA, repayAmountB);
        console.log(">>> repayFlashLoan: Completed <<<");
    }

    function sendProfit(uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        emit TransactionStep("sendProfit", "", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade, withdrawLiquidity, adjustTokenBalances, repayFlashLoan");
        console.log(">>> sendProfit: Sending profits to receiver <<<");
        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));
        console.log(" - Available profits:");
        logWithUSD("tokenA", balanceA, tokenAUSDPrice);
        logWithUSD("tokenB", balanceB, tokenBUSDPrice);

        if (balanceA > 0) {
            IERC20(tokenA).transfer(profitReceiver, balanceA);
            logWithUSD("Sent to profitReceiver", balanceA, tokenAUSDPrice);
        }
        if (balanceB > 0) {
            IERC20(tokenB).transfer(profitReceiver, balanceB);
            logWithUSD("Sent to profitReceiver", balanceB, tokenBUSDPrice);
        }

        if (balanceA > 0 || balanceB > 0) {
            emit ProfitSent(profitReceiver, balanceA, balanceB);
        }
        console.log(">>> sendProfit: Completed <<<");
    }

    function swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee,
        uint256 deadline,
        uint256 amountOutMin,
        uint256 tokenInUSDPrice,
        uint256 tokenOutUSDPrice
    ) internal returns (uint256 amountOut) {
        emit TransactionStep("swapUniswapV3", "", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade (partial)");
        console.log(">>> swapUniswapV3: Starting swap <<<");
        console.log(" - tokenIn: %s, tokenOut: %s", tokenIn, tokenOut);
        logWithUSD("amountIn", amountIn, tokenInUSDPrice);
        console.log(" - amountOutMin: %s", amountOutMin);
        console.log(" - fee: %s, deadline: %s", fee, deadline);
        logBalances("Before Uniswap V3 swap", tokenIn == tokenA ? tokenInUSDPrice : tokenOutUSDPrice, tokenOut == tokenB ? tokenOutUSDPrice : tokenInUSDPrice);

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
        logWithUSD("Swap completed, received", amountOut, tokenOutUSDPrice);
        console.log(" - Effective price: %s %s per %s", (amountOut * 1e18) / amountIn, tokenOut, tokenIn);
        logBalances("After Uniswap V3 swap", tokenIn == tokenA ? tokenInUSDPrice : tokenOutUSDPrice, tokenOut == tokenB ? tokenOutUSDPrice : tokenInUSDPrice);

        emit SwapExecuted(address(uniswapV3Router), tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function swapSushiV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        uint256 tokenInUSDPrice,
        uint256 tokenOutUSDPrice
    ) internal returns (uint256 amountOut) {
        emit TransactionStep("swapSushiV2", "", "executeArbitrage, receiveFlashLoan, provideLiquidity, executeArbitrageTrade (partial)");
        console.log(">>> swapSushiV2: Starting swap <<<");
        console.log(" - tokenIn: %s, tokenOut: %s", tokenIn, tokenOut);
        logWithUSD("amountIn", amountIn, tokenInUSDPrice);
        console.log(" - amountOutMin: %s", amountOutMin);
        console.log(" - deadline: %s", deadline);
        logBalances("Before SushiSwap swap", tokenIn == tokenA ? tokenInUSDPrice : tokenOutUSDPrice, tokenOut == tokenB ? tokenOutUSDPrice : tokenInUSDPrice);

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
        logWithUSD("Swap completed, received", amountOut, tokenOutUSDPrice);
        console.log(" - Effective price: %s %s per %s", (amountOut * 1e18) / amountIn, tokenOut, tokenIn);
        logBalances("After SushiSwap swap", tokenIn == tokenA ? tokenInUSDPrice : tokenOutUSDPrice, tokenOut == tokenB ? tokenOutUSDPrice : tokenInUSDPrice);

        emit SwapExecuted(address(sushiSwapRouter), tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function estimateAmountAForB(uint256 amountB) internal view returns (uint256) {
        
        (uint160 sqrtPriceX96,,,,,,) = uniswapV3Pool.slot0();
        uint256 price = uint256(sqrtPriceX96) * uint256(sqrtPriceX96) / (1 << 192); // RDNT per WETH
        uint256 amountA = (amountB * price * 1e18) / 1e18;
        
        return amountA + (amountA / 10); // Add 10% buffer
    }

    function estimateAmountBForA(uint256 amountA) internal view returns (uint256) {
        
        (uint160 sqrtPriceX96,,,,,,) = uniswapV3Pool.slot0();
        uint256 price = uint256(sqrtPriceX96) * uint256(sqrtPriceX96) / (1 << 192); // RDNT per WETH
        uint256 amountB = (amountA * 1e18) / price;
        
        return amountB + (amountB / 10); // Add 10% buffer
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

    function logBalances(string memory context, uint256 tokenAUSDPrice, uint256 tokenBUSDPrice) internal {
        uint256 balanceA = IERC20(tokenA).balanceOf(address(this));
        uint256 balanceB = IERC20(tokenB).balanceOf(address(this));
        console.log(" - Balances [%s]:", context);
        logWithUSD("tokenA", balanceA, tokenAUSDPrice);
        logWithUSD("tokenB", balanceB, tokenBUSDPrice);
    }

    function logWithUSD(string memory label, uint256 amount, uint256 price) internal {
        if (price == 0) {
            console.log(" - %s: %s", label, amount);
            return;
        }
        uint256 usdValue = (amount * price) / 1e18; // Assuming 18 decimals for tokens, price in 8 decimals
        console.log(" - %s: %s [usd: %s]", label, amount, usdValue);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        emit TransactionStep("withdraw", "", "");
        console.log(">>> withdraw: Withdrawing %s of token %s <<<", amount, token);
        IERC20(token).transfer(msg.sender, amount);
        console.log(" - Withdrawn %s to %s", amount, msg.sender);
    }

    function setProfitReceiver(address _newReceiver) external onlyOwner {
        emit TransactionStep("setProfitReceiver", "", "");
        require(_newReceiver != address(0), "Invalid address");
        console.log(">>> setProfitReceiver: Updating profit receiver <<<");
        console.log(" - Old receiver: %s, New receiver: %s", profitReceiver, _newReceiver);
        profitReceiver = _newReceiver;
        console.log(">>> setProfitReceiver: Completed <<<");
    }

    receive() external payable {
        emit TransactionStep("receive", "", "");
        console.log(">>> receive: Received %s wei <<<", msg.value);
    }
}