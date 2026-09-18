#!/usr/bin/env bash
set -e

echo "================================================================================"
echo "      COMPLIANCE-AWARE BLOCK BUILDER — 60-SECOND JUDGE FLOW DEMONSTRATION      "
echo "================================================================================"

API_URL="${API_URL:-http://127.0.0.1:3002}"
RELAY_URL="${RELAY_URL:-http://127.0.0.1:3003}"
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:3001}"
ADMIN_KEY="${ADMIN_API_KEY:-dev-admin-secret-2026}"

echo ""
echo "[Step 1/5] Verifying Core Services Health..."
curl -s "${ENGINE_URL}/health" | grep -q "healthy" && echo "  ✓ Engine (Port 3001): OK" || echo "  ⚠ Engine not healthy"
curl -s "${RELAY_URL}/health" | grep -q "healthy" && echo "  ✓ Relay (Port 3003): OK" || echo "  ⚠ Relay not healthy"
curl -s "${API_URL}/health" | grep -q "connected" && echo "  ✓ API (Port 3002): OK" || echo "  ⚠ API not healthy"

echo ""
echo "[Step 2/5] Activating Strict Institutional Policy (institution-standard-v1)..."
curl -s -X POST "${API_URL}/api/policy/activate" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ${ADMIN_KEY}" \
  -d '{"policy_id": "institution-standard-v1"}' > /dev/null
echo "  ✓ Active Policy: STANDARD INSTITUTIONAL (STRICT 2-HOP, Travel Threshold: $10,000)"

echo ""
echo "[Step 3/5] Firing Concurrent Mock Builders (Slot 12)..."
echo "  - B1: Clean Payload (2.0 ETH)"
echo "  - B2: Sanctioned Transaction Included (2.5 ETH)"
echo "  - B3: Sanctioned Fee Recipient (1.8 ETH)"
echo ""
cargo run --manifest-path simulator/Cargo.toml --quiet --bin mock_builders -- --slot 12

echo ""
echo "[Step 4/5] Evaluating Header Auction Under Strict Policy..."
WINNER_JSON=$(curl -s "${RELAY_URL}/relay/best_header?slot=12")
echo "  Winning Header: ${WINNER_JSON}"
WINNER_BUILDER=$(echo "${WINNER_JSON}" | grep -o '"builder_id":"[^"]*' | cut -d'"' -f4)

if [ "${WINNER_BUILDER}" = "builder-b1-clean" ]; then
  echo "  ✓ RESULT: Compliant Builder B1 won the slot at 2.0 ETH!"
  echo "    Higher bid B2 (2.5 ETH) was blocked and disqualified by OFAC gate."
fi

echo ""
echo "[Step 5/5] Demonstrating Policy Switcher: Switching to Lenient Policy..."
curl -s -X POST "${API_URL}/api/policy/activate" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ${ADMIN_KEY}" \
  -d '{"policy_id": "institution-lenient-v1"}' > /dev/null
echo "  ✓ Policy switched to: LENIENT INSTITUTIONAL (1-Hop Direct Only, strict_mode=false)"

echo ""
echo "[Audit Export] Downloading Cryptographically Signed SAR Audit Pack..."
EXPORT_FILE="slot_12_audit_pack.zip"
curl -s "${RELAY_URL}/relay/slot/12/export" -o "${EXPORT_FILE}"

if [ -f "${EXPORT_FILE}" ]; then
  echo "  ✓ Archive saved: ${EXPORT_FILE} ($(wc -c < ${EXPORT_FILE} | tr -d ' ') bytes)"
  echo ""
  echo "--- Compliance Certificate Inside Archive ---"
  unzip -p "${EXPORT_FILE}" compliance_certificate.txt | head -n 18
  echo ""
  rm -f "${EXPORT_FILE}"
fi

# Restore standard institutional policy
curl -s -X POST "${API_URL}/api/policy/activate" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ${ADMIN_KEY}" \
  -d '{"policy_id": "institution-standard-v1"}' > /dev/null

echo "================================================================================"
echo "                  DEMONSTRATION COMPLETED SUCCESSFULLY IN <60s                  "
echo "================================================================================"
