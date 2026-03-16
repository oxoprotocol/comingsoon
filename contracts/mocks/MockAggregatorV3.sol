// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test ortamında Chainlink BTC/USD feed'ini simüle eder
contract MockAggregatorV3 {
    int256  public price;
    uint256 public updatedAt;
    uint8   public constant decimals = 8;

    constructor(int256 _price) {
        price     = _price;
        updatedAt = block.timestamp;
    }

    function latestRoundData()
        external view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, price, block.timestamp, updatedAt, 1);
    }

    function setPrice(int256 _price) external {
        price     = _price;
        updatedAt = block.timestamp;
    }

    function setStale() external {
        updatedAt = block.timestamp - 7200; // 2 saat önce → stale
    }
}
