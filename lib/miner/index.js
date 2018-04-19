const R = require('ramda');
const spawn = require('threads').spawn;
const Block = require('../blockchain/block');
const CryptoUtil = require('../util/cryptoUtil');
const Transaction = require('../blockchain/transaction');

const FEE_PER_TRANSACTION = 1;
const MINING_REWARD = 5000000000;
const TRANSACTIONS_PER_BLOCK = 2;


const bonus_stages =  {
    10000: 0.0005,//5, //0.0005
    8000: 1,      //10000,//1
    6000: 0.05,   //500, //0.05
    5000: 0.5,    //5000, //0.5
    3500: 0.05,   //500,  //0.05
    3000: 0.1,    //1000, //0.1
    2000: 0.05,   //500, //0.05
    1000: 0.01,   //100, //0.01
    100:  0.005,  //50, //0.005
    0:    0.003 //30 //0.003
};


class Miner {
    constructor(blockchain, operator,logLevel) {
        this.blockchain = blockchain;
        this.logLevel = logLevel;
        this.operator = operator;
    }

    mine(rewardAddress, feeAddress) {
        let baseBlock = Miner.generateNextBlock(rewardAddress, feeAddress, this.blockchain, this.calculateReward(rewardAddress) );
        process.execArgv = R.reject((item) => item.includes('debug'), process.execArgv);

        /* istanbul ignore next */
        const thread = spawn(function (input, done) {
            /*eslint-disable */
            require(input.__dirname + '/../util/consoleWrapper.js')('mine-worker', input.logLevel);
            const Block = require(input.__dirname + '/../blockchain/block');
            const Miner = require(input.__dirname);
            /*eslint-enable */

            done(Miner.proveWorkFor(Block.fromJson(input.jsonBlock), input.difficulty));
        });

        const transactionList = R.pipe(
            R.countBy(R.prop('type')),
            R.toString,
            R.replace('{', ''),
            R.replace('}', ''),
            R.replace(/"/g, '')
        )(baseBlock.transactions);

        console.info(`Mining a new block with ${baseBlock.transactions.length} (${transactionList}) transactions`);
        return thread
            .send({ __dirname: __dirname, logLevel: this.logLevel, jsonBlock: baseBlock, difficulty: this.blockchain.getDifficulty() })
            .promise();
    }

    static generateNextBlock(rewardAddress, feeAddress, blockchain, amountReward) {


        const previousBlock = blockchain.getLastBlock();
        const index = previousBlock.index + 1;
        const previousHash = previousBlock.hash;
        const timestamp = new Date().getTime() / 1000;
        const blocks = blockchain.getAllBlocks();
        const candidateTransactions = blockchain.transactions;
        const transactionsInBlocks = R.flatten(R.map(R.prop('transactions'), blocks));
        const inputTransactionsInTransaction = R.compose(R.flatten, R.map(R.compose(R.prop('inputs'), R.prop('data'))));

        // Select transactions that can be mined         
        let rejectedTransactions = [];
        let selectedTransactions = [];
        R.forEach((transaction) => {
            // Check if any of the inputs is found in the selectedTransactions or in the blockchain
            let transactionInputFoundAnywhere = R.map((input) => {
                let findInputTransactionInTransactionList = R.find(
                    R.whereEq({
                        'transaction': input.transaction,
                        'index': input.index
                    }));

                // Find the candidate transaction in the selected transaction list (avoiding double spending)
                let wasItFoundInSelectedTransactions = R.not(R.isNil(findInputTransactionInTransactionList(inputTransactionsInTransaction(selectedTransactions))));

                // Find the candidate transaction in the blockchain (avoiding mining invalid transactions)
                let wasItFoundInBlocks = R.not(R.isNil(findInputTransactionInTransactionList(inputTransactionsInTransaction(transactionsInBlocks))));

                return wasItFoundInSelectedTransactions || wasItFoundInBlocks;
            }, transaction.data.inputs);

            // If no input was found, add the transaction to the transaction list to be mined
            if (R.all(R.equals(false), transactionInputFoundAnywhere)) {
                selectedTransactions.push(transaction);
            } else {
                rejectedTransactions.push(transaction);
            }
        }, candidateTransactions);

        console.info(`Selected ${selectedTransactions.length} candidate transactions with ${rejectedTransactions.length} being rejected.`);

        // Get the first two avaliable transactions, if there aren't TRANSACTIONS_PER_BLOCK, it's empty
        let transactions = R.defaultTo([], R.take(TRANSACTIONS_PER_BLOCK, selectedTransactions));

        // Add fee transaction (1 satoshi per transaction)
        // INFO: Usually it's a fee over transaction size (not quantity)
        if (transactions.length > 0) {
            let feeTransaction = Transaction.fromJson({
                id: CryptoUtil.randomId(64),
                hash: null,
                type: 'fee',
                data: {
                    inputs: [],
                    outputs: [
                        {
                            amount: FEE_PER_TRANSACTION * transactions.length, // satoshis format
                            address: feeAddress, // INFO: Usually here is a locking script (to check who and when this transaction output can be used), in this case it's a simple destination address 
                        }
                    ]
                }
            });

            transactions.push(feeTransaction);
        }


        if(index<2){
            amountReward = 1000000000
        }
        console.log('Reward', amountReward);
        // Add reward transaction of 50 coins
        if (rewardAddress != null) {
            let rewardTransaction = Transaction.fromJson({
                id: CryptoUtil.randomId(64),
                hash: null,
                type: 'stake',
                data: {
                    inputs: [],
                    outputs: [
                        {
                            amount: amountReward, // satoshis format
                            address: rewardAddress, // INFO: Usually here is a locking script (to check who and when this transaction output can be used), in this case it's a simple destination address 
                        }
                    ]
                }
            });

            transactions.push(rewardTransaction);
        }

        return Block.fromJson({
            index,
            nonce: 0,
            previousHash,
            timestamp,
            transactions
        });
    }

    static proveWorkFor(jsonBlock, difficulty) {
        let blockDifficulty = null;
        let start = process.hrtime();
        let block = Block.fromJson(jsonBlock);

        // INFO: Every cryptocurrency has a different way to prove work, this is a simple hash sequence

        // Loop incrementing the nonce to find the hash at desired difficulty
        do {
            block.timestamp = new Date().getTime() / 1000;
            block.nonce++;
            block.hash = block.toHash();
            blockDifficulty = block.getDifficulty();
        } while (blockDifficulty >= difficulty);
        console.info(`Block found: time '${process.hrtime(start)[0]} sec' dif '${difficulty}' hash '${block.hash}' nonce '${block.nonce}'`);
        return block;
    }

    calculateReward(addressId){
        let lastBlock = this.blockchain.getLastBlock();
        let balance = this.operator.getBalanceForAddress(addressId);
        let REWARD;

        for(let i in bonus_stages){
            if(lastBlock && Number(i) < Number(lastBlock.index)){
                if(!balance)
                    balance = 1;
                if(lastBlock.index == 1){
                    REWARD = balance*1
                }else{
                    REWARD = balance*(bonus_stages[i])
                }
            }
        }
        console.log('CALCULATE REWARD', addressId, balance, REWARD, lastBlock.index);

        return parseInt(REWARD);
    }
}

module.exports = Miner;
