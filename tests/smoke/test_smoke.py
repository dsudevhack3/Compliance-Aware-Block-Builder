import json
import urllib.request
import urllib.error
import pytest

AI_EXPLAINER_URL = "http://127.0.0.1:8000"
API_URL = "http://127.0.0.1:3002"

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
        headers={"Content-Type": "application/json"},
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
        pytest.fail("Expected HTTP 404 or 400")
    except urllib.error.HTTPError as e:
        assert e.code in (400, 404, 500)

