// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IZKVerifier {
    function verifyProof(
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c,
        uint[2] calldata pubSignals
    ) external view returns (bool);
}

/// @title OXO ZK Rollup
/// @notice OXOBTC transfers are verified in batches with ZK proofs
/// @dev State root = Poseidon(balances[0..7])
contract OXORollup is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");

    IERC20      public immutable oxoBTC;
    IZKVerifier public immutable verifier;

    uint256 public stateRoot;
    uint256 public batchId;

    uint8 public constant MAX_ACCOUNTS = 8;
    address[MAX_ACCOUNTS] public accounts;
    uint8  public accountCount;
    mapping(address => uint8)   public accountIndex; // 1-based (0 = not registered)
    mapping(address => uint256) public pendingDeposits;

    event Deposited(address indexed user, uint256 amount, uint8 accountIdx);
    event BatchSubmitted(uint256 indexed batchId, uint256 oldRoot, uint256 newRoot);
    event Withdrawn(address indexed user, uint256 amount);
    event AccountRegistered(address indexed user, uint8 index);

    constructor(address _oxoBTC, address _verifier, uint256 _initialRoot) {
        require(_oxoBTC   != address(0), "Invalid token");
        require(_verifier != address(0), "Invalid verifier");

        oxoBTC    = IERC20(_oxoBTC);
        verifier  = IZKVerifier(_verifier);
        stateRoot = _initialRoot;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SEQUENCER_ROLE, msg.sender);
    }

    // ── Account registration ──────────────────────────────────────────────────

    function registerAccount(address user) external returns (uint8 idx) {
        require(accountIndex[user] == 0, "Already registered");
        require(accountCount < MAX_ACCOUNTS, "Max accounts reached");

        accountCount++;
        idx = accountCount - 1;
        accounts[idx] = user;
        accountIndex[user] = idx + 1; // 1-based

        emit AccountRegistered(user, idx);
    }

    function getAccountIndex(address user) public view returns (uint8) {
        uint8 idx1 = accountIndex[user];
        require(idx1 > 0, "Account not registered");
        return idx1 - 1;
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    function deposit(uint256 amount) external whenNotPaused {
        require(amount > 0, "Zero amount");

        if (accountIndex[msg.sender] == 0) {
            this.registerAccount(msg.sender);
        }

        oxoBTC.safeTransferFrom(msg.sender, address(this), amount);
        pendingDeposits[msg.sender] += amount;

        uint8 idx = getAccountIndex(msg.sender);
        emit Deposited(msg.sender, amount, idx);
    }

    // ── Batch submit ──────────────────────────────────────────────────────────

    function submitBatch(
        uint256 oldRoot,
        uint256 newRoot,
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c
    ) external onlyRole(SEQUENCER_ROLE) whenNotPaused {
        require(oldRoot == stateRoot, "oldRoot mismatch");

        uint[2] memory pubSignals = [oldRoot, newRoot];
        require(verifier.verifyProof(a, b, c, pubSignals), "Invalid ZK proof");

        stateRoot = newRoot;
        batchId++;

        emit BatchSubmitted(batchId, oldRoot, newRoot);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function withdraw(address user, uint256 amount)
        external onlyRole(SEQUENCER_ROLE) whenNotPaused
    {
        require(amount > 0, "Zero amount");
        require(oxoBTC.balanceOf(address(this)) >= amount, "Insufficient liquidity");

        oxoBTC.safeTransfer(user, amount);
        emit Withdrawn(user, amount);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function pause()   external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function addSequencer(address seq) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(SEQUENCER_ROLE, seq);
    }

    function emergencyWithdraw() external onlyRole(DEFAULT_ADMIN_ROLE) whenPaused {
        uint256 bal = oxoBTC.balanceOf(address(this));
        if (bal > 0) oxoBTC.safeTransfer(msg.sender, bal);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
