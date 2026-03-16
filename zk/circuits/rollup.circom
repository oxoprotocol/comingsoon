pragma circom 2.0.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";

// ─────────────────────────────────────────────────────────────────────────────
// Selector: balances[index] değerini seçer (variable-index array erişimi)
// ─────────────────────────────────────────────────────────────────────────────
template Selector(n) {
    signal input vals[n];
    signal input index;
    signal output out;

    component eq[n];
    signal selected[n];

    for (var i = 0; i < n; i++) {
        eq[i] = IsEqual();
        eq[i].in[0] <== index;
        eq[i].in[1] <== i;
        selected[i] <== eq[i].out * vals[i];
    }

    var acc = 0;
    for (var i = 0; i < n; i++) {
        acc += selected[i];   // compile-time akümülasyon değil, sinyal gerekiyor
    }

    // Signal akümülasyonu
    signal sums[n];
    sums[0] <== selected[0];
    for (var i = 1; i < n; i++) {
        sums[i] <== sums[i-1] + selected[i];
    }
    out <== sums[n-1];
}

// ─────────────────────────────────────────────────────────────────────────────
// OXO Rollup Ana Devresi
//
// Kanıtlar:
//   1. oldRoot = Poseidon(balances[0..7])
//   2. sum(balances) == sum(newBalances)  → token korunumu
//   3. Her transfer: amount > 0
//   4. newRoot = Poseidon(newBalances[0..7])
//
// Public:  oldRoot, newRoot
// Private: balances[8], newBalances[8], froms[4], tos[4], amounts[4]
// ─────────────────────────────────────────────────────────────────────────────
template OXORollup(nTx, nAccounts) {
    signal input oldRoot;
    signal input newRoot;

    signal input balances[nAccounts];
    signal input newBalances[nAccounts];
    signal input froms[nTx];
    signal input tos[nTx];
    signal input amounts[nTx];

    // ── 1. oldRoot = Poseidon(balances) ─────────────────────────────────────
    component oldHasher = Poseidon(nAccounts);
    for (var i = 0; i < nAccounts; i++) {
        oldHasher.inputs[i] <== balances[i];
    }
    oldHasher.out === oldRoot;

    // ── 2. Token korunumu: toplam değişmemeli ────────────────────────────────
    signal sumOld[nAccounts];
    signal sumNew[nAccounts];
    sumOld[0] <== balances[0];
    sumNew[0] <== newBalances[0];
    for (var i = 1; i < nAccounts; i++) {
        sumOld[i] <== sumOld[i-1] + balances[i];
        sumNew[i] <== sumNew[i-1] + newBalances[i];
    }
    sumOld[nAccounts-1] === sumNew[nAccounts-1];

    // ── 3. Her transfer için amount > 0 ──────────────────────────────────────
    component amtIsZero[nTx];
    for (var t = 0; t < nTx; t++) {
        amtIsZero[t] = IsZero();
        amtIsZero[t].in <== amounts[t];
        amtIsZero[t].out === 0;  // amount sıfır olmamalı
    }

    // ── 4. Gönderenin bakiyesi yeterli mi? ───────────────────────────────────
    // balances[froms[t]] >= amounts[t] kontrolü
    component fromSel[nTx];
    component enoughBal[nTx];
    for (var t = 0; t < nTx; t++) {
        fromSel[t] = Selector(nAccounts);
        fromSel[t].index <== froms[t];
        for (var i = 0; i < nAccounts; i++) {
            fromSel[t].vals[i] <== balances[i];
        }
        // balances[from] >= amount → balances[from] - amount >= 0
        enoughBal[t] = GreaterEqThan(64);
        enoughBal[t].in[0] <== fromSel[t].out;
        enoughBal[t].in[1] <== amounts[t];
        enoughBal[t].out === 1;
    }

    // ── 5. newRoot = Poseidon(newBalances) ───────────────────────────────────
    component newHasher = Poseidon(nAccounts);
    for (var i = 0; i < nAccounts; i++) {
        newHasher.inputs[i] <== newBalances[i];
    }
    newHasher.out === newRoot;
}

component main {public [oldRoot, newRoot]} = OXORollup(4, 8);
