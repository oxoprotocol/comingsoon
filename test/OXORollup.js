const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const snarkjs = require("snarkjs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

const WASM_FILE = path.join(__dirname, "../zk/build/rollup_js/rollup.wasm");
const ZKEY_FILE = path.join(__dirname, "../zk/build/rollup_final.zkey");

const N_ACCOUNTS = 8;
const N_TX       = 4;

let poseidon;

async function computeRoot(balances) {
    if (!poseidon) poseidon = await buildPoseidon();
    const inputs = balances.map(b => BigInt(b));
    const hash = poseidon(inputs);
    return poseidon.F.toString(hash);
}

// ZK proof üret
async function makeProof(balances, newBalances, transfers) {
    const oldRoot = await computeRoot(balances);
    const newRoot = await computeRoot(newBalances);

    const input = {
        oldRoot,
        newRoot,
        balances:    balances.map(String),
        newBalances: newBalances.map(String),
        froms:       transfers.map(t => String(t.from)),
        tos:         transfers.map(t => String(t.to)),
        amounts:     transfers.map(t => String(t.amount)),
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_FILE, ZKEY_FILE);
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [a, b, c] = JSON.parse(`[${calldata}]`);

    return { a, b, c, oldRoot: BigInt(publicSignals[0]), newRoot: BigInt(publicSignals[1]) };
}

describe("OXO ZK Rollup", function () {
    this.timeout(120_000); // proof üretimi zaman alır

    let oxoBTC, verifier, rollup;
    let owner, sequencer, user1, user2;
    let initialRoot;

    before(async function () {
        [owner, sequencer, user1, user2] = await ethers.getSigners();
        poseidon = await buildPoseidon();
    });

    async function deploy() {
        // OXOBTC
        const OXOBTC = await ethers.getContractFactory("OXOBTC");
        oxoBTC = await OXOBTC.deploy("oxoBTC Token", "oxoBTC");

        // ZKVerifier (snarkjs'den üretildi) — tam qualified name kullan
        const ZKVerifier = await ethers.getContractFactory("contracts/ZKVerifier.sol:Groth16Verifier");
        verifier = await ZKVerifier.deploy();

        // Başlangıç state root: tüm bakiyeler sıfır
        const zeroBalances = Array(N_ACCOUNTS).fill(0n);
        initialRoot = BigInt(await computeRoot(zeroBalances));

        // OXORollup
        const OXORollup = await ethers.getContractFactory("OXORollup");
        rollup = await OXORollup.deploy(oxoBTC.target, verifier.target, initialRoot);

        // MINTER_ROLE'u bridge test için owner'a ver (normalde BridgeV3'ten gelir)
        const MINTER_ROLE = await oxoBTC.MINTER_ROLE();
        await oxoBTC.grantRole(MINTER_ROLE, owner.address);

        // Sequencer rolü ver
        await rollup.addSequencer(sequencer.address);
    }

    it("should deploy correctly", async function () {
        await deploy();
        expect(rollup.target).to.not.equal(ethers.ZeroAddress);
        expect(await rollup.stateRoot()).to.equal(initialRoot);
        expect(await rollup.batchId()).to.equal(0n);
    });

    it("should register accounts and accept deposits", async function () {
        await deploy();

        // user1'e oxoBTC mint et
        await oxoBTC.mint(user1.address, ethers.parseUnits("1", 8));
        await oxoBTC.connect(user1).approve(rollup.target, ethers.MaxUint256);

        // Deposit
        const depositAmount = ethers.parseUnits("0.5", 8);
        await expect(rollup.connect(user1).deposit(depositAmount))
            .to.emit(rollup, "Deposited")
            .withArgs(user1.address, depositAmount, 0); // ilk hesap index=0

        expect(await rollup.accountCount()).to.equal(1);
        expect(await oxoBTC.balanceOf(rollup.target)).to.equal(depositAmount);
    });

    it("should accept a valid ZK batch proof", async function () {
        // Bu test: contract'ı önceden dolu bakiyelerle deploy eder,
        // proof olarak bu bakiyeler üzerindeki 4 transferi doğrular.

        // Başlangıç bakiyeleri — index 0 ve 1'de 1 oxoBTC
        const bal = [100_000_000n, 100_000_000n, 0n, 0n, 0n, 0n, 0n, 0n];
        const preloadedRoot = BigInt(await computeRoot(bal));

        // OXORollup'u bu root ile deploy et
        const OXOBTC2 = await ethers.getContractFactory("OXOBTC");
        const oxoBTC2 = await OXOBTC2.deploy("oxoBTC Token", "oxoBTC");
        const ZKVerifier2 = await ethers.getContractFactory("contracts/ZKVerifier.sol:Groth16Verifier");
        const verifier2 = await ZKVerifier2.deploy();
        const OXORollup2 = await ethers.getContractFactory("OXORollup");
        const rollup2 = await OXORollup2.deploy(oxoBTC2.target, verifier2.target, preloadedRoot);
        await rollup2.addSequencer(sequencer.address);

        // Contract'a likidite ekle (withdrawal için)
        const MINTER2 = await oxoBTC2.MINTER_ROLE();
        await oxoBTC2.grantRole(MINTER2, owner.address);
        await oxoBTC2.mint(rollup2.target, 200_000_000n);

        // 4 transfer: index 0 ↔ index 1 arasında
        const txs = [
            { from: 0, to: 1, amount: 1_000_000n },
            { from: 1, to: 0, amount: 2_000_000n },
            { from: 0, to: 1, amount: 500_000n  },
            { from: 1, to: 0, amount: 500_000n  },
        ];

        const newBal = [...bal];
        for (const tx of txs) {
            newBal[tx.from] -= tx.amount;
            newBal[tx.to]   += tx.amount;
        }

        console.log("  ZK proof uretiliyor...");
        const { a, b, c, oldRoot, newRoot } = await makeProof(bal, newBal, txs);
        console.log("  Proof hazir. On-chain gonderiliyor...");

        await expect(rollup2.connect(sequencer).submitBatch(oldRoot, newRoot, a, b, c))
            .to.emit(rollup2, "BatchSubmitted")
            .withArgs(1n, oldRoot, newRoot);

        expect(await rollup2.stateRoot()).to.equal(newRoot);
        expect(await rollup2.batchId()).to.equal(1n);
    });

    it("should reject invalid ZK proof", async function () {
        await deploy();

        const zeroRoot = BigInt(await computeRoot(Array(N_ACCOUNTS).fill(0n)));
        const fakeProof = {
            a: ["0x1234", "0x5678"],
            b: [["0x1234", "0x5678"], ["0x1234", "0x5678"]],
            c: ["0x1234", "0x5678"],
        };

        await expect(
            rollup.connect(sequencer).submitBatch(
                zeroRoot, zeroRoot + 1n,
                fakeProof.a, fakeProof.b, fakeProof.c
            )
        ).to.be.reverted;
    });

    it("should reject submitBatch from non-sequencer", async function () {
        await deploy();
        const zeroRoot = BigInt(await computeRoot(Array(N_ACCOUNTS).fill(0n)));
        await expect(
            rollup.connect(user1).submitBatch(
                zeroRoot, zeroRoot,
                ["0x0","0x0"], [["0x0","0x0"],["0x0","0x0"]], ["0x0","0x0"]
            )
        ).to.be.revertedWithCustomError(rollup, "AccessControlUnauthorizedAccount");
    });

    it("should allow sequencer to withdraw for user", async function () {
        await deploy();
        const amount = ethers.parseUnits("0.1", 8);

        // Rollup'a likidite ekle
        await oxoBTC.mint(owner.address, amount);
        await oxoBTC.approve(rollup.target, amount);
        await rollup.deposit(amount); // owner deposit

        const balBefore = await oxoBTC.balanceOf(user1.address);
        await rollup.connect(sequencer).withdraw(user1.address, amount);
        const balAfter = await oxoBTC.balanceOf(user1.address);

        expect(balAfter - balBefore).to.equal(amount);
    });
});
