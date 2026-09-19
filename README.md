# Compliance-Aware Block Builder & PBS Relay

### Pre-Execution Mempool Screening, 2-Hop Multi-Hop Graph Walks, PBS Header Auction Gatekeeper, Policy Hot-Swapping, Enhanced Due Diligence (EDD), & Cryptographic SAR Audit Packs

Ethereum block builders and PBS relays operate under stringent legal and regulatory environments where compliance failure introduces existential liabilities. Today, builders and relays face critical challenges:
- **Inclusion risk**: Unknowingly packaging OFAC-sanctioned transactions into candidate blocks or bundles.
- **Relay auction blindness**: Relays accepting the highest bid without verifying that the winning payload is free from sanctioned transactions or tainted fee recipients.
- **Contagion & multi-hop layering**: Illicit funds moved through intermediary hops to bypass naive 1-hop sanctions checks.
- **FATF Travel Rule gaps**: Failing to identify counterparty Virtual Asset Service Providers (VASPs) on high-value transfers ($10,000+).
- **Audit & regulatory recordkeeping**: Inability to provide cryptographically sealed, tamper-evident Proof of Compliance to regulators.

The **Compliance-Aware Block Builder** solves these challenges end-to-end with sub-millisecond deterministic Rust screening, an Ethereum PBS-compliant Relay auction gatekeeper, an out-of-band AI audit narrator, and a real-time Next.js mission control dashboard.

---

## Architecture Overview

```
                          +-----------------------------------+
                          |     Incoming Mempool & Bundles    |
                          +-----------------+-----------------+
                                            |
                                            v
                          +-----------------------------------+
                          |      Rust Compliance Engine       |
                          |     (Axum + Tokio, Port 3001)     |
                          +---------+---------------+---------+
                                    |               |
               O(1) Direct Lookup   |               |   1-Hop / 2-Hop Recursive Walk
                                    v               v
                        +---------------+       +---------------+
                        |  Redis Cache  |       | PostgreSQL DB |
                        | (OFAC SDN Set)|       | (Audit Trail) |
                        +---------------+       +---------------+
                                    |               |
                                    +-------+-------+
                                            |
                                Deterministic Evaluation
                                 (ALLOW / FLAG / BLOCK)
                                            |
                        +-------------------+-------------------+
                        |                                       |
                 [If ALLOW]                               [If FLAG / BLOCK]
                        v                                       v
            +-----------------------+               +-----------------------+
            | revm In-Process DryRun|               | Fastify Orchestrator  |
            |  (State Simulation)   |               | (Port 3002 Gateway)   |
            +-----------+-----------+               +-----------+-----------+
                        |                                       |
                  Broadcast EVM                                 v
                (Anvil / Mainnet)                   +-----------------------+
                                                    |  Python AI Explainer  |
                                                    |  (Gemini Narratives)  |
                                                    +-----------+-----------+
                                                                |
                                                                v
                                                    +-----------------------+
                                                    | Enhanced Due Diligence|
                                                    |     (EDD Queue)       |
                                                    +-----------------------+

=============================================================================================
                          PBS RELAY COMPLIANCE AUCTION PIPELINE
=============================================================================================

       [Block Builder B1]          [Block Builder B2]          [Block Builder B3]
       (Clean Payload, 2.0 ETH)   (Sanctioned Tx, 2.5 ETH)     (Mixer / Bad Fee, 1.8 ETH)
               │                           │                           │
               └───────────────────────────┼───────────────────────────┘
                                           │
                              POST /relay/submit_bid
                                           ▼
                      +-----------------------------------------+
                      |            Rust Relay Service           |
                      |        (Axum + Tokio, Port 3003)        |
                      +--------------------+--------------------+
                                           │
                    Screen payload via Engine (:3001/screen)
                    Check fee recipient against OFAC Redis
                    Enforce atomic bundle integrity
                                           │
                                           ▼
                      +-----------------------------------------+
                      |         Fail-Closed Header Auction      |
                      |         GET /relay/best_header          |
                      +--------------------+--------------------+
                                           │
       ┌───────────────────────────────────┴───────────────────────────────────┐
       ▼                                                                       ▼
[Compliant Winner Selected]                                         [Disqualified Bids]
Builder B1 (2.0 ETH) wins slot!                                     B2 rejected: EXPOSED_TX (2.5 ETH)
                                                                    B3 rejected: EXPOSED_BUILDER (1.8 ETH)
       │                                                                       │
       └───────────────────────────────────┬───────────────────────────────────┘
                                           ▼
                      +-----------------------------------------+
                      |        Cryptographic SAR Export         |
                      |      GET /export/slot/:slot (.zip)      |
                      |   - Merkle Root of all decisions        |
                      |   - HMAC-SHA256 Signed Certificate      |
                      |   - Full JSON audit payloads            |
                      +-----------------------------------------+
```

