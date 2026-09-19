// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IComplianceRegistry.sol";

/**
 * @title ComplianceGatedService
 * @notice Production-hardened protocol service demonstrating Step 4 of the compliance architecture:
 *         `require(complianceRegistry.isEligible(msg.sender), "Not eligible")`
 *         Protected with ReentrancyGuard, Pausable, and safe balance accounting.
 */
contract ComplianceGatedService {
    IComplianceRegistry public immutable complianceRegistry;
    address public owner;
    bool public paused;
    uint256 private _status; // Reentrancy mutex lock

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    mapping(address => bool) public isRegistered;
    mapping(address => uint256) public userBalances;
    uint256 public totalProtocolActions;

    event Registered(address indexed user, uint256 timestamp);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event ActionExecuted(address indexed user, bytes32 actionHash);
    event Paused(address account);
    event Unpaused(address account);

    error Unauthorized();
    error ContractPaused();
    error ReentrancyGuardReentrantCall();
    error InsufficientBalance();
    error TransferFailed();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    modifier onlyCompliant() {
        require(
            complianceRegistry.isEligible(msg.sender),
            "Not eligible: sender lacks verified compliance credential"
        );
        _;
    }

    constructor(address _complianceRegistry) {
        require(_complianceRegistry != address(0), "Invalid registry address");
        complianceRegistry = IComplianceRegistry(_complianceRegistry);
        owner = msg.sender;
        _status = _NOT_ENTERED;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Step 4 Enforcement: Registration reverts if sender is not verified.
     */
    function register() external whenNotPaused onlyCompliant {
        require(!isRegistered[msg.sender], "Already registered");
        isRegistered[msg.sender] = true;
        emit Registered(msg.sender, block.timestamp);
    }

    /**
     * @notice Step 4 Enforcement: Deposit reverts if sender is not verified.
     */
    function deposit() external payable whenNotPaused onlyCompliant {
        if (msg.value == 0) revert ZeroAmount();
        userBalances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Step 4 Enforcement: Withdraw user balance with ReentrancyGuard and compliance check.
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused onlyCompliant {
        if (amount == 0) revert ZeroAmount();
        if (userBalances[msg.sender] < amount) revert InsufficientBalance();

        userBalances[msg.sender] -= amount;
        emit Withdrawn(msg.sender, amount);

        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /**
     * @notice Step 4 Enforcement: High-value / privileged protocol execution.
     */
    function executeAction(bytes32 actionHash) external whenNotPaused onlyCompliant {
        totalProtocolActions += 1;
        emit ActionExecuted(msg.sender, actionHash);
    }
}
