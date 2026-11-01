// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@sushiswap/core/contracts/uniswapv2/interfaces/IUniswapV2Router02.sol";


contract FlashLoanArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    IVault public immutable balancerVault;
    ISwapRouter public immutable uniswapV3Router;
    IUniswapV2Router02 public immutable sushiSwapRouter;
    ISwapRouter public immutable camelotRouter;
    IUniswapV2Router02 public immutable arbswapRouter;
    IUniswapV2Router02 public immutable arbidexRouter;
    ISwapRouter public immutable pancakeSwapV3Router;

    address public immutable UNISWAP_V3_POOL_ADDRESS;
    address public immutable SUSHISWAP_V2_POOL_ADDRESS;
    address public immutable CAMELOT_V3_POOL_ADDRESS;
    address public immutable ARBSWAP_POOL_ADDRESS;
    address public immutable ARBIDEX_POOL_ADDRESS;
    address public immutable PANCAKESWAP_V3_POOL_ADDRESS;
    address public immutable tokenA; // TBTC
    address public immutable tokenB; // WBTC
    address public profitReceiver;

    enum DEXType { V3, V2 }

    // Consolidated event to reduce gas
    event ArbitrageResult(
        uint256 profitA,
        uint256 profitB,
        bool success,
        uint256 repaidAmount,
        address indexed receiver
    );

    constructor(
        address _balancerVault,
        address _uniswapV3Router,
        address _sushiSwapRouter,
        address _camelotRouter,
        address _arbswapRouter,
        address _arbidexRouter,
        address _pancakeSwapV3Router,
        address _uniswapV3Pool,
        address _sushiSwapV2Pool,
        address _camelotV3Pool,
        address _arbswapPool,
        address _arbidexPool,
        address _pancakeSwapV3Pool,
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
        pancakeSwapV3Router = ISwapRouter(_pancakeSwapV3Router);
        UNISWAP_V3_POOL_ADDRESS = _uniswapV3Pool;
        SUSHISWAP_V2_POOL_ADDRESS = _sushiSwapV2Pool;
        CAMELOT_V3_POOL_ADDRESS = _camelotV3Pool;
        ARBSWAP_POOL_ADDRESS = _arbswapPool;
        ARBIDEX_POOL_ADDRESS = _arbidexPool;
        PANCAKESWAP_V3_POOL_ADDRESS = _pancakeSwapV3Pool;
        tokenA = _tokenA;
        tokenB = _tokenB;
        profitReceiver = _profitReceiver;

        // Pre-approve routers for tokenA and tokenB to save gas on approvals
        IERC20(_tokenA).approve(_uniswapV3Router, type(uint256).max);
        IERC20(_tokenA).approve(_sushiSwapRouter, type(uint256).max);
        IERC20(_tokenA).approve(_camelotRouter, type(uint256).max);
        IERC20(_tokenA).approve(_arbswapRouter, type(uint256).max);
        IERC20(_tokenA).approve(_arbidexRouter, type(uint256).max);
        IERC20(_tokenA).approve(_pancakeSwapV3Router, type(uint256).max);
        IERC20(_tokenB).approve(_uniswapV3Router, type(uint256).max);
        IERC20(_tokenB).approve(_sushiSwapRouter, type(uint256).max);
        IERC20(_tokenB).approve(_camelotRouter, type(uint256).max);
        IERC20(_tokenB).approve(_arbswapRouter, type(uint256).max);
        IERC20(_tokenB).approve(_arbidexRouter, type(uint256).max);
        IERC20(_tokenB).approve(_pancakeSwapV3Router, type(uint256).max);
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
        require(token == tokenA && amount > 0 && deadline > block.timestamp, "Invalid input");

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

        balancerVault.flashLoan(this, tokens, amounts, userData);
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == address(balancerVault) && tokens.length == 1 && address(tokens[0]) == tokenA, "Invalid loan");

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
        IERC20 tokenAContract = IERC20(tokenA);
        uint256 balanceA = tokenAContract.balanceOf(address(this));
        require(balanceA >= repayAmountA, "Insufficient balance");

        tokenAContract.transfer(address(balancerVault), repayAmountA);

        uint256 profitA = balanceA - repayAmountA;
        uint256 profitB = IERC20(tokenB).balanceOf(address(this));

        if (profitA > 0 || profitB > 0) {
            if (profitA > 0) tokenAContract.transfer(profitReceiver, profitA);
            if (profitB > 0) IERC20(tokenB).transfer(profitReceiver, profitB);
            emit ArbitrageResult(profitA, profitB, true, repayAmountA, profitReceiver);
        } else {
            emit ArbitrageResult(0, 0, false, repayAmountA, profitReceiver);
        }
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
        (address routerBuy, DEXType dexTypeBuy) = getRouterAndType(poolBuy);
        (address routerSell, DEXType dexTypeSell) = getRouterAndType(poolSell);

        uint256 amountOut1 = dexTypeBuy == DEXType.V3
            ? swapV3(routerBuy, tokenA, tokenB, amountIn, feeBuy, deadline, minAmountOut1)
            : swapV2(routerBuy, tokenA, tokenB, amountIn, minAmountOut1, deadline);

        uint256 amountOut2 = dexTypeSell == DEXType.V3
            ? swapV3(routerSell, tokenB, tokenA, amountOut1, feeSell, deadline, minAmountOut2)
            : swapV2(routerSell, tokenB, tokenA, amountOut1, minAmountOut2, deadline);
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

        amountOut = ISwapRouter(router).exactInputSingle(params);
    }

    function swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amounts = IUniswapV2Router02(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );
        amountOut = amounts[1];
    }

    function getRouterAndType(address pool) internal view returns (address router, DEXType dexType) {
        if (pool == UNISWAP_V3_POOL_ADDRESS) return (address(uniswapV3Router), DEXType.V3);
        if (pool == CAMELOT_V3_POOL_ADDRESS) return (address(camelotRouter), DEXType.V3);
        if (pool == PANCAKESWAP_V3_POOL_ADDRESS) return (address(pancakeSwapV3Router), DEXType.V3);
        if (pool == SUSHISWAP_V2_POOL_ADDRESS) return (address(sushiSwapRouter), DEXType.V2);
        if (pool == ARBSWAP_POOL_ADDRESS) return (address(arbswapRouter), DEXType.V2);
        if (pool == ARBIDEX_POOL_ADDRESS) return (address(arbidexRouter), DEXType.V2);
        revert("Unknown pool");
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(msg.sender, amount);
    }

    function setProfitReceiver(address _newReceiver) external onlyOwner {
        require(_newReceiver != address(0), "Invalid address");
        profitReceiver = _newReceiver;
    }

    receive() external payable {}
}