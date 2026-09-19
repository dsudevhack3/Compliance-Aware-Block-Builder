// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IComplianceRegistry.sol";

/**
 * @title ComplianceGatedService
 * @notice Protocol service demonstrating Step 4 of the compliance architecture:
 *         `require(complianceRegistry.isEligible(msg.sender), "Not eligible")`
 */
contract ComplianceGatedService {
    IComplianceRegistry public immutable complianceRegistry;
    address public owner;

    mapping(address => bool) public isRegistered;
    mapping(address => uint256) public userBalances;
    uint256 public totalProtocolActions;

    event Registered(address indexed user, uint256 timestamp);
    event Deposited(address indexed user, uint256 amount);
    event ActionExecuted(address indexed user, bytes32 actionHash);

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
    }

    /**
     * @notice Step 4 Enforcement: Registration reverts if sender is not verified.
     */
    function register() external onlyCompliant {
        require(!isRegistered[msg.sender], "Already registered");
        isRegistered[msg.sender] = true;
        emit Registered(msg.sender, block.timestamp);
    }

    /**
     * @notice Step 4 Enforcement: Deposit reverts if sender is not verified.
     */
    function deposit() external payable onlyCompliant {
        require(msg.value > 0, "Zero deposit");
        userBalances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Step 4 Enforcement: High-value / privileged protocol execution.
     */
    function executeAction(bytes32 actionHash) external onlyCompliant {
        totalProtocolActions += 1;
        emit ActionExecuted(msg.sender, actionHash);
    }
}
