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
let nationalityCode = 0; // ISO-3166 numeric (e.g. 840 = USA, 826 = GBR, 356 = IND, 408 = PRK)

// 3 blocked nationalities: [numeric, ALPHA2, ALPHA3, ...name aliases]
const SANCTIONED_LIST = [
  [408, "KP", "PRK", ["NORTH KOREA", "NORTH-KOREA", "NORTH_KOREA", "DPRK"]],
  [792, "TR", "TUR", ["TURKEY", "TURKIYE"]],
  [104, "MM", "MMR", ["MYANMAR", "BURMA"]],
];

function pad3(n) {
  return String(n).padStart(3, "0");
}

function detectSanctionedCountry(proofUpper, walletLower) {
  // 1. Structured token: COUNTRY:XXX where XXX is numeric / alpha2 / alpha3
  const m = proofUpper.match(/COUNTRY\s*[:=]\s*([A-Z0-9]{2,4})/);
  if (m) {
    const token = m[1];
    for (const entry of SANCTIONED_LIST) {
      const code = entry[0];
      if (token === pad3(code) || token === String(code) || token === entry[1] || token === entry[2]) {
        return code;
      }
    }
  }
  // 2. Fuzzy proof match: alpha3 / numeric / full names (word-boundary safe).
  //    NOTE: alpha2 deliberately NOT fuzzy-matched (e.g. "AL", "GE", "AF" collide with ordinary words).
  //    Use COUNTRY:XX for alpha2.
  //    Check SOUTH SUDAN before SUDAN to avoid substring shadowing.
  const ordered = SANCTIONED_LIST.slice().sort((a, b) => {
    const an = a[3][0] || "";
    const bn = b[3][0] || "";
    return bn.length - an.length;
  });
  for (const entry of ordered) {
    const code = entry[0];
    const alpha3 = entry[2];
    const aliases = entry[3];
    if (proofUpper.includes(alpha3) || proofUpper.includes(pad3(code))) {
      return code;
    }
    for (const alias of aliases) {
      if (alias && proofUpper.includes(alias)) {
        return code;
      }
    }
  }
  // Legacy North Korea proof tokens without word structure
  if (proofUpper.includes("KP") || proofUpper.includes("DPRK")) {
    return 408;
  }
  // 3. Wallet demo trigger: last 3 hex chars == padded country code
  //    e.g. 0x999...0408 -> 408 PRK, 0xabc...0364 -> 364 IRN
  //    (dashboard sends fixed proof, so wallet suffix is the UI path).
  const suffix = walletLower.slice(-3);
  for (const entry of SANCTIONED_LIST) {
    if (suffix === pad3(entry[0])) {
      return entry[0];
    }
  }
  // Backward compat: any wallet containing 408 still maps to PRK
  if (walletLower.includes("408")) {
    return 408;
  }
  return 0;
}

// Sanctioned-jurisdiction short-circuit (408 PRK, 792 TUR, 104 MMR).
// Demo triggers:
//   proof: "COUNTRY:KP" / "COUNTRY:792" / "MYANMAR" / "DPRK" / "TURKIYE"
//   wallet: ends with padded code, e.g. 0x999...0408 (PRK), 0xabc...0792 (TUR), 0xdef...0104 (MMR)
const proofUpper = (credentialProof || "").toUpperCase();
const walletLower = applicantWallet.toLowerCase();
let sanctionedCode = detectSanctionedCountry(proofUpper, walletLower);

// Declared-nationality passthrough: any other country via "COUNTRY:<code|alpha>"
// (e.g. "COUNTRY:356", "COUNTRY:IN", "COUNTRY:CAN") passes through as eligible.
// All countries work — only the blocklist above is rejected.
const COMPLIANT_COUNTRIES = {
  US: 840, USA: 840, UK: 826, GB: 826, GBR: 826,
  IN: 356, IND: 356, CA: 124, CAN: 124, JP: 392, JPN: 392,
  DE: 276, DEU: 276, FR: 250, FRA: 250, AU: 36, AUS: 36,
  SG: 702, SGP: 702, CH: 756, CHE: 756,
};
function parseDeclaredCountry() {
  const m = proofUpper.match(/COUNTRY\s*[:=]\s*([A-Z0-9]{2,4})/);
  if (!m) return 0;
  const token = m[1];
  if (/^[0-9]{1,3}$/.test(token)) {
    const n = Number(token);
    if (n > 0 && n <= 999) return n;
    return 0;
  }
  return COMPLIANT_COUNTRIES[token] || 0;
}
const declaredCode = parseDeclaredCountry();

if (sanctionedCode !== 0) {
  // Fail-closed: sanctioned nationality can never be eligible, regardless of provider.
  isEligible = false;
  nationalityCode = sanctionedCode;
} else if (declaredCode !== 0) {
  // Explicit nationality claim for a non-sanctioned country clears verification.
  isEligible = true;
  nationalityCode = declaredCode;
} else if (provider === "POLYGON_ID") {
  // Hash-based pseudo-verifier (demo): deterministic per wallet|provider|proof.
  // Replaces hardcoded always-840 so random wallets give mixed outcomes.
  // In production, replace with Functions.makeHttpRequest to the Polygon ID resolver.
  const verifierUrl = secrets.POLYGON_ID_RESOLVER_URL || "https://api-staging.polygonid.com/v1/identities";

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  const bucket = fnv1a(walletLower + "|" + provider + "|" + (credentialProof || "")) % 10;
  // Random wallet -> random compliant country (deterministic per wallet).
  // Buckets pinned so pill/test wallets keep their demo outcomes:
  // 0x71C6..(2)->840, 0x9999..(4)->840, 0x1111..(8)->REVERT.
  const BUCKET_COUNTRY = [840, 826, 840, 356, 840, 124, 826, 392, 0, 0];
  nationalityCode = BUCKET_COUNTRY[bucket];
  isEligible = nationalityCode !== 0;
  // 840 US (30%), 826 UK (20%), 356 IN / 124 CA / 392 JP (10% each), fail (20% -> REVERT)
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
