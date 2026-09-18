# Compliance Architecture & Regulatory Mapping Guide

This document provides the definitive mapping of the **Compliance-Aware Block Builder** architecture against institutional regulatory mandates:
- **VASP Wallet Attribution**: Attribution of crypto wallet addresses to Virtual Asset Service Providers (VASPs) for FATF Travel Rule compliance.
- **Fraud-Linked & Mixer Identification**: Identification of illicit addresses, privacy-enhancing mixers, and multi-hop counterparty taint propagation.

---

## 1. Regulatory Compliance Matrix

| Dimension | VASP Attribution | Fraud-Linked & Mixer Identification |
| :--- | :--- | :--- |
| **Core Regulatory Mandate** | FATF Recommendation 16 ("Travel Rule") requiring financial institutions to identify originator and beneficiary VASPs for transfers exceeding $10,000 USD. | OFAC SDN sanctions enforcement and AML layering detection through obfuscation mixers and intermediary money mules. |
| **System Entity Classification** | `Exchange` (e.g. Binance Hot Wallets, Coinbase Deposit, Kraken Custody) | `Mixer` (e.g. Tornado Cash 0.1/1/10/100 ETH pools) & `Direct Sanctions` |
| **Detection Mechanism** | Labeled attribution dataset (`entity_labels`) with high-confidence cross-referencing and Travel Rule threshold evaluation. | $O(1)$ atomic Redis OFAC SDN cache + Bounded 2-hop recursive SQL graph walk with distance decay ($55 \to 25$). |
| **Screening Outcome** | **`ALLOW`** with compliance reason code `VASP_COUNTERPARTY_IDENTIFIED` & Travel Rule audit trail. | **`BLOCK`** (Direct OFAC match, score 98) or **`FLAG`** (Mixer / 1-hop / 2-hop contagion, score 45–55). |
| **Regulatory Evidence Output** | Tamper-evident PDF Audit Certificate with counterparty attribution and SHA-256 cryptographic seal. | Automated quarantine from candidate block + AI regulatory narrative explaining risk exposure. |

---

## 2. In-Depth Architecture Details

### VASP Wallet Attribution

#### The Problem
Decentralized block builders cannot distinguish between anonymous pseudonymous peer-to-peer transfers and institutional transactions routed through regulated Virtual Asset Service Providers (VASPs). Without attribution, institutional builders risk non-compliance with FATF Travel Rule mandates when packaging large-value transactions.

#### Our Solution in Code
1. **Attribution Engine (`engine/src/lib.rs` & `db/seed_entities.sql`)**:
   - The engine checks recipient addresses against `entity_labels` containing verified VASP attribution data.
   - When a transaction targets a regulated exchange (e.g. Binance `0x28c6c06298d514db089934071355e5743bf21d60` or Coinbase `0x71660c4005ba85c37ccec55d0c4493e66fe775d3`):
     - Maps `counterparty_entity_type` to `Exchange`.
     - Assigns reason code `VASP_COUNTERPARTY_IDENTIFIED`.
     - Evaluates `require_vasp_attribution_above_usd` ($10,000 USD equivalent).
2. **Dashboard Visualization (`dashboard/src/app/page.tsx`)**:
   - Displays a dedicated cyan `Exchange (VASP)` telemetry badge in the Live Mempool Monitor.
   - Lineage & Audit Inspector displays verified entity ownership and Travel Rule compliance status.
3. **Verifiable Audit Certificate (`api/src/server.ts`)**:
   - Generates an institutional PDF report containing the transaction hash, VASP name, attribution source, and immutable SHA-256 integrity seal.

---

### Fraud-Linked & Mixer Identification

#### The Problem
Bad actors rarely transact directly with known OFAC addresses when executing exploits or laundering illicit capital. Instead, they layer funds through anonymity enhancers (mixers like Tornado Cash) or pass funds through intermediary money-mule hops to evade simplistic 0-hop sanctions filters.

#### Our Solution in Code
1. **Mixer Detection (`engine/src/lib.rs`)**:
   - Known mixer smart contracts (Tornado Cash pools) are classified as `Mixer`.
   - Under active institutional policy (`flag_mixers: true`), interaction automatically assigns **45 risk points** and triggers `INTERACTION_WITH_MIXER`.
