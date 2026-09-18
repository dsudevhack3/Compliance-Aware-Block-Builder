# AI Explainer Failure Resilience & Observability Guide

## 1. Resilience Philosophy

In the Compliance-Aware Block Builder architecture:
1. **Separation of Policy and Narration**:
   - The **Rust Compliance Engine (`engine/`)** is the single authoritative source of deterministic compliance decisions (`ALLOW`, `FLAG`, `BLOCK`).
   - The **AI Explainer (`ai-explainer/`)** is strictly post-hoc and explanatory. It **never** influences policy outcomes or delays transaction inclusion.
2. **Fail-Closed Policy Core**:
   - If internal screening infrastructure (Postgres or Redis) is unreachable after exponential backoff retries, the engine fails closed (`HTTP 503 SERVICE_UNAVAILABLE`), ensuring unverified transactions never bypass sanctions controls.
3. **Fail-Open Narration Path**:
   - If the AI explainer service is slow, times out, or errors (e.g., Gemini rate limits, network disconnects), the transaction decision pipeline remains 100% operational. The decision is broadcast immediately to the builder mempool and dashboard; the narrative gracefully defaults to `"Narration unavailable"`.

---

## 2. Configuration & Parameter Justifications

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| **Engine DB/Redis Retries** | `3` attempts | Recovers from transient socket reconnects or pool saturation without delaying the screening path. |
| **Engine Retry Backoff** | `50ms` (doubling: 50ms, 100ms, 200ms) | Keeps maximum retry latency under ~350ms, comfortably within block proposal deadlines. |
| **AI Explainer Timeout** | `5000ms` (5 seconds) | Allows ample time for Gemini 3.6 Flash responses while preventing hanging HTTP sockets in the Fastify orchestration layer. |
| **Decision Watcher Interval** | `500ms` with hash deduplication | Ensures near-instant WebSocket delivery to the UI without dropping concurrent bursts or emitting duplicates. |

---

## 3. Demonstrating Resilience Live (Judge Demo Script)

Follow these steps to demonstrate that an AI explainer failure does not impair compliance screening:

### Step 1: Ensure Engine & API are Running
- Compliance Engine running on `http://127.0.0.1:3001`
- Fastify API running on `http://127.0.0.1:3002`
- Next.js Dashboard running on `http://localhost:3000`

### Step 2: Simulate AI Explainer Failure
Simulate explainer unreachability by either:
1. Stopping the `ai-explainer` process/container:
   ```bash
   pkill -f "uvicorn.*8000"
   ```
2. Or pointing `AI_EXPLAINER_URL` to an unreachable port in `api/.env`:
   ```bash
   AI_EXPLAINER_URL=http://127.0.0.1:9999/explain
   ```

### Step 3: Submit a Transaction to the Compliance Engine
Send a test transaction for a sanctioned address:

```bash
curl -X POST http://127.0.0.1:3001/screen \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0xdemo_resilience_001",
    "sender": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "recipient": "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A"
  }'
```

### Step 4: Verify Deterministic Behavior
1. **Engine Response**: Immediately returns HTTP 200:
   ```json
   {
     "tx_hash": "0xdemo_resilience_001",
     "decision": "BLOCK",
     "risk_score": 98,
     "reasons": ["SANCTIONED_RECIPIENT"]
   }
   ```
2. **Dashboard Real-Time Telemetry**:
   - The transaction immediately appears in the **Live Mempool Monitor** with a red `BLOCK` badge.
   - The Blocked Transactions counter increments in real time.
3. **Graceful Fallback in Lineage Inspector**:
   - Fastify logs a warning: `AI explainer failed for 0xdemo_resilience_001: fetch failed` or `timeout after 5s`.
   - In the **Lineage & Audit Inspector**, the compliance details remain fully intact.
   - The explanation section displays: `Narration unavailable (fetch failed)` rather than throwing errors or crashing the dashboard.

---

## 4. One-Click Live Demo & Simulator Pre-Build

For hackathon presentations and live demonstrations, the **Compliance Arcade** features a one-click **"Run Live Demo"** button that invokes the transaction simulator directly from the UI without touching the terminal.

### Pre-Building the Release Binary (Required Setup Step)
Before presenting the live demo, ensure the simulator binary is compiled in release mode so the UI trigger responds instantaneously without compile delay:

```bash
cd simulator
cargo build --release --bin simulator
```

The backend Fastify orchestrator executes `simulator/target/release/simulator` directly via `POST /api/demo/run-simulator`, streams real-time stdout/stderr logs to the server terminal, and prevents concurrent overlapping runs via 409 status locks.