---

## Tech Stack & Directory Structure

| Component | Directory | Tech / Framework | Responsibility |
| :--- | :--- | :--- | :--- |
| **Compliance Engine** | [`engine/`](engine/) | Rust 1.80+ (Axum, SQLx, Redis, Tokio) | Deterministic sub-millisecond screening ($O(1)$ direct sanctions check + 2-hop recursive graph walk). |
| **Relay Service (PBS)** | [`relay/`](relay/) | Rust 1.80+ (Axum, SQLx, Redis, Reqwest) | PBS auction gatekeeper enforcing header compliance, atomic bundle dropping, and fail-closed winner selection. |
| **Transaction Simulator** | [`simulator/`](simulator/) | Rust (Alloy, revm v43, Tokio) | End-to-end multi-scenario runner with in-process `revm` dry-run against live Anvil state. |
| **Mock Builders CLI** | [`simulator/src/bin/mock_builders.rs`](simulator/src/bin/mock_builders.rs) | Rust (Alloy, Reqwest, Tokio) | Simulates concurrent block builders submitting clean, sanctioned, and mixer payloads to the Relay. |
| **Attribution Worker** | [`simulator/src/bin/attribution_worker.rs`](simulator/src/bin/attribution_worker.rs) | Rust (Alloy, SQLx, Tokio) | Post-execution block listener checking validator coinbase addresses against sanctions attributions. |
| **Smart Contracts** | [`contracts/`](contracts/) | Solidity ^0.8.19 (Foundry / Forge) | Test smart contract ([`Counter.sol`](contracts/src/Counter.sol)) verifying `revm` execution parity with real calldata. |
| **API Orchestrator** | [`api/`](api/) | TypeScript (Node.js, Fastify, WebSocket, pg) | REST gateway (`/api/*`), proxy to Relay & Engine, WebSocket real-time event bus, and EDD case management. |
| **Mission Control Dashboard** | [`dashboard/`](dashboard/) | TypeScript (Next.js 16, Tailwind CSS, Lucide) | Real-time frontend: Mempool Screening feed, Relay Compliance Auction tab, Mined Blocks telemetry, and EDD drawer. |
| **Regulatory AI Explainer** | [`ai-explainer/`](ai-explainer/) | Python 3.11+ (FastAPI, Google GenAI SDK) | Asynchronous audit narrator powered by Gemini generating factual compliance narratives for decisions and bids. |
| **Database & Cache** | [`db/`](db/) | PostgreSQL 15+ & Redis 7+ | Relational persistence for sanctions entities, address attributions, audit logs, relay bids, and EDD cases. |

---

## Key Features

### 1. Pre-Execution Mempool Screening ($O(1)$ + 2-Hop Graph Walk)
- **Direct Sanctions ($O(1)$)**: Checks sender and recipient against atomic Redis set containing 121 OFAC SDN addresses. Any match evaluates immediately to `BLOCK` (Risk Score: 98).
- **2-Hop Recursive Contagion Walk**: Executes bounded recursive SQL CTE query over `compliance_decisions` to detect indirect exposure with mathematical distance decay:
  - 1-hop exposure: 55 risk points (`INDIRECT_SENDER_EXPOSURE`).
  - 2-hop exposure: 25 risk points (`INDIRECT_SENDER_EXPOSURE_2HOP`).
