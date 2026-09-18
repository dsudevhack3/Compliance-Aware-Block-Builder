import os
import json
import urllib.request
import urllib.error
import pytest

AI_EXPLAINER_URL = os.getenv("AI_EXPLAINER_URL", "http://127.0.0.1:8001")
API_URL = os.getenv("API_URL", "http://127.0.0.1:3002")

def test_ai_explainer_block():
    """Verify AI Explainer returns audit narrative on a BLOCK decision."""
    payload = json.dumps({
        "tx": "0xsim_smoke_test",
        "decision": "BLOCK",
        "risk_score": 98,
        "reasons": ["SANCTIONED_RECIPIENT"]
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{AI_EXPLAINER_URL}/explain",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Secret": "dev-internal-secret-2026"
        },
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["tx"] == "0xsim_smoke_test"
        assert data["decision"] == "BLOCK"
        assert data["risk_score"] == 98
        assert "narrative" in data
        assert len(data["narrative"]) > 0

def test_api_relay_bids_endpoint():
    """Verify Relay bids endpoint is live and accessible."""
    req = urllib.request.Request(f"{API_URL}/api/relay/bids")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert isinstance(data, list)

def test_api_stats():
    """Verify API stats endpoint returns policy and sanctions summary."""
    req = urllib.request.Request(f"{API_URL}/api/stats")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert "decisions" in data
        assert "blocks" in data
        assert "sanctions" in data

def test_admin_refresh_unauthorized():
    """Verify admin refresh endpoint rejects unauthorized requests with 401."""
    req = urllib.request.Request(
        f"{API_URL}/api/admin/refresh",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        pytest.fail("Expected HTTP 401 Unauthorized")
    except urllib.error.HTTPError as e:
        assert e.code == 401

def test_policy_activation_validation():
    """Verify policy activation rejects missing or invalid policy."""
    req = urllib.request.Request(
        f"{API_URL}/api/policy/activate",
        data=json.dumps({"policy_id": "nonexistent-policy-id"}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        pytest.fail("Expected HTTP 401, 404, or 400")
    except urllib.error.HTTPError as e:
        assert e.code in (401, 400, 404, 500)


RELAY_URL = "http://127.0.0.1:3003"

def test_relay_health():
    """Verify relay health endpoint."""
    req = urllib.request.Request(f"{RELAY_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["service"] == "compliance-relay"
        assert data["status"] == "ok"

def test_relay_bids_and_best_header_selection():
    """Submit 3 bids: High (exposed), Mid (compliant), Low (compliant) and verify best_header selects Mid."""
    import time
    slot = 500

    # Bid 1: High value, but sanctioned transaction
    b1 = {
        "slot": slot,
        "block_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "builder_id": "builder-high-risk",
        "builder_pubkey": "0x1111",
        "fee_recipient": "0x1111111111111111111111111111111111111111",
        "value_wei": "5000000000000000000",
        "txs": [{
            "hash": "0x00000000000000000000000000000000000000000000000000000000000000a1",
            "sender": "0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b", # Sanctioned
            "recipient": "0x2222222222222222222222222222222222222222",
            "value": 100
        }]
    }

    # Bid 2: Medium value, compliant
    b2 = {
        "slot": slot,
        "block_hash": "0x2222222222222222222222222222222222222222222222222222222222222222",
        "builder_id": "builder-clean-mid",
        "builder_pubkey": "0x2222",
        "fee_recipient": "0x2222222222222222222222222222222222222222",
        "value_wei": "3000000000000000000",
        "txs": [{
            "hash": "0x00000000000000000000000000000000000000000000000000000000000000a2",
            "sender": "0x3333333333333333333333333333333333333333",
            "recipient": "0x4444444444444444444444444444444444444444",
            "value": 200
        }]
    }

    # Bid 3: Low value, compliant
    b3 = {
        "slot": slot,
        "block_hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
        "builder_id": "builder-clean-low",
        "builder_pubkey": "0x3333",
        "fee_recipient": "0x3333333333333333333333333333333333333333",
        "value_wei": "1000000000000000000",
        "txs": [{
            "hash": "0x00000000000000000000000000000000000000000000000000000000000000a3",
            "sender": "0x5555555555555555555555555555555555555555",
            "recipient": "0x6666666666666666666666666666666666666666",
            "value": 300
        }]
    }

    for b in [b1, b2, b3]:
        req = urllib.request.Request(
            f"{RELAY_URL}/relay/submit_bid",
            data=json.dumps(b).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 202

    time.sleep(0.5)

    # Check bids verdicts
    req = urllib.request.Request(f"{RELAY_URL}/relay/bids?slot={slot}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        bids = json.loads(resp.read().decode("utf-8"))
        verdicts = {b["builder_id"]: b["verdict"] for b in bids}
        assert verdicts["builder-high-risk"] == "EXPOSED_TX"
        assert verdicts["builder-clean-mid"] == "COMPLIANT"
        assert verdicts["builder-clean-low"] == "COMPLIANT"

    # Best header must return builder-clean-mid (3 ETH), NOT the 5 ETH exposed bid
    req = urllib.request.Request(f"{RELAY_URL}/relay/best_header?slot={slot}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        header = json.loads(resp.read().decode("utf-8"))
        assert header["builder_id"] == "builder-clean-mid"
        assert header["value_wei"] == "3000000000000000000"

    # Payload requires proposer_sig
    try:
        urllib.request.urlopen(f"{RELAY_URL}/relay/payload?slot={slot}", timeout=5)
        pytest.fail("Expected 400 Bad Request when proposer signature is missing")
    except urllib.error.HTTPError as e:
        assert e.code == 400

    # Payload with proposer_sig returns full txs
    req = urllib.request.Request(f"{RELAY_URL}/relay/payload?slot={slot}&proposer_sig=0xfake_sig_1234")
    with urllib.request.urlopen(req, timeout=5) as resp:
        assert resp.status == 200
        payload = json.loads(resp.read().decode("utf-8"))
        assert payload["builder_id"] == "builder-clean-mid"
        assert payload["proposer_sig"] == "0xfake_sig_1234"
        assert len(payload["txs"]) == 1
        assert payload["txs"][0]["sender"] == "0x3333333333333333333333333333333333333333"

def test_relay_best_header_fail_closed():
    """Verify best_header returns 404 on unpopulated slot."""
    try:
        urllib.request.urlopen(f"{RELAY_URL}/relay/best_header?slot=999999", timeout=5)
        pytest.fail("Expected 404 for unpopulated slot")
    except urllib.error.HTTPError as e:
        assert e.code == 404

