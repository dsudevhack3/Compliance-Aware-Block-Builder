// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IComplianceRegistry.sol";

/**
 * @title ComplianceRegistry
 * @notice On-chain identity & compliance verification registry driven by Chainlink Functions.
 *
 * Flow:
 *  Step 1: Applicant gets verified off-chain (Polygon ID, World ID, or Exchange KYC).
 *  Step 2: Chainlink Functions calls out to the identity provider/verifier to check credentials.
 *  Step 3: Chainlink Functions router fulfills the request, writing eligibility to `isEligible[applicant]`.
 *  Step 4: Smart contracts enforce `require(registry.isEligible(msg.sender), "Not eligible")`.
 */
contract ComplianceRegistry is IComplianceRegistry {
    address public owner;
    address public functionsRouter;
    bytes32 public donId;
    uint64 public subscriptionId;
    uint32 public callbackGasLimit;

    // Mapping: applicant address => identity record
    mapping(address => IdentityRecord) private _records;

    // Mapping: Chainlink requestId => applicant address
    mapping(bytes32 => address) public requestToApplicant;
    mapping(bytes32 => string) public requestToProvider;

    error Unauthorized();
    error InvalidAddress();
    error RequestNotFound();
    error UnexpectedRequestSource();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != functionsRouter && msg.sender != owner) {
            revert UnexpectedRequestSource();
        }
        _;
    }

    constructor(address _functionsRouter, bytes32 _donId, uint64 _subscriptionId) {
        owner = msg.sender;
        functionsRouter = _functionsRouter;
        donId = _donId;
        subscriptionId = _subscriptionId;
        callbackGasLimit = 300000;
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function setFunctionsRouter(address _router) external onlyOwner {
        functionsRouter = _router;
    }

    function setSubscriptionId(uint64 _subId) external onlyOwner {
        subscriptionId = _subId;
    }

    function setDonId(bytes32 _donId) external onlyOwner {
        donId = _donId;
    }

    function setCallbackGasLimit(uint32 _gasLimit) external onlyOwner {
        callbackGasLimit = _gasLimit;
    }

    /**
     * @notice Step 2: Request verification through Chainlink Functions.
     * @param applicant Address of the applicant seeking on-chain credentialing.
     * @param provider Identity provider ("POLYGON_ID", "WORLD_ID", or "EXCHANGE_KYC").
     */
    function requestVerification(
        address applicant,
        string calldata provider
    ) external override returns (bytes32 requestId) {
        if (applicant == address(0)) revert InvalidAddress();

        // In a live testnet environment with @chainlink/contracts, this invokes `_sendRequest(...)`
        // Generating deterministic requestId for simulation / tracking
        requestId = keccak256(abi.encodePacked(applicant, provider, block.timestamp, block.prevrandao));

        requestToApplicant[requestId] = applicant;
        requestToProvider[requestId] = provider;

        emit VerificationRequested(requestId, applicant, provider);
        return requestId;
    }

    /**
     * @notice Step 3: Chainlink Functions fulfillment callback.
     * @dev Decodes response ABI bytes (bool eligible, uint16 countryCode, uint64 expirySecs).
     */
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory /* err */
    ) external onlyRouter {
        address applicant = requestToApplicant[requestId];
        if (applicant == address(0)) revert RequestNotFound();

        string memory provider = requestToProvider[requestId];

        bool eligible = false;
        uint16 countryCode = 0;
        uint64 validityDuration = 365 days;

        if (response.length > 0) {
            (eligible, countryCode) = abi.decode(response, (bool, uint16));
        }

        uint64 nowTime = uint64(block.timestamp);
        uint64 expiresAt = eligible ? nowTime + validityDuration : 0;

        _records[applicant] = IdentityRecord({
            isEligible: eligible,
            nationalityCountryCode: countryCode,
            verifiedAt: nowTime,
            expiresAt: expiresAt,
            provider: provider
        });

        delete requestToApplicant[requestId];
        delete requestToProvider[requestId];

        emit VerificationFulfilled(requestId, applicant, eligible, provider);
        emit EligibilityUpdated(applicant, eligible, provider);
    }

    /**
     * @notice Local Dev / Simulation helper to fulfill or test without live DON.
     */
    function mockFulfill(
        address applicant,
        bool eligible,
        uint16 countryCode,
        string calldata provider
    ) external onlyOwner {
        if (applicant == address(0)) revert InvalidAddress();

        uint64 nowTime = uint64(block.timestamp);
        uint64 expiresAt = eligible ? nowTime + 365 days : 0;

        _records[applicant] = IdentityRecord({
            isEligible: eligible,
            nationalityCountryCode: countryCode,
            verifiedAt: nowTime,
            expiresAt: expiresAt,
            provider: provider
        });

        emit EligibilityUpdated(applicant, eligible, provider);
    }

    /**
     * @notice Step 4 check: Returns true if the account has valid, unexpired eligibility.
     */
    function isEligible(address account) external view override returns (bool) {
        IdentityRecord memory record = _records[account];
        if (!record.isEligible) {
            return false;
        }
        if (record.expiresAt != 0 && record.expiresAt <= block.timestamp) {
            return false;
        }
        return true;
    }

    /**
     * @notice Get full identity details for an account.
     */
    function getIdentityRecord(address account) external view override returns (IdentityRecord memory) {
        return _records[account];
    }
}
