// state.js — Off-chain rollup state yöneticisi
const { buildPoseidon } = require("circomlibjs");

const MAX_ACCOUNTS = 8;
const BATCH_SIZE   = 4;

let poseidon = null;
async function getPoseidon() {
    if (!poseidon) poseidon = await buildPoseidon();
    return poseidon;
}

async function computeRoot(balances) {
    const p = await getPoseidon();
    const inputs = balances.map(b => BigInt(b));
    const hash = p(inputs);
    return p.F.toString(hash);
}

class RollupState {
    constructor() {
        this.balances     = Array(MAX_ACCOUNTS).fill(0n);
        this.accounts     = Array(MAX_ACCOUNTS).fill(null); // address → idx
        this.accountMap   = {};  // address → idx (number)
        this.accountCount = 0;
        this.pendingTxs   = [];  // [{from, to, amount}]
        this.stateRoot    = null;
        this.batchId      = 0;
    }

    async init() {
        this.stateRoot = await computeRoot(this.balances);
        console.log(`[State] Başlangıç state root: ${this.stateRoot}`);
    }

    registerAccount(address) {
        address = address.toLowerCase();
        if (this.accountMap[address] !== undefined) {
            return this.accountMap[address];
        }
        if (this.accountCount >= MAX_ACCOUNTS) throw new Error("Max hesap sayısına ulaşıldı");
        const idx = this.accountCount++;
        this.accounts[idx] = address;
        this.accountMap[address] = idx;
        console.log(`[State] Hesap kaydedildi: ${address} → index ${idx}`);
        return idx;
    }

    getBalance(address) {
        address = address.toLowerCase();
        const idx = this.accountMap[address];
        if (idx === undefined) return 0n;
        return this.balances[idx];
    }

    addDeposit(address, amount) {
        address = address.toLowerCase();
        const idx = this.registerAccount(address);
        this.balances[idx] += BigInt(amount);
        console.log(`[State] Deposit: ${address} +${amount} (yeni: ${this.balances[idx]})`);
    }

    addTransfer(fromAddr, toAddr, amount) {
        fromAddr = fromAddr.toLowerCase();
        toAddr   = toAddr.toLowerCase();
        amount   = BigInt(amount);

        const fromIdx = this.accountMap[fromAddr];
        const toIdx   = this.accountMap[toAddr];

        if (fromIdx === undefined) throw new Error(`Gönderen hesap kayıtlı değil: ${fromAddr}`);
        if (toIdx   === undefined) throw new Error(`Alıcı hesap kayıtlı değil: ${toAddr}`);
        if (fromIdx === toIdx)     throw new Error("from == to olamaz");
        if (this.balances[fromIdx] < amount) throw new Error(`Yetersiz bakiye: ${fromAddr}`);
        if (amount <= 0n)          throw new Error("Sıfır miktar");

        this.pendingTxs.push({ from: fromIdx, to: toIdx, amount });
        this.balances[fromIdx] -= amount;
        this.balances[toIdx]   += amount;

        console.log(`[State] Transfer kuyruğa eklendi: ${fromAddr}(${fromIdx}) → ${toAddr}(${toIdx}) ${amount}`);
        return this.pendingTxs.length;
    }

    async prepareBatch() {
        if (this.pendingTxs.length < BATCH_SIZE) return null;

        const txs    = this.pendingTxs.splice(0, BATCH_SIZE);
        const oldBal = [...this.balances]; // snapshot (already updated)
        const newBal = [...this.balances];

        // Balances already updated in addTransfer — reconstruct old balances
        // (Reverse the batch to get pre-batch state)
        const oldBalances = [...newBal];
        for (let i = txs.length - 1; i >= 0; i--) {
            const { from, to, amount } = txs[i];
            oldBalances[from] += amount;
            oldBalances[to]   -= amount;
        }

        const oldRoot = await computeRoot(oldBalances);
        const newRoot = await computeRoot(newBal);

        this.stateRoot = newRoot;
        this.batchId++;

        return {
            oldBalances: oldBalances.map(String),
            newBalances: newBal.map(String),
            transfers:   txs,
            oldRoot,
            newRoot,
        };
    }

    deductBalance(address, amount) {
        address = address.toLowerCase();
        amount  = BigInt(amount);
        const idx = this.accountMap[address];
        if (idx === undefined) throw new Error(`Hesap kayıtlı değil: ${address}`);
        if (amount <= 0n)      throw new Error("Sıfır miktar");
        if (this.balances[idx] < amount) throw new Error(`Yetersiz L2 bakiye: ${this.balances[idx]}`);
        this.balances[idx] -= amount;
        console.log(`[State] Withdraw: ${address} -${amount} (kalan: ${this.balances[idx]})`);
    }

    async getStateRoot() {
        return this.stateRoot || await computeRoot(this.balances);
    }

    summary() {
        return {
            stateRoot:    this.stateRoot,
            batchId:      this.batchId,
            accountCount: this.accountCount,
            pendingTxs:   this.pendingTxs.length,
            accounts: this.accounts.slice(0, this.accountCount).map((addr, i) => ({
                index: i, address: addr, balance: this.balances[i].toString()
            }))
        };
    }
}

module.exports = { RollupState, computeRoot, BATCH_SIZE, MAX_ACCOUNTS };
