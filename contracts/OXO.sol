// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OXO Protocol Token
 * @dev Bu, OXO ekosisteminin yönetişim ve utility token'ıdır.
 * Kontratı dağıtan kişi (deployer) başlangıçta tüm token arzına sahip olur.
 */
contract OXO is ERC20, Ownable {
    constructor() ERC20("OXO Protocol Token", "OXO") Ownable(msg.sender) {
        // Başlangıç arzı: 50 Milyon OXO token.
        // 18 ondalık basamağı olduğu için 10**18 ile çarpıyoruz.
        _mint(msg.sender, 50_000_000 * (10**18));
    }
}