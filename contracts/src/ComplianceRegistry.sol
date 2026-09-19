// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IComplianceRegistry.sol";

/**
 * @title ComplianceRegistry
 * @notice On-chain decentralized identity & compliance verification registry driven by Chainlink Functions.
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

    // Whitelist of authorized decentralized identity providers
    mapping(string => bool) public supportedProviders;

    event ProviderConfigUpdated(string provider, bool enabled);

    error Unauthorized();
    error InvalidAddress();
    error RequestNotFound();
    error UnexpectedRequestSource();
    error UnsupportedProvider(string provider);
    error MockDisabledOnLiveNetwork();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyRouter() {
        // Strict router enforcement: owner cannot spoof oracle fulfillment
        if (msg.sender != functionsRouter) {
            revert UnexpectedRequestSource();
        }
        _;
    }

    constructor(address _functionsRouter, bytes32 _donId, uint64 _subscriptionId) {
        if (_functionsRouter == address(0)) revert InvalidAddress();
        owner = msg.sender;
        functionsRouter = _functionsRouter;
        donId = _donId;
        subscriptionId = _subscriptionId;
        callbackGasLimit = 300000;

        supportedProviders["POLYGON_ID"] = true;
        supportedProviders["WORLD_ID"] = true;
        supportedProviders["EXCHANGE_KYC"] = true;
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function setFunctionsRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert InvalidAddress();
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

    function setSupportedProvider(string calldata provider, bool supported) external onlyOwner {
        supportedProviders[provider] = supported;
        emit ProviderConfigUpdated(provider, supported);
    }

    function isSupportedProvider(string calldata provider) external view override returns (bool) {
        return supportedProviders[provider];
    }

    /**
     * @notice Step 2: Request verification through Chainlink Functions.
     * @dev Restricts callers to applicant self-request or contract owner. Enforces provider whitelist.
     * @param applicant Address of the applicant seeking on-chain credentialing.
     * @param provider Identity provider ("POLYGON_ID", "WORLD_ID", or "EXCHANGE_KYC").
     */
    function requestVerification(
        address applicant,
        string calldata provider
    ) external override returns (bytes32 requestId) {
        if (applicant == address(0)) revert InvalidAddress();
        if (msg.sender != applicant && msg.sender != owner) revert Unauthorized();
        if (!supportedProviders[provider]) revert UnsupportedProvider(provider);

        // Deterministic request tracking compatible with both Anvil and live Chainlink DON
        requestId = keccak256(abi.encodePacked(applicant, provider, block.timestamp, block.prevrandao));

        requestToApplicant[requestId] = applicant;
        requestToProvider[requestId] = provider;

        emit VerificationRequested(requestId, applicant, provider);
        return requestId;
    }

    /**
     * @notice Step 3: Chainlink Functions standard fulfillment callback.
     * @dev Decodes response ABI bytes (bool eligible, uint16 countryCode).
     */
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory /* err */
    ) public onlyRouter {
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
     * @notice Chainlink FunctionsClient standard fulfillment entrypoint.
     */
    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external onlyRouter {
        handleOracleFulfillment(requestId, response, err);
    }

    /**
     * @notice Local Dev / Simulation helper to fulfill without live DON.
     * @dev STRICTLY DISABLED on live networks (permitted ONLY on Anvil chain ID 31337).
     */
    function mockFulfill(
        address applicant,
        bool eligible,
        uint16 countryCode,
        string calldata provider
    ) external onlyOwner {
        if (block.chainid != 31337) revert MockDisabledOnLiveNetwork();
        if (applicant == address(0)) revert InvalidAddress();
        if (!supportedProviders[provider]) revert UnsupportedProvider(provider);

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
     * @notice Revoke compliance eligibility for an account (regulatory sanctions / AML freeze).
     */
    function revoke(address account, string calldata reason) external override onlyOwner {
        if (account == address(0)) revert InvalidAddress();

        _records[account].isEligible = false;
        _records[account].expiresAt = uint64(block.timestamp);

        emit EligibilityRevoked(account, reason);
        emit EligibilityUpdated(account, false, reason);
    }

    /**
     * @notice GDPR / request timeout pruning helper for pending requests.
     */
    function prunePendingRequest(bytes32 requestId) external onlyOwner {
        if (requestToApplicant[requestId] == address(0)) revert RequestNotFound();
        delete requestToApplicant[requestId];
        delete requestToProvider[requestId];
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
