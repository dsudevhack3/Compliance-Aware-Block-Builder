from fastapi import FastAPI
from pydantic import BaseModel
from typing import List
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

app = FastAPI(title="Compliance AI Explainer")

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


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
def explain_decision(input: DecisionInput):
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

    response = client.models.generate_content(
        model="gemini-3.6-flash",
        contents=prompt,
    )

    narrative = response.text

    return ExplanationOutput(
        tx=input.tx,
        decision=input.decision,
        risk_score=input.risk_score,
        narrative=narrative,
    )


@app.get("/health")
def health():
    return {"status": "ok"}
