// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24; 

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./OXOBTC.sol";

contract Bridge is AccessControl {
    // .recover() metodunu kullanmak için bu satırı tutuyoruz.
    using ECDSA for bytes32; 

    OXOBTC public oxoToken;
    address public signer; 

    event RedeemRequested(address indexed _ethAddress, string _btcAddress, uint256 _amount);

    uint256 public constant MIN_REDEMPTION_AMOUNT = 1000;

    constructor(address _oxoTokenAddress, address _signerAddress) {
        oxoToken = OXOBTC(_oxoTokenAddress);
        signer = _signerAddress;
    }

    // ===============================================
    // 1. BTC → ETH (Mint) Akışı
    // ===============================================
    function mintAndTransfer(
        address _to,
        uint256 _amount,
        bytes memory _signature
    ) external {
        // 1. Güvenli Digest oluşturma (server.js'deki keccak256(abi.encode) ile uyumlu)
        bytes32 digest = keccak256(abi.encode(_to, _amount)); 
        
        // 2. KRİTİK ÇÖZÜM: toEthSignedMessageHash fonksiyonu kaldırıldığı için,
        // Ethereum'un standart imza ön ekini (prefix) manuel olarak uyguluyoruz.
        bytes32 ethSignedDigest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );

        // 3. İmza kurtarma (ECDSA for bytes32 sayesinde .recover() kullanabiliriz)
        address recoveredAddress = ethSignedDigest.recover(_signature);

        // 4. İmza kontrolü
        require(recoveredAddress == signer, "Invalid signature");

        // 5. Token basma
        oxoToken.mint(_to, _amount);
    }

    // ===============================================
    // 2. ETH → BTC (Redeem) Akışı
    // ===============================================
    function withdraw(string memory _btcAddress, uint256 _amount) external {
        require(_amount >= MIN_REDEMPTION_AMOUNT, "Withdraw amount is too low");
        
        require(
            oxoToken.allowance(msg.sender, address(this)) >= _amount,
            "Bridge not approved to spend tokens or allowance insufficient"
        );

        oxoToken.burnFrom(msg.sender, _amount);
        
        emit RedeemRequested(msg.sender, _btcAddress, _amount);
    }
}