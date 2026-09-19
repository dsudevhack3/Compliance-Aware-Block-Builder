// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IComplianceRegistry {
    struct IdentityRecord {
        bool isEligible;
        uint16 nationalityCountryCode; // ISO-3166 numeric: e.g. 840 (US), 826 (GB), 356 (IN)
        uint64 verifiedAt;
        uint64 expiresAt;
        string provider; // "POLYGON_ID" | "WORLD_ID" | "EXCHANGE_KYC"
    }

    event VerificationRequested(bytes32 indexed requestId, address indexed applicant, string provider);
    event VerificationFulfilled(bytes32 indexed requestId, address indexed applicant, bool isEligible, string provider);
    event EligibilityUpdated(address indexed account, bool isEligible, string reason);

    function isEligible(address account) external view returns (bool);
    function getIdentityRecord(address account) external view returns (IdentityRecord memory);
    function requestVerification(address applicant, string calldata provider) external returns (bytes32 requestId);
}
