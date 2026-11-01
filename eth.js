const Web3 = require('web3');
const ethers = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');

// Configuration
const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/TLXJHWufU3J51tQl4mOxpVTyKSLOVOA7';
const WS_URL = 'wss://eth-mainnet.g.alchemy.com/v2/TLXJHWufU3J51tQl4mOxpVTyKSLOVOA7';
const PRIVATE_KEY = "6ec4d363c27b4996c38a0928e8621c88bd608a93aba91ff669630cfdbffdabce";
const BUY_AMOUNT = 0.0035;
const SELL_DELAY = 600000;
const PRICE_CHANGE_THRESHOLD = 100;
const TRAILING_STOP_LOSS_THRESHOLD = 100;
const MIN_ETH = 1.0;
const MAXTRADE_THRESHOLD = 1;
const DEBUG = true;
const LOSS_THRESHOLD = 1;
const MAX_RECONNECT_ATTEMPTS = 5;
const LARGE_SELL_THRESHOLD = 1; // Threshold for large sell in tokens (adjust as needed)

// Initialize Web3 with providers
const web3 = new Web3(new Web3.providers.HttpProvider(RPC_URL));
const web3Ws = new Web3(new Web3.providers.WebsocketProvider(WS_URL));

// Set up wallet
const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);
const wallet_address = account.address;