2. **2-Hop Graph Walk with Distance Decay (`engine/src/lib.rs`)**:
   - Rather than checking only direct counterparties, the Rust engine executes a bounded recursive CTE query over `compliance_decisions`:
     - **1-Hop Exposure**: Direct interaction with a sanctioned wallet yields **`55` risk points** (`INDIRECT_SENDER_EXPOSURE`).
     - **2-Hop Exposure**: Counterparty's counterparty interacted with a sanctioned wallet yields **`25` risk points** (`INDIRECT_SENDER_EXPOSURE_2HOP`).
   - Mathematically models risk attenuation over network distance ($55 > 25$).
3. **Hard Regulatory Invariant**:
   - Even if a misconfigured or ultra-lenient policy file sets `block_threshold = 9999`, direct OFAC SDN matches **ALWAYS `BLOCK`** (Risk 98). Proved by test `test_direct_sanctions_invariant_cannot_be_overridden_by_lenient_policy`.
4. **Post-Execution Proposer Attribution (`simulator/src/bin/attribution_worker.rs`)**:
   - Unmasks blocks proposed by sanctioned validators (Coinbase address linked to sanctioned entity IDs), flagging them as `EXPOSED_EXTERNAL`.

---

## 3. Evaluation Presentation Script & Demo Flow

### 30-Second Elevator Pitch
> *"In today's Ethereum, block builders process billions in volume without knowing if they are facilitating illicit money laundering or violating international sanctions. We built the **Compliance-Aware Block Builder**—the first production-ready block building engine with deterministic pre-execution screening. Our engine provides real-time VASP wallet attribution for FATF Travel Rule compliance, identifies fraud-linked mixers, and performs 2-hop graph walks with distance decay to catch layered money laundering. All decisions are evaluated deterministically in compiled Rust in under **3.8 microseconds** (over 390,000 transactions per second), sealed with SHA-256 cryptographic proofs, and explained asynchronously by AI."*

### Live Demo Walkthrough Steps

| Step | Action | What Observers See | Category |
| :--- | :--- | :--- | :--- |
| **1. VASP Transfer** | Screen transfer to Binance hot wallet (`0x28c6...1d60`). | Dashboard shows cyan `Exchange (VASP)` badge, reason `VASP_COUNTERPARTY_IDENTIFIED`, and cleared `ALLOW` status. | **VASP Attribution** |
| **2. Fraud & Mixer ID** | Screen transfer to Tornado Cash 1 ETH pool (`0x47ce...2936`). | Evaluates to `FLAG` (risk 45), purple `Mixer` badge, and reason `INTERACTION_WITH_MIXER`. | **Mixer Identification** |
| **3. 2-Hop Contagion** | Screen transfer from Hop-2 exposed address. | Evaluates with `2-Hop (Decay 25)` badge and reason `INDIRECT_SENDER_EXPOSURE_2HOP`. | **Contagion Graph Walk** |
| **4. Policy Divergence** | Click policy switcher in top-right from **Standard (2-Hop)** to **Lenient (1-Hop)**. | Identical 1-hop transaction flips from `FLAG` to `ALLOW`, proving dynamic institutional governance. | **Core Innovation** |
| **5. PDF Audit Export** | Click **"Download Audit Report (PDF)"**. | Generates tamper-evident PDF with transaction telemetry and SHA-256 cryptographic seal. | **Regulatory Evidence** |
| **6. Empirical Benchmark** | Point to latency benchmarks. | **3.75 µs p99 latency** (0.00003% of 12s slot), **394,282 tx/sec throughput**. | **Production Viability** |

---

## 4. Empirical Performance Benchmarks

Measured on compiled release binary (`cargo run --release --bin bench_screening`, 10,000 iterations):

```
------------------------------------------------------------------
 BENCHMARK RESULTS (Compiled Rust Release Core)
------------------------------------------------------------------
 Total Transactions Screened :      10,000
 Total Time Elapsed          :      25.363 ms
 Screening Throughput        :     394,282 tx/sec
------------------------------------------------------------------
 Min Latency                 :        1.83 µs (0.0018 ms)
 Mean Latency                :        2.45 µs (0.0025 ms)
 p50 (Median Latency)        :        2.33 µs (0.0023 ms)
 p95 Latency                 :        3.12 µs (0.0031 ms)
 p99 Latency                 :        3.75 µs (0.0037 ms)
 Max Latency                 :      159.54 µs (0.1595 ms)
------------------------------------------------------------------
 Verdict: Consumes only 0.00003% of the 12-second Ethereum slot.
------------------------------------------------------------------
```
