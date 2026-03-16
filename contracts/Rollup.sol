// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Rollup {
    // State variables
    address public verifier; // Adres for ZK proof verification contract
    uint256 public nextBatchId; // Counter for new transaction batches
    
    // Events
    event BatchSubmitted(uint256 indexed batchId, bytes32 indexed rootHash);

    // Constructor
    constructor(address _verifier) {
        require(_verifier != address(0), "Verifier address cannot be zero");
        verifier = _verifier;
        nextBatchId = 0;
    }

    // Function to submit a new transaction batch to the rollup
    function submitBatch(
        bytes memory _proof, // ZK proof for the batch
        bytes32 _newRootHash // New state root hash after applying transactions
    ) external {
        // Step 1: Verify the ZK proof on-chain
        require(IVerifier(verifier).verifyProof(_proof), "Invalid ZK proof");
        
        // Step 2: Update the state root hash and submit the batch
        // (Implementation for state update will be added later)
        
        emit BatchSubmitted(nextBatchId, _newRootHash);
        nextBatchId++;
    }
}

// Interface for the Verifier Contract
interface IVerifier {
    function verifyProof(bytes memory _proof) external view returns (bool);
}