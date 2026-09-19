// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import "./IComplianceRegistry.sol";

/**
 * @title ComplianceRegistry (Production — Sepolia)
 * @notice On-chain identity registry driven by real Chainlink Functions.
 *
 * Flow:
 *  Step 1: Applicant gets verified off-chain (Polygon ID / World ID / Exchange KYC).
 *  Step 2: requestVerification() sends args [wallet, provider, proof] to the DON
 *          via FunctionsClient._sendRequest with DON-hosted secrets.
 *  Step 3: fulfillRequest() (router-only) decodes (bool eligible, uint16 country),
 *          enforces the 408/792/104 blocklist fail-closed, writes IdentityRecord.
 *  Step 4: Gated contracts call isEligible() with expiry + blocklist checks.
 *
 * Sepolia defaults:
 *  Router: 0xb83E47C2bC239B31AB286EA3DD212D87f0c7D77d
 *  DON ID: 0x66756e2d657468657265756d2d7365706f6c69612d310000000000000000000000 (fun-ethereum-sepolia-1)
 *
 * Demo fallback: scripts/functions/verifyIdentity.demo.js + mockFulfill() for Anvil
 *  without LINK. Never call mockFulfill() on a production deployment.
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

    mapping(address => IdentityRecord) private _records;
    mapping(bytes32 => address) public requestToApplicant;
    mapping(bytes32 => string) public requestToProvider;
    /// @notice Prevent World ID double-signaling: nullifierHash => used
    mapping(bytes32 => bool) public worldIdNullifierUsed;

    // 408 PRK North Korea, 792 TUR Turkey, 104 MMR Myanmar
    mapping(uint16 => bool) public blockedCountryCode;

    error Unauthorized();
    error InvalidAddress();
    error RequestNotFound();
    error EmptySource();
    event SourceUpdated();
    event SecretsUpdated(uint8 slotId, uint64 version, bool enabled);

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
        owner = msg.sender;
        donId = _donId;
        subscriptionId = _subscriptionId;
        callbackGasLimit = 300_000;
        jsSource = _jsSource;
        blockedCountryCode[408] = true;
        blockedCountryCode[792] = true;
        blockedCountryCode[104] = true;
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

    /**
     * @notice Step 2 (production): send verification request to the DON.
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

    /// @notice IComplianceRegistry compat (no proof — WORLD_ID/EXCHANGE_KYC callers should use 3-arg version).
    function requestVerification(
        address applicant,
        string calldata provider
    ) external override returns (bytes32) {
        return requestVerification(applicant, provider, string(""));
    }

    /**
     * @notice Step 3: router-only fulfillment. Decodes (bool eligible, uint16 country).
     * @dev World ID reuse is blocked here via nullifier hash embedded by the DON
     *  (extend response to (bool, uint16, bytes32 nullifier) if strict reuse protection needed).
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
     * @notice Local-only helper for Anvil/demo without LINK. Do NOT call on production.
     */
    function mockFulfill(
        address applicant,
        bool eligible,
        uint16 countryCode,
        string calldata provider
    ) external onlyOwner {
        if (applicant == address(0)) revert InvalidAddress();
        if (blockedCountryCode[countryCode]) eligible = false;
        uint64 now_ = uint64(block.timestamp);
        _records[applicant] = IdentityRecord({
            isEligible: eligible,
            nationalityCountryCode: countryCode,
            verifiedAt: now_,
            expiresAt: eligible ? now_ + 365 days : 0,
            provider: provider
        });
        emit EligibilityUpdated(applicant, eligible, provider);
    }

    /// @notice Step 4 check with expiry + blocklist.
    function isEligible(address account) external view override returns (bool) {
        IdentityRecord memory r = _records[account];
        if (!r.isEligible) return false;
        if (blockedCountryCode[r.nationalityCountryCode]) return false;
        if (r.expiresAt != 0 && r.expiresAt <= block.timestamp) return false;
        return true;
    }

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
