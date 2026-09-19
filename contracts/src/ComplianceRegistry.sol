// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import "./IComplianceRegistry.sol";

/**
 * @title ComplianceRegistry
 * @notice On-chain decentralized identity & compliance verification registry driven by Chainlink Functions.
 *
 * Flow:
 *  Step 1: Applicant gets verified off-chain (Polygon ID, World ID, or Exchange KYC).
 *  Step 2: requestVerification() sends args [wallet, provider, proof] to the DON
 *          via FunctionsClient._sendRequest with DON-hosted secrets.
 *  Step 3: fulfillRequest() (router-only) decodes (bool eligible, uint16 country),
 *          enforces the 408/792/104 blocklist fail-closed, writes IdentityRecord.
 *  Step 4: Smart contracts enforce `require(registry.isEligible(msg.sender), "Not eligible")`.
 *
 * Sepolia defaults:
 *  Router: 0xb83e47c2bC239B31ab286eA3DD212D87F0C7D77D
 *  DON ID: fun-ethereum-sepolia-1
 *
 * Demo fallback: scripts/functions/verifyIdentity.demo.js + mockFulfill() for Anvil
 *  without LINK. mockFulfill() is STRICTLY DISABLED on live networks (Anvil 31337 only).
 */
contract ComplianceRegistry is FunctionsClient, IComplianceRegistry {
    using FunctionsRequest for FunctionsRequest.Request;

    address public owner;
    bytes32 public donId;
    uint64 public subscriptionId;
    uint32 public callbackGasLimit;

    /// @notice Inline JS source (production verifyIdentity.js). Updateable without redeploy.
    string public jsSource;
    /// @notice DON-hosted secrets pointer. Set useDonSecrets=true after upload.
    uint8 public secretsSlot;
    uint64 public secretsVersion;
    bool public useDonSecrets;

    // Mapping: applicant address => identity record
    mapping(address => IdentityRecord) private _records;

    // Mapping: Chainlink requestId => applicant address
    mapping(bytes32 => address) public requestToApplicant;
    mapping(bytes32 => string) public requestToProvider;

    // 408 PRK North Korea, 792 TUR Turkey, 104 MMR Myanmar
    mapping(uint16 => bool) public blockedCountryCode;

    // Whitelist of authorized decentralized identity providers
    mapping(string => bool) public supportedProviders;

    event ProviderConfigUpdated(string provider, bool enabled);
    event SourceUpdated();
    event SecretsUpdated(uint8 slotId, uint64 version, bool enabled);

    error Unauthorized();
    error InvalidAddress();
    error RequestNotFound();
    error EmptySource();
    error UnsupportedProvider(string provider);
    error MockDisabledOnLiveNetwork();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address _router,
        bytes32 _donId,
        uint64 _subscriptionId,
        string memory _jsSource
    ) FunctionsClient(_router) {
        if (_router == address(0)) revert InvalidAddress();
        owner = msg.sender;
        donId = _donId;
        subscriptionId = _subscriptionId;
        callbackGasLimit = 300_000;
        jsSource = _jsSource;
        // Blocked nationalities: North Korea, Turkey, Myanmar.
        blockedCountryCode[408] = true;
        blockedCountryCode[792] = true;
        blockedCountryCode[104] = true;

        supportedProviders["POLYGON_ID"] = true;
        supportedProviders["WORLD_ID"] = true;
        supportedProviders["EXCHANGE_KYC"] = true;
    }

    // --- Owner config ---
    function setOwner(address n) external onlyOwner {
        if (n == address(0)) revert InvalidAddress();
        owner = n;
    }
    function setDonId(bytes32 d) external onlyOwner { donId = d; }
    function setSubscriptionId(uint64 s) external onlyOwner { subscriptionId = s; }
    function setCallbackGasLimit(uint32 g) external onlyOwner { callbackGasLimit = g; }
    function setSource(string calldata s) external onlyOwner {
        if (bytes(s).length == 0) revert EmptySource();
        jsSource = s;
        emit SourceUpdated();
    }
    function setSecrets(uint8 slotId, uint64 version, bool enabled) external onlyOwner {
        secretsSlot = slotId;
        secretsVersion = version;
        useDonSecrets = enabled;
        emit SecretsUpdated(slotId, version, enabled);
    }
    function setCountryBlocked(uint16 code, bool blocked) external onlyOwner {
        blockedCountryCode[code] = blocked;
    }
    function isBlockedCountry(uint16 code) public view returns (bool) {
        return blockedCountryCode[code];
    }
    function functionsRouter() public view returns (address) {
        return address(i_router);
    }

    function setSupportedProvider(string calldata provider, bool supported) external onlyOwner {
        supportedProviders[provider] = supported;
        emit ProviderConfigUpdated(provider, supported);
    }

    function isSupportedProvider(string calldata provider) external view override returns (bool) {
        return supportedProviders[provider];
    }

    /**
     * @notice Step 2 (production): send verification request to the DON.
     * @dev Restricts callers to applicant self-request or contract owner. Enforces provider whitelist.
     * @param applicant Wallet seeking credentialing.
     * @param provider "POLYGON_ID" | "WORLD_ID" | "EXCHANGE_KYC".
     * @param proof Provider proof (ZK proof JSON / World ID proof JSON / KYC reference).
     */
    function requestVerification(
        address applicant,
        string calldata provider,
        string memory proof
    ) public returns (bytes32 requestId) {
        if (applicant == address(0)) revert InvalidAddress();
        if (msg.sender != applicant && msg.sender != owner) revert Unauthorized();
        if (!supportedProviders[provider]) revert UnsupportedProvider(provider);
        if (bytes(jsSource).length == 0) revert EmptySource();

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(jsSource);
        string[] memory args = new string[](3);
        args[0] = _toHex(applicant);
        args[1] = provider;
        args[2] = proof;
        req.setArgs(args);
        if (useDonSecrets) {
            req.addDONHostedSecrets(secretsSlot, secretsVersion);
        }

        requestId = _sendRequest(req.encodeCBOR(), subscriptionId, callbackGasLimit, donId);
        requestToApplicant[requestId] = applicant;
        requestToProvider[requestId] = provider;
        emit VerificationRequested(requestId, applicant, provider);
        return requestId;
    }

    /// @notice IComplianceRegistry compat (no proof — callers with proofs should use 3-arg version).
    function requestVerification(
        address applicant,
        string calldata provider
    ) external override returns (bytes32) {
        return requestVerification(applicant, provider, string(""));
    }

    /**
     * @notice Step 3: router-only fulfillment (via FunctionsClient.handleOracleFulfillment).
     * @dev Decodes response ABI bytes (bool eligible, uint16 countryCode).
     *  Fail-closed: sanctioned nationality can never be eligible.
     */
    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory /* err */
    ) internal override {
        address applicant = requestToApplicant[requestId];
        if (applicant == address(0)) revert RequestNotFound();
        string memory provider = requestToProvider[requestId];

        bool eligible = false;
        uint16 countryCode = 0;
        if (response.length > 0) {
            (eligible, countryCode) = abi.decode(response, (bool, uint16));
        }
        if (blockedCountryCode[countryCode]) eligible = false;

        uint64 now_ = uint64(block.timestamp);
        _records[applicant] = IdentityRecord({
            isEligible: eligible,
            nationalityCountryCode: countryCode,
            verifiedAt: now_,
            expiresAt: eligible ? now_ + 365 days : 0,
            provider: provider
        });

        delete requestToApplicant[requestId];
        delete requestToProvider[requestId];
        emit VerificationFulfilled(requestId, applicant, eligible, provider);
        emit EligibilityUpdated(applicant, eligible, provider);
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
        if (blockedCountryCode[countryCode]) eligible = false;

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
        IdentityRecord memory r = _records[account];
        if (!r.isEligible) return false;
        if (blockedCountryCode[r.nationalityCountryCode]) return false;
        if (r.expiresAt != 0 && r.expiresAt <= block.timestamp) return false;
        return true;
    }

    /**
     * @notice Get full identity details for an account.
     */
    function getIdentityRecord(address account) external view override returns (IdentityRecord memory) {
        return _records[account];
    }

    function _toHex(address a) internal pure returns (string memory) {
        bytes16 h = "0123456789abcdef";
        bytes20 b = bytes20(a);
        bytes memory s = new bytes(42);
        s[0] = "0"; s[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            s[2 + i * 2] = h[uint8(b[i]) >> 4];
            s[3 + i * 2] = h[uint8(b[i]) & 0x0f];
        }
        return string(s);
    }
}
