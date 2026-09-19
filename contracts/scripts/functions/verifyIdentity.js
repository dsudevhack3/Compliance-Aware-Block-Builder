/**
 * Chainlink Functions DON JavaScript Source — PRODUCTION
 *
 * Execution Context: Chainlink Decentralized Oracle Network (DON) sandbox
 * Only globals available: args, secrets, Functions.makeHttpRequest
 *
 * Args:
 *  args[0]: applicantWallet (0x...)
 *  args[1]: provider ("POLYGON_ID" | "WORLD_ID" | "EXCHANGE_KYC")
 *  args[2]: credentialProof
 *    - POLYGON_ID: JSON string { proof, credentialId } OR raw ZK proof string
 *    - WORLD_ID: JSON string { nullifier_hash, merkle_root, proof, verification_level }
 *    - EXCHANGE_KYC: credentialId / kycReference
 *
 * Secrets (DON-hosted, never hardcoded):
 *  POLYGON_ID_VERIFIER_URL, POLYGON_ID_API_KEY (optional),
 *  WORLD_ID_APP_ID,
 *  KYC_PARTNER_URL, EXCHANGE_API_KEY
 *
 * Returns: 64-byte ABI (bool eligible, uint16 countryCode) for
 *   abi.decode(response, (bool, uint16)) in ComplianceRegistry.fulfillRequest
 */

const applicantWallet = args[0];
const provider = (args[1] || "EXCHANGE_KYC").toUpperCase();
const credentialProof = args[2] || "";

if (!applicantWallet || !applicantWallet.startsWith("0x") || applicantWallet.length !== 42) {
  throw new Error("Invalid applicant wallet address");
}

// Guard for sandboxes without injected secrets (fail-closed downstream via required-secret checks)
const sec = typeof secrets !== "undefined" ? secrets : {};

// 3 blocked nationalities enforced fail-closed on both DON + contract.
const BLOCKED = { 408: 1, 792: 1, 104: 1 };
function pad3(n) {
  return String(n).padStart(3, "0");
}

let isEligible = false;
let nationalityCode = 0;

if (provider === "POLYGON_ID") {
  // Real Polygon ID / ZK-credential verifier call.
  // Your verifier service must: verify issuer signature + ZK proof validity,
  // check credentialSubject nationality, check revocation/expiry.
  // Expected response: { verified: bool, issuerSigValid: bool, nationalityCode: 840, revoked: bool }
  if (!credentialProof) throw new Error("missing Polygon ID proof");
  const verifierUrl = sec.POLYGON_ID_VERIFIER_URL;
  if (!verifierUrl) throw new Error("missing secret POLYGON_ID_VERIFIER_URL");

  const headers = { "Content-Type": "application/json" };
  if (sec.POLYGON_ID_API_KEY) headers["Authorization"] = "Bearer " + sec.POLYGON_ID_API_KEY;

  const req = await Functions.makeHttpRequest({
    url: verifierUrl,
    method: "POST",
    headers,
    data: { wallet: applicantWallet, proof: credentialProof },
    timeout: 9000,
  });
  if (req.error || !req.data) throw new Error("Polygon ID verifier unreachable");
  const v = req.data;
  const verified = v.verified === true && v.issuerSigValid !== false && v.revoked !== true;
  const country = Number(v.nationalityCode || 0);
  isEligible = verified;
  nationalityCode = Number.isFinite(country) ? country : 0;
} else if (provider === "WORLD_ID") {
  // Real World ID verification via Worldcoin Developer Portal.
  // credentialProof must be JSON: { nullifier_hash, merkle_root, proof, verification_level }
  const appId = sec.WORLD_ID_APP_ID;
  if (!appId) throw new Error("missing secret WORLD_ID_APP_ID");
  let p;
  try {
    p = JSON.parse(credentialProof);
  } catch (e) {
    throw new Error("WORLD_ID proof must be JSON with nullifier_hash/merkle_root/proof");
  }
  if (!p.nullifier_hash || !p.merkle_root || !p.proof) throw new Error("incomplete World ID proof");

  const req = await Functions.makeHttpRequest({
    url: "https://developer.worldcoin.org/api/v2/verify/" + appId,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      nullifier_hash: p.nullifier_hash,
      merkle_root: p.merkle_root,
      proof: p.proof,
      verification_level: p.verification_level || "orb",
      action: "onchain-compliance-registration",
      signal: applicantWallet.toLowerCase(),
    },
    timeout: 9000,
  });
  if (req.error || !req.data) throw new Error("World ID verify unreachable");
  // Contract must ALSO enforce nullifierUsed[nullifier_hash] == false to stop reuse.
  isEligible = req.data.success === true && req.data.action === "onchain-compliance-registration";
  nationalityCode = 0; // personhood only, no nationality
} else if (provider === "EXCHANGE_KYC") {
  // Real regulated-KYC partner lookup. Key lives in DON secrets, never on-chain.
  const baseUrl = sec.KYC_PARTNER_URL;
  const apiKey = sec.EXCHANGE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("missing secrets KYC_PARTNER_URL / EXCHANGE_API_KEY");

  const req = await Functions.makeHttpRequest({
    url: baseUrl + "/v1/kyc/" + applicantWallet,
    method: "GET",
    headers: { Authorization: "Bearer " + apiKey },
    params: { reference: credentialProof || undefined },
    timeout: 9000,
  });
  if (req.error || !req.data) throw new Error("KYC partner unreachable");
  const k = req.data; // { kycTier: 2, countryCode: 840, sanctioned: false, expired: false }
  const tierOk = Number(k.kycTier || 0) >= 2;
  const notSanctioned = k.sanctioned !== true;
  const notExpired = k.expired !== true;
  isEligible = tierOk && notSanctioned && notExpired;
  nationalityCode = Number(k.countryCode || 0);
} else {
  throw new Error("Unsupported provider: " + provider);
}

// Fail-closed blocklist: sanctioned nationality can never be eligible.
if (BLOCKED[nationalityCode]) {
  isEligible = false;
}

// Encode 2x32-byte words for Solidity abi.decode(response, (bool, uint16))
const eligibleWord = isEligible
  ? "0000000000000000000000000000000000000000000000000000000000000001"
  : "0000000000000000000000000000000000000000000000000000000000000000";
const codeHex = nationalityCode.toString(16).padStart(64, "0");
return Buffer.from(eligibleWord + codeHex, "hex");