// Uniswap V2 Constants
const UNISWAP_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// ABIs
const factory_abi = [
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "name": "token0", "type": "address"},
            {"indexed": true, "name": "token1", "type": "address"},
            {"indexed": false, "name": "pair", "type": "address"},
            {"indexed": false, "name": "length", "type": "uint256"}
        ],
        "name": "PairCreated",
        "type": "event"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "allPairsLength",
        "outputs": [{"name": "", "type": "uint256"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": false,
        "inputs": [{"name": "tokenA", "type": "address"}, {"name": "tokenB", "type": "address"}],
        "name": "createPair",
        "outputs": [{"name": "pair", "type": "address"}],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [{"name": "", "type": "uint256"}],
        "name": "allPairs",
        "outputs": [{"name": "", "type": "address"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [{"name": "tokenA", "type": "address"}, {"name": "tokenB", "type": "address"}],
        "name": "getPair",
        "outputs": [{"name": "pair", "type": "address"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    }
];

const router_abi = [
    {
        "constant": false,
        "inputs": [
            {"name": "amountOutMin", "type": "uint256"},
            {"name": "path", "type": "address[]"},
            {"name": "to", "type": "address"},
            {"name": "deadline", "type": "uint256"}
        ],
        "name": "swapExactETHForTokens",
        "outputs": [{"name": "amounts", "type": "uint256[]"}],
        "payable": true,
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "constant": false,
        "inputs": [
            {"name": "amountIn", "type": "uint256"},
            {"name": "amountOutMin", "type": "uint256"},
            {"name": "path", "type": "address[]"},
            {"name": "to", "type": "address"},
            {"name": "deadline", "type": "uint256"}
        ],
        "name": "swapExactTokensForETH",
        "outputs": [{"name": "amounts", "type": "uint256[]"}],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const pair_abi = [
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "name": "sender", "type": "address"},
            {"indexed": false, "name": "amount0In", "type": "uint256"},
            {"indexed": false, "name": "amount1In", "type": "uint256"},
            {"indexed": false, "name": "amount0Out", "type": "uint256"},
            {"indexed": false, "name": "amount1Out", "type": "uint256"},
            {"indexed": true, "name": "to", "type": "address"}
        ],
        "name": "Swap",
        "type": "event"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "getReserves",
        "outputs": [
            {"name": "_reserve0", "type": "uint112"},
            {"name": "_reserve1", "type": "uint112"},
            {"name": "_blockTimestampLast", "type": "uint32"}
        ],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "token0",
        "outputs": [{"name": "", "type": "address"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "token1",
        "outputs": [{"name": "", "type": "address"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    }
];

const erc20_abi = [
    {
        "constant": true,
        "inputs": [],
        "name": "name",
        "outputs": [{"name": "", "type": "string"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": false,
        "inputs": [{"name": "_spender", "type": "address"}, {"name": "_value", "type": "uint256"}],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    },
    {
        "constant": true,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "payable": false,
        "stateMutability": "view",
        "type": "function"
    }
];

// Contract instances
const factory_contract = new web3Ws.eth.Contract(factory_abi, UNISWAP_V2_FACTORY);
const router_contract = new web3.eth.Contract(router_abi, UNISWAP_V2_ROUTER);

// Ethers.js setup for Flashbots
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
let flashbotsProvider;

(async () => {
    flashbotsProvider = await FlashbotsBundleProvider.create(provider, wallet, 'https://relay.flashbots.net');
})().catch(console.error);

// Global variables
let trade_tasks = [];
let trade_count = 0;
let trade_metrics = {};
let initial_prices = {};
let unsold_tokens = [];
let win_count = 0;
let loss_count = 0;
let trade_in_progress = false;

// Utility function to format time
const formatTime = () => new Date().toLocaleTimeString();

// Functions
async function buy_token(token_address, amount_eth, pair_address = null) {
    trade_in_progress = true;
    if (DEBUG) {
        console.log(`[DEBUG] Simulating buy of ${amount_eth} ETH for token ${token_address}`);
        return "simulated_buy_tx_id";
    }
    const amount_wei = web3.utils.toWei(amount_eth.toString(), 'ether');
    const path = [WETH_ADDRESS, token_address];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
    try {
        const tx = await router_contract.methods.swapExactETHForTokens(
            0,
            path,
            wallet_address,
            deadline
        ).send({
            from: wallet_address,
            value: amount_wei,
            gas: 200000,
            gasPrice: await web3.eth.getGasPrice(),
        });
        console.log(`[${formatTime()}] Buy transaction sent: ${tx.transactionHash}`);
        if (pair_address && !unsold_tokens.some(t => t.token_address === token_address)) {
            unsold_tokens.push({ token_address, pair_address });
        }
        return tx.transactionHash;
    } catch (error) {
        console.error(`Error in buy_token: ${error}`);
        trade_in_progress = false;
        return null;
    }
}

async function sell_token(token_address, token_amount, pair_address) {
    if (DEBUG) {
        console.log(`[DEBUG] Simulating sell of ${token_amount} tokens for token ${token_address}`);
        return ["simulated_sell_tx_id", 0];
    }
    const token_contract = new web3.eth.Contract(erc20_abi, token_address);
    try {
        const approve_tx = await token_contract.methods.approve(UNISWAP_V2_ROUTER, token_amount).send({
            from: wallet_address,
            gas: 100000,
            gasPrice: await web3.eth.getGasPrice(),
        });
        console.log(`Approve transaction sent: ${approve_tx.transactionHash}`);
        const path = [token_address, WETH_ADDRESS];
        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
        const tx = await router_contract.methods.swapExactTokensForETH(
            token_amount,
            0,
            path,
            wallet_address,
            deadline
        ).send({
            from: wallet_address,
            gas: 200000,
            gasPrice: await web3.eth.getGasPrice(),
        });
        console.log(`[${formatTime()}] Sell transaction sent: ${tx.transactionHash}`);
        const receipt = await web3.eth.getTransactionReceipt(tx.transactionHash);
        const sol_received = parseFloat(web3.utils.fromWei(receipt.gasUsed * (await web3.eth.getGasPrice()), 'ether'));
        trade_in_progress = false;
        return [tx.transactionHash, sol_received];
    } catch (error) {
        console.error(`Error in sell_token: ${error}`);
        trade_in_progress = false;
        return [null, 0];
    }
}

async function get_pool_reserves(pair_address) {
    const pair_contract = new web3.eth.Contract(pair_abi, pair_address);
    const reserves = await pair_contract.methods.getReserves().call();
    const token0 = await pair_contract.methods.token0().call();
    let eth_reserve, token_reserve;
    if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        eth_reserve = reserves._reserve0;
        token_reserve = reserves._reserve1;
    } else {
        token_reserve = reserves._reserve0;
        eth_reserve = reserves._reserve1;
    }
    const eth_reserve_eth = parseFloat(web3.utils.fromWei(eth_reserve, 'ether'));
    return [eth_reserve_eth, token_reserve];
}

function log_profit_loss(token_address) {
    const sol_spent = trade_metrics[token_address].sol_spent;
    const sol_received = trade_metrics[token_address].sol_received;
    const profit_loss = sol_received - sol_spent;
    if (DEBUG) {
        console.log(`[DEBUG] Simulated trade summary for ${token_address}:`);
    } else {
        console.log(`Trade summary for ${token_address}:`);
    }
    console.log(`  ETH Spent: ${sol_spent.toFixed(6)}`);
    console.log(`  ETH Received: ${sol_received.toFixed(6)}`);
    console.log(`  Profit/Loss: ${profit_loss.toFixed(6)} ETH`);
}

async function monitor_swap_events(pair_address, token_address, initial_price, resolve_sell) {
    const pair_contract = new web3Ws.eth.Contract(pair_abi, pair_address);
    let highest_price = initial_price;
    const subscription = pair_contract.events.Swap({ fromBlock: 'latest' });
    subscription.on('data', async () => {
        const [eth_reserve, token_reserve] = await get_pool_reserves(pair_address);
        const current_price = eth_reserve / parseFloat(token_reserve);
        highest_price = Math.max(highest_price, current_price);
        const price_change = ((current_price - initial_price) / initial_price) * 100;
        const percentage_drop = ((current_price - highest_price) / highest_price) * 100;
        console.log(`Current price: ${current_price.toFixed(12)} ETH per token`);
        console.log(`Price change: ${price_change.toFixed(2)}%`);
        console.log(`Drop from high: ${percentage_drop.toFixed(2)}%`);
        if (price_change >= PRICE_CHANGE_THRESHOLD || percentage_drop <= -TRAILING_STOP_LOSS_THRESHOLD) {
            subscription.unsubscribe();
            resolve_sell();
        }
    }).on('error', (error) => {
        console.error(`Error in Swap event: ${error}`);
    });
}

async function sell_after_delay_or_price_change(token_address, pair_address, delay, initial_price) {
    const sell_promise = new Promise((resolve) => {
        monitor_swap_events(pair_address, token_address, initial_price, resolve);
    });
    const delay_promise = new Promise((resolve) => setTimeout(resolve, delay * 1000));
    await Promise.race([sell_promise, delay_promise]);
    if (unsold_tokens.some(t => t.token_address === token_address)) {
        const token_contract = new web3.eth.Contract(erc20_abi, token_address);
        const balance = await token_contract.methods.balanceOf(wallet_address).call();
        const [tx_id, sol_received] = await sell_token(token_address, balance, pair_address);
        if (tx_id) {
            trade_metrics[token_address].sol_received = sol_received;
            log_profit_loss(token_address);
            unsold_tokens = unsold_tokens.filter(t => t.token_address !== token_address);
        }
    }
}

async function process_new_pair(pair_address, token_address) {
    if (loss_count >= LOSS_THRESHOLD || trade_count >= MAXTRADE_THRESHOLD) {
        console.log('Stopping due to loss or trade threshold');
        return;
    }
    console.log(`[${formatTime()}] New pair created: ${pair_address}`);
    const [eth_reserve, token_reserve] = await get_pool_reserves(pair_address);
    console.log(`[${formatTime()}] Reserves: ETH ${eth_reserve}, Token ${token_reserve}`);
    if (eth_reserve <= MIN_ETH) {
        console.log(`[${formatTime()}] Skipping: ETH reserve ${eth_reserve} <= ${MIN_ETH}`);
        return;
    }
    trade_metrics[token_address] = { sol_spent: 0, sol_received: 0 };
    const buy_tx_id = await buy_token(token_address, BUY_AMOUNT, pair_address);
    if (buy_tx_id) {
        trade_metrics[token_address].sol_spent = BUY_AMOUNT;
        const initial_price = eth_reserve / parseFloat(token_reserve);
        initial_prices[token_address] = initial_price;
        trade_tasks.push(sell_after_delay_or_price_change(token_address, pair_address, SELL_DELAY, initial_price));
        trade_count += 1;
    } else {
        trade_metrics[token_address].sol_received = 0;
        log_profit_loss(token_address);
        trade_in_progress = false;
    }
}

async function monitor_uniswap_v2() {
    let reconnect_count = 0;
    const monitor = () => {
        console.log(`[${formatTime()}] Starting to monitor PairCreated events...`);
        const subscription = factory_contract.events.PairCreated({ fromBlock: 'latest' });
        subscription.on('connected', (subscriptionId) => {
            console.log(`[${formatTime()}] Connected to PairCreated event subscription: ${subscriptionId}`);
        });
        subscription.on('data', async (event) => {
            console.log(`[${formatTime()}] New PairCreated event detected`);
            if (trade_in_progress) {
                console.log(`[${formatTime()}] Trade in progress, pausing monitoring...`);
                return;
            }
            const pair_address = event.returnValues.pair;
            const token0 = event.returnValues.token0;
            const token1 = event.returnValues.token1;
            let new_token;
            if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                new_token = token1;
            } else if (token1.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                new_token = token0;
            } else {
                console.log(`[${formatTime()}] Pair does not involve WETH, skipping`);
                return;
            }
            await process_new_pair(pair_address, new_token);
        }).on('error', (error) => {
            console.error(`Error in PairCreated event: ${error}`);
            if (reconnect_count < MAX_RECONNECT_ATTEMPTS) {
                reconnect_count++;
                console.log(`Reconnecting attempt ${reconnect_count}/${MAX_RECONNECT_ATTEMPTS}`);
                setTimeout(monitor, 10000);
            }
        });
    };
    monitor();
}

// Mempool monitoring for large transactions
async function monitor_mempool_for_large_transactions() {
    web3Ws.eth.subscribe('pendingTransactions', (error, txHash) => {
        if (error) {
            console.error(`Error subscribing to pending transactions: ${error}`);
            return;
        }
        web3.eth.getTransaction(txHash).then(async (tx) => {
            if (tx && tx.to && tx.to.toLowerCase() === UNISWAP_V2_ROUTER.toLowerCase()) {
                try {
                    const input = tx.input;
                    const methodId = input.slice(0, 10);
                    if (methodId === '0x18cbafe5') { // swapExactTokensForETH (sell)
                        const decoded = web3.eth.abi.decodeParameters(
                            ['uint256', 'uint256', 'address[]', 'address', 'uint256'],
                            input.slice(10)
                        );
                        const path = decoded[2];
                        if (path.length === 2 && path[1].toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                            const token_address = path[0];
                            const pair_address = await factory_contract.methods.getPair(token_address, WETH_ADDRESS).call();
                            if (unsold_tokens.some(t => t.token_address.toLowerCase() === token_address.toLowerCase())) {
                                const amountIn = web3.utils.fromWei(decoded[0], 'ether');
                                if (parseFloat(amountIn) > LARGE_SELL_THRESHOLD) {
                                    console.log(`[${formatTime()}] Large sell detected for token ${token_address}: ${amountIn} tokens`);
                                    if (DEBUG) {
                                        console.log(`[DEBUG] Simulating frontrunning sell for token ${token_address}`);
                                    } else {
                                        await frontrun_large_sell(token_address, tx);
                                    }
                                }
                            }
                        }
                    } else if (methodId === '0x7ff36ab5') { // swapExactETHForTokens (buy)
                        const decoded = web3.eth.abi.decodeParameters(
                            ['uint256', 'address[]', 'address', 'uint256'],
                            input.slice(10)
                        );
                        const path = decoded[1];
                        if (path.length === 2 && path[0].toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                            const token_address = path[1];
                            const pair_address = await factory_contract.methods.getPair(token_address, WETH_ADDRESS).call();
                            const amountEth = web3.utils.fromWei(tx.value, 'ether');
                            if (parseFloat(amountEth) > BUY_AMOUNT * 2 && !unsold_tokens.some(t => t.token_address === token_address)) {
                                console.log(`[${formatTime()}] Large buy detected for token ${token_address}: ${amountEth} ETH`);
                                if (DEBUG) {
                                    console.log(`[DEBUG] Simulating buy signal for token ${token_address} due to significant price impact`);
                                } else {
                                    trade_metrics[token_address] = { sol_spent: 0, sol_received: 0 };
                                    const buy_tx_id = await buy_token(token_address, BUY_AMOUNT, pair_address);
                                    if (buy_tx_id) {
                                        trade_metrics[token_address].sol_spent = BUY_AMOUNT;
                                        const [eth_reserve, token_reserve] = await get_pool_reserves(pair_address);
                                        const initial_price = eth_reserve / parseFloat(token_reserve);
                                        initial_prices[token_address] = initial_price;
                                        trade_tasks.push(sell_after_delay_or_price_change(token_address, pair_address, SELL_DELAY, initial_price));
                                        trade_count += 1;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Ignore decoding errors
                }
            }
        });
    });
}

async function frontrun_large_sell(token_address, largeSellTx) {
    if (DEBUG) {
        console.log(`[DEBUG] Simulating bundle submission for frontrunning large sell of token ${token_address}`);
        unsold_tokens = unsold_tokens.filter(t => t.token_address !== token_address);
        return;
    }
    try {
        const tokenContract = new ethers.Contract(token_address, erc20_abi, provider);
        const balance = await tokenContract.balanceOf(wallet_address);
        if (balance.eq(0)) {
            console.log(`No balance to sell for token ${token_address}`);
            return;
        }
        const router = new ethers.Contract(UNISWAP_V2_ROUTER, router_abi, wallet);
        const approveTx = await tokenContract.populateTransaction.approve(UNISWAP_V2_ROUTER, balance);
        const signedApproveTx = await wallet.signTransaction(approveTx);
        const sellTx = await router.populateTransaction.swapExactTokensForETH(
            balance,
            0,
            [token_address, WETH_ADDRESS],
            wallet_address,
            Math.floor(Date.now() / 1000) + 60 * 10
        );
        const signedSellTx = await wallet.signTransaction(sellTx);
        const bundle = [
            { signedTransaction: signedApproveTx },
            { signedTransaction: signedSellTx },
            { transactionHash: largeSellTx.hash }
        ];
        const bundleResponse = await flashbotsProvider.sendBundle(bundle, await provider.getBlockNumber() + 1);
        console.log(`[${formatTime()}] Bundle sent: ${JSON.stringify(bundleResponse)}`);
        trade_metrics[token_address].sol_received = parseFloat(web3.utils.fromWei(balance, 'ether')) * 0.1; // Rough estimate
        log_profit_loss(token_address);
        unsold_tokens = unsold_tokens.filter(t => t.token_address !== token_address);
    } catch (error) {
        console.error(`Error in frontrun_large_sell: ${error}`);
    }
}

// Main execution
monitor_uniswap_v2().catch(console.error);
monitor_mempool_for_large_transactions().catch(console.error);

// Handle process exit to sell unsold tokens
process.on('SIGINT', async () => {
    for (const token of unsold_tokens) {
        const token_contract = new web3.eth.Contract(erc20_abi, token.token_address);
        const balance = await token_contract.methods.balanceOf(wallet_address).call();
        await sell_token(token.token_address, balance, token.pair_address);
    }
    process.exit();
});