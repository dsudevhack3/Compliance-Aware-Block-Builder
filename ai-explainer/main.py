from fastapi import FastAPI, Header, HTTPException, status, Request
from pydantic import BaseModel
from typing import List, Optional
import os
import time
import hmac
from dotenv import load_dotenv
from google import genai

load_dotenv()

app = FastAPI(title="Compliance AI Explainer")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
INTERNAL_SERVICE_SECRET = os.getenv("INTERNAL_SERVICE_SECRET", "dev-internal-secret-2026")

client = None
if GEMINI_API_KEY and GEMINI_API_KEY != "your-gemini-api-key-here":
    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        print(f"Warning: Failed to initialize Gemini client: {e}")

# In-memory sliding window rate limiter: client_id -> list of request timestamps
_rate_limits: dict[str, list[float]] = {}
RATE_LIMIT_MAX_REQUESTS = 30
RATE_LIMIT_WINDOW_SECONDS = 60.0


def verify_service_auth(
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    authorization: Optional[str] = Header(None),
):
    provided = x_internal_secret
    if not provided and authorization and authorization.startswith("Bearer "):
        provided = authorization[7:].strip()

    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Valid X-Internal-Secret header required",
        )

    if not hmac.compare_digest(provided, INTERNAL_SERVICE_SECRET):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Invalid internal service secret",
        )


def check_rate_limit(client_id: str):
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    history = _rate_limits.setdefault(client_id, [])
    # Prune old timestamps
    _rate_limits[client_id] = [ts for ts in history if ts > cutoff]

    if len(_rate_limits[client_id]) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded: Maximum {RATE_LIMIT_MAX_REQUESTS} requests per minute",
        )
    _rate_limits[client_id].append(now)


class DecisionInput(BaseModel):
    tx: str
    decision: str
    risk_score: int
    reasons: List[str]


class ExplanationOutput(BaseModel):
    tx: str
    decision: str
    risk_score: int
    narrative: str


@app.post("/explain", response_model=ExplanationOutput)
def explain_decision(
    input: DecisionInput,
    request: Request,
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    authorization: Optional[str] = Header(None),
):
    verify_service_auth(x_internal_secret=x_internal_secret, authorization=authorization)

    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)

    prompt = f"""You are an expert compliance narration assistant for an institutional blockchain transaction screening engine.
You NEVER make decisions — a deterministic Rust policy engine has already executed policy rules. Your sole job is to
provide a concise, factual, 1-2 sentence explanation suitable for a regulatory compliance audit log.

Screening Decision Input:
- Transaction Hash: {input.tx}
- Policy Decision: {input.decision} (ALLOW | FLAG | BLOCK)
- Risk Score: {input.risk_score} / 100
- Reason Codes: {', '.join(input.reasons) if input.reasons else 'None'}

Reason Code Context:
- SANCTIONED_SENDER / SANCTIONED_RECIPIENT: Direct hit against an OFAC/SDN sanctioned entity list (mandatory BLOCK).
- INDIRECT_SENDER_EXPOSURE / INDIRECT_RECIPIENT_EXPOSURE: 1-hop audit graph walk detected prior transactional counterparty history with a directly sanctioned address (FLAG for Enhanced Due Diligence).

Instructions:
- State clearly whether this was a direct designation or an indirect exposure via prior transaction history.
- Reference the specific reason code(s) and risk score.
- Keep the explanation strictly factual, professional, and audit-ready (1-2 sentences maximum).
- Do not speculate or recommend actions."""

    try:
        if not client:
            raise RuntimeError("Gemini client not initialized")

        response = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=prompt,
        )
        narrative = response.text
    except Exception as err:
        reasons_str = ", ".join(input.reasons) if input.reasons else "None"
        if input.decision == "BLOCK":
            narrative = f"Transaction {input.tx} blocked (Risk Score: {input.risk_score}/100) due to direct sanctions match ({reasons_str}). Asset transfer halted under OFAC compliance policy."
        elif input.decision == "FLAG":
            narrative = f"Transaction {input.tx} flagged for compliance review (Risk Score: {input.risk_score}/100). Counterparty lineage indicates indirect exposure ({reasons_str})."
        else:
            narrative = f"Transaction {input.tx} cleared compliance verification with risk score {input.risk_score}/100. No sanctions or policy violations detected."

    return ExplanationOutput(
        tx=input.tx,
        decision=input.decision,
        risk_score=input.risk_score,
        narrative=narrative,
    )


class BidSummaryInput(BaseModel):
    slot: int
    builder_id: str
    value_eth: float
    verdict: str
    reasons: List[str]
    block_hash: Optional[str] = None


class BidSummaryOutput(BaseModel):
    slot: int
    builder_id: str
    verdict: str
    summary: str


@app.post("/summarize_bid", response_model=BidSummaryOutput)
def summarize_bid(
    input: BidSummaryInput,
    request: Request,
    x_internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    authorization: Optional[str] = Header(None),
):
    verify_service_auth(x_internal_secret=x_internal_secret, authorization=authorization)

    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)

    prompt = f"""You are an institutional compliance auditor for an Ethereum block builder relay.
Generate a concise, authoritative 1-2 sentence regulatory audit summary for the following block builder bid:

Bid Details:
- Slot: {input.slot}
- Builder: {input.builder_id}
- Bid Value: {input.value_eth:.4f} ETH
- Compliance Verdict: {input.verdict} (COMPLIANT | EXPOSED_TX | EXPOSED_BUILDER | PENDING)
- Reason Codes / Violations: {', '.join(input.reasons) if input.reasons else 'None'}

Formatting Rules:
- If verdict is EXPOSED_TX or EXPOSED_BUILDER: State clearly that the bid was excluded/disqualified and cite the primary violation reason (e.g. 'Bid 2.5 ETH excluded due to SANCTIONED_RECIPIENT in tx...').
- If verdict is COMPLIANT: State that the bid of {input.value_eth:.4f} ETH was verified compliant with active screening policy.
- Maximum 2 sentences. Professional, factual, audit-ready tone."""

    try:
        if not client:
            raise RuntimeError("Gemini client not initialized")

        response = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=prompt,
        )
        summary = response.text.strip()
    except Exception:
        reasons_str = "; ".join(input.reasons) if input.reasons else "Sanctions violation"
        if input.verdict == "COMPLIANT":
            summary = f"Bid {input.value_eth:.4f} ETH from {input.builder_id} verified COMPLIANT with active institutional screening policy."
        elif input.verdict == "EXPOSED_BUILDER":
            summary = f"Bid {input.value_eth:.4f} ETH excluded due to sanctioned builder fee recipient ({reasons_str})."
        elif input.verdict == "EXPOSED_TX":
            summary = f"Bid {input.value_eth:.4f} ETH excluded due to prohibited transaction payload ({reasons_str})."
        else:
            summary = f"Bid {input.value_eth:.4f} ETH from {input.builder_id} evaluated with verdict {input.verdict}."

    return BidSummaryOutput(
        slot=input.slot,
        builder_id=input.builder_id,
        verdict=input.verdict,
        summary=summary,
    )


@app.get("/health")
def health():
    return {
        "status": "ok",
        "gemini_configured": client is not None,
        "auth_enforced": True,
    }