- **FATF Travel Rule Compliance**: Evaluates transfers exceeding $10,000 (`value_usd`). Verifies `vasp_metadata` and counterparty licensing status.
- **In-Process `revm` Dry-Run**: Before broadcasting `ALLOW` transactions, simulates execution in-process against live Anvil state. Catches out-of-gas, reverts, and state conflicts without spending gas on-chain.

### 2. PBS Relay Compliance Auction
- **Bid Submission (`POST /relay/submit_bid`)**: Builders submit block candidate bids with slot, value, block hash, fee recipient, and constituent transactions.
- **Atomic Bundle Dropping**: If any transaction inside a bundle (`bundle_id`) is blocked or flagged, all transactions in that bundle are atomically excluded to prevent invalid execution.
- **Fail-Closed Winner Selection (`GET /relay/best_header?slot={slot}`)**:
  - Automatically disqualifies payloads containing sanctioned transactions (`EXPOSED_TX`) or sanctioned fee recipients (`EXPOSED_BUILDER`).
  - **Highest compliant bid wins the slot**, even if a disqualified builder bid higher value (e.g. Clean 2.0 ETH wins over Sanctioned 2.5 ETH).
  - If all bids are disqualified, the relay fails closed and refuses to propose a header.

### 3. Policy Hot-Swapping (Policy-as-Config)
- **Standard Institutional Policy (`institution-standard-v1`)**:
  - `strict_mode: true` (disqualifies any bid containing `FLAG` transactions).
  - Enforces 2-hop contagion checks, mixer interaction penalties, and Travel Rule thresholds.
- **Lenient Institutional Policy (`institution-lenient-v1`)**:
  - `strict_mode: false` (tolerates 2-hop flagged transactions).
  - Only blocks direct sanctions hits.
- **Dynamic Hot-Swapping**: Switch active policies on the fly via `POST /api/policy/activate` or directly in the Dashboard UI.

### 4. Enhanced Due Diligence (EDD) Queue
- Transactions evaluating to `FLAG` automatically generate an open case in `edd_cases`.
- Compliance officers can review flagged cases, view risk scores and reason codes, add audit notes, and resolve cases (`APPROVED` or `QUARANTINED`) via the interactive slide-out EDD drawer.

### 5. Cryptographic Proofs & SAR Audit Export
- **HMAC-SHA256 Signed Certificates**: Every slot evaluation is sealed using an institutional HMAC secret.
- **Binary Merkle Tree Root**: Computes a binary Merkle tree root over all screened decisions for a slot.
- **One-Click SAR Export (`GET /export/slot/:slot`)**: Downloads a sealed `.zip` archive containing:
  - `compliance_certificate.txt` (HMAC seal, Merkle root, winning header, policy version).
  - `merkle_proof.json` (slot Merkle tree structure).
  - `decisions_audit.json` (full audit trail of screened transactions).
  - `bids_audit.json` (all builder bids, verdicts, and disqualification reasons).

---

## Compliance Decision Matrix

| Category | Decision | Risk Score | Trigger Condition | Builder / Relay Action |
| :--- | :--- | :--- | :--- | :--- |
| **Direct Sanctions** | `BLOCK` | 98 | Sender or recipient matches OFAC SDN list in Redis (`SANCTIONED_SENDER`, `SANCTIONED_RECIPIENT`). | Immediate exclusion. Regulatory hard block. |
| **1-Hop Exposure** | `FLAG` | 55 | Direct counterparty to a sanctioned wallet identified in graph walk (`INDIRECT_SENDER_EXPOSURE`). | Quarantined in EDD queue; blocked under Strict Mode. |
| **Mixer Interaction** | `FLAG` | 45 | Counterparty identified as privacy mixer (e.g. Tornado Cash) via entity tags (`INTERACTION_WITH_MIXER`). | Augmented risk score; flagged for auditor review. |
| **2-Hop Exposure** | `FLAG` / `ALLOW` | 25 | Second-order contagion with decay factor (`INDIRECT_SENDER_EXPOSURE_2HOP`). | Evaluated against policy threshold. |
| **Sanctioned Fee Recipient** | `EXPOSED_BUILDER` | 98 | Builder fee recipient address matches OFAC SDN. | Builder disqualified from PBS auction. |
| **VASP Identification** | `ALLOW` | 0 | Counterparty verified as regulated Exchange VASP (`VASP_COUNTERPARTY_IDENTIFIED`). | Cleared with FATF Travel Rule audit metadata. |
| **Clean Transaction** | `ALLOW` | 0 | Clean address lineage. In-process `revm` dry-run passes. | Packaged into candidate block. |

---

## Getting Started

### Prerequisites

- **Rust (v1.80+) & Cargo**
- **Node.js (v20+) & npm**
- **Python (v3.11+) & pip**
- **PostgreSQL (v15+) & Redis (v7+)**
- **Foundry (`anvil`, `forge`, `cast`)** — [Install Foundry](https://getfoundry.sh/)

---

### Step 1: Database Setup & Migrations

Create the database and apply the initial schema, seeds, and migrations:

```bash
# 1. Create PostgreSQL database
createdb compliance_builder

# 2. Apply baseline schema and authoritative seed data
psql -d compliance_builder -f db/schema.sql
psql -d compliance_builder -f db/seed.sql
psql -d compliance_builder -f db/seed_addresses.sql
psql -d compliance_builder -f db/seed_entities.sql
psql -d compliance_builder -f db/seed_policies.sql

# 3. Apply phase migrations (Hardening, EDD Queue, AI Summaries)
psql -d compliance_builder -f db/migrations/001_phase1_hardening.sql
psql -d compliance_builder -f db/migrations/002_edd_cases.sql
psql -d compliance_builder -f db/migrations/003_relay_ai_summary.sql
```

Verify seeded records:
```bash
psql -d compliance_builder -c "SELECT COUNT(*) FROM address_attributions;"
# Expected: 122 (121 OFAC wallet addresses + 1 demo validator coinbase)
```

---

### Step 2: Environment Configuration

Copy all `.env.example` templates across each component:

```bash
cp .env.example .env
cp engine/.env.example engine/.env
cp relay/.env.example relay/.env
cp simulator/.env.example simulator/.env
cp contracts/.env.example contracts/.env
cp api/.env.example api/.env
cp ai-explainer/.env.example ai-explainer/.env
cp dashboard/.env.example dashboard/.env.local
```

*(Optional)*:
- In `.env`, `simulator/.env`, or `contracts/.env`: configure `MAINNET_FORK_RPC_URL` with your free-tier Alchemy or Infura key (e.g. `https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY`). If omitted, Anvil gracefully falls back to public archive endpoints (e.g. `https://eth.drpc.org`).
- In `ai-explainer/.env`, add your `GEMINI_API_KEY` to enable live LLM audit explanations. If omitted, the service gracefully falls back to deterministic rule summaries.

---

### Step 3: Launch Services

Open separate terminal tabs or run services in the background:

#### Terminal 1: Local Ethereum Node (Anvil in Mainnet Fork Mode)
```bash
# Start Anvil in fork mode pinned to finalized mainnet block 21000000
anvil --fork-url "${MAINNET_FORK_RPC_URL:-https://eth.drpc.org}" --fork-block-number 21000000
# Listening on http://127.0.0.1:8545
```

> **Why Pinned Block 21,000,000?**
> Pinned block `21000000` (finalized Ethereum Mainnet block from October 2024) guarantees 100% deterministic, reproducible state across all live demonstrations and test runs. At this block height, canonical OFAC-sanctioned smart contracts (such as the Tornado Cash 1 ETH pool `0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936`) and Lazarus-attributed accounts (`0x098B716B8Aaf21512996dC57EB0615e2383E2f96`) are fully active on-chain with verified historical balances and transaction counts. Pinning a finalized block avoids state drift, nonce mismatches, and transient RPC reorgs that occur when using mutable `latest`.
>
> **Cost & Safety Guarantee (Strictly Read-Only)**:
> Forking Ethereum mainnet via Anvil is strictly **read-only** against upstream RPC providers. Transactions executed locally do **not** broadcast to Ethereum mainnet and consume **zero real gas or real ETH**.
>
> **Rate-Limit & Caching Handling**:
> Free-tier RPC providers enforce requests-per-second (RPS) limits. Anvil automatically caches state reads locally upon first access. Subsequent queries and repeat simulations run instantly from local cache without triggering provider rate limits.

#### Terminal 2: Redis In-Memory Cache
```bash
redis-server
# Listening on 127.0.0.1:6379
```

#### Terminal 3: Rust Compliance Engine
```bash
cd engine
cargo run
# Loaded 121 sanctioned addresses into Redis cache
# Listening on http://127.0.0.1:3001
```

#### Terminal 4: Rust Relay Service (PBS Gatekeeper)
```bash
cd relay
cargo run
# PBS Relay auction gatekeeper listening on http://127.0.0.1:3003
```

#### Terminal 5: Fastify API & WebSocket Gateway
```bash
cd api
npm install
npm run dev
# Listening on http://localhost:3002 (WebSocket on ws://localhost:3002/ws)
```

#### Terminal 6: AI Explainer Microservice (Python)
```bash
cd ai-explainer
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
# Listening on http://127.0.0.1:8000
```

#### Terminal 7: Next.js Mission Control Dashboard
```bash
cd dashboard
npm install
npm run dev
# Running on http://localhost:3000
```

#### Terminal 8: Deploy Smart Contract & Start Attribution Worker
```bash
# Deploy Counter contract for revm parity testing
cd contracts
forge create src/Counter.sol:Counter \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Start post-execution attribution listener
cd ../simulator
cargo run --bin attribution_worker
```

---

## Demonstrations & Verification

### 1. The 60-Second Judge Demonstration
Run the automated end-to-end demonstration script:

```bash
bash scripts/demo_flow.sh
```

**What it executes in <60 seconds:**
1. Verifies health of all microservices (Engine :3001, Relay :3003, API :3002).
2. Activates Strict Institutional Policy (`institution-standard-v1`).
3. Fires concurrent mock builders for Slot 12:
   - **B1**: Clean Payload (2.0 ETH).
   - **B2**: Directly Sanctioned Transaction (2.5 ETH).
   - **B3**: Mixer Interaction + Sanctioned Fee Recipient (1.8 ETH).
4. Evaluates PBS header auction: **Clean Builder B1 wins the slot at 2.0 ETH**, while higher bid B2 (2.5 ETH) is disqualified.
5. Demonstrates live policy switching to Lenient Policy (`institution-lenient-v1`).
6. Downloads and verifies the cryptographically signed HMAC-SHA256 SAR audit pack (`slot_12_audit_pack.zip`).

---

### 2. Mock Builders Simulation CLI
Simulate builder competition on any arbitrary slot:

```bash
cargo run --manifest-path simulator/Cargo.toml --bin mock_builders -- --slot 14
```

Then open `http://localhost:3000` and select Slot 14 in the **Relay Auction** tab to watch the live auction results.

---

### 3. End-to-End Mempool Simulator
Run the 7-scenario mempool simulation suite:

```bash
cargo run --manifest-path simulator/Cargo.toml --bin simulator
```

**Scenarios executed:**
- **Scenario 1**: Clean EOA transfer passing `revm` dry-run and included on-chain.
- **Scenario 2**: Sanctioned recipient caught and blocked in $O(1)$ time via Redis.
- **Scenario 3**: 1-hop indirect counterparty exposure flagged for human review.
- **Scenario 4**: Real smart contract execution (`Counter.increment()`) proving `revm` gas/state parity with Anvil.
- **Scenario 5**: Concurrent multi-scenario stress test (350+ tx/sec, 0 cross-contamination).
- **Scenario 6**: Fail-closed fault injection proof (halting block inclusion if screening engine goes offline).
- **Scenario 7**: **Real Historical Sanctioned Entity (Mainnet Fork Verification)** — validates live on-chain bytecode (5,191 bytes) and balance (2,637 ETH) for the authentic OFAC-sanctioned Tornado Cash 1 ETH Pool (`0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936`), as well as real historical nonce and balance for the Lazarus Group / Ronin Exploiter (`0x098B716B8Aaf21512996dC57EB0615e2383E2f96`), confirming the engine deterministically outputs `BLOCK` with `SANCTIONED_RECIPIENT` / `SANCTIONED_SENDER` / `INTERACTION_WITH_MIXER` and excludes them from block candidates.

---

## Live Judge Inspection Guide

### Inspect Database State
```bash
# Check recent compliance screening decisions
psql -d compliance_builder -c "
SELECT tx_hash, sender, recipient, decision, risk_score, reason_codes 
FROM compliance_decisions ORDER BY id DESC LIMIT 5;
"

# Check PBS Relay bids and verdicts
psql -d compliance_builder -c "
SELECT id, slot, builder_id, verdict, value_wei, reasons 
FROM relay_bids ORDER BY id DESC LIMIT 5;
"

# Check Enhanced Due Diligence (EDD) cases
psql -d compliance_builder -c "
SELECT id, case_ref, tx_hash, status, risk_score, assignee 
FROM edd_cases ORDER BY id DESC LIMIT 5;
"
```

### Inspect Redis Sanctions Cache
```bash
# Check count of preloaded OFAC-sanctioned addresses (121)
redis-cli SCARD sanctioned_addresses

# Test O(1) membership check
redis-cli SISMEMBER sanctioned_addresses 0x0330070fd38ec3bb94f58fa55d40368271e9e54a
# Output: 1
```

### Mission Control Dashboard Walkthrough
Navigate to **[http://localhost:3000](http://localhost:3000)**:
1. **Relay Auction Tab**:
   - Live slot auction view showing builder bids, values, and verdicts.
   - **Winner Spotlight**: Compliant winner highlighted with golden trophy 🏆 and green border.
   - **Disqualified Strike-Throughs**: Non-compliant bids struck through with clear reason pills.
   - **Switch Policy Button**: Toggle between Strict and Lenient institutional policies live.
   - **Export Signed SAR Pack Button**: Instantly download the cryptographic proof archive.
   - **EDD Drawer**: Click "EDD Cases" to inspect and resolve open compliance flags.
2. **Mempool Screening Tab**: Real-time stream of evaluated transactions with color-coded badges.
3. **Mined Blocks Tab**: Telemetry on mined blocks with proposer attribution (`COMPLIANT_BUILD` vs `EXPOSED_EXTERNAL`).
4. **Audit Lineage Tab**: Detailed trace of decision digests, Merkle tree inclusion, and Gemini compliance narratives.

---

## CI / CD Verification

All core services run comprehensive formatting, clippy lint checks, and automated test suites on GitHub Actions:

```bash
# Compliance Engine checks
cd engine && cargo fmt --check && cargo clippy -- -D warnings && cargo test

# Relay Service checks
cd ../relay && cargo fmt --check && cargo clippy -- -D warnings && cargo test

# Orchestration API checks
cd ../api && npm run build

# Dashboard checks
cd ../dashboard && npm run build
```

---

## License

This project is licensed under the [MIT License](LICENSE).