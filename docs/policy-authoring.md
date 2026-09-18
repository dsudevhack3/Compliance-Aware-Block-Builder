# Compliance Policy Authoring & Configuration Guide

This guide explains how institutional compliance teams author, test, and activate compliance policies within the **Compliance-Aware Block Builder**.

---

## 1. Policy Schema (`PolicyParameters`)

Policies are stored as JSON files in `db/policies/*.json` and registered in the PostgreSQL `compliance_policies` table.

```json
{
  "policy_id": "institution-standard-v1",
  "name": "Standard Institutional Policy",
  "version": "1.0.0",
  "description": "Strict institutional compliance policy with 2-hop graph walk decay and VASP attribution.",
  "parameters": {
    "flag_threshold": 40,
    "block_threshold": 70,
    "max_hop_distance": 2,
    "flag_mixers": true,
    "flag_unregistered_vasp": false,
    "strict_mode": true,
    "require_vasp_attribution_above_usd": 10000.0
  }
}
```

### Parameter Reference

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `flag_threshold` | `int` | `40` | Risk score at or above which transactions receive `FLAG` status. |
| `block_threshold` | `int` | `70` | Risk score at or above which transactions receive `BLOCK` status. |
| `max_hop_distance` | `int` | `2` | Maximum recursive counterparty traversal depth (`1` or `2`). Set to `1` for relaxed latency. |
| `flag_mixers` | `bool` | `true` | When `true`, automatically assigns 45 risk points and `INTERACTION_WITH_MIXER` to mixer counterparties. |
| `flag_unregistered_vasp` | `bool` | `false` | When `true`, flags high-volume counterparties that lack verified VASP entity attribution. |
| `strict_mode` | `bool` | `true` | When `true`, any multi-hop link to a high-confidence sanctioned entity is treated as severe risk. |
| `require_vasp_attribution_above_usd` | `float` | `10000.0` | FATF Travel Rule threshold in USD equivalent for triggering attribution validation. |

---

## 2. Risk Scoring & Distance Decay Model

When an address undergoes evaluation:
- **Direct Sanctions Hit**: Yields risk score **`98`**. (Always **`BLOCK`**, regardless of thresholds).
- **1-Hop Indirect Exposure**: Counterparty interacted directly with a sanctioned wallet.
  - Risk Score contribution: **`55`**.
  - Reason Code: `INDIRECT_SENDER_EXPOSURE` or `INDIRECT_RECIPIENT_EXPOSURE`.
- **2-Hop Indirect Exposure**: Counterparty's counterparty interacted with a sanctioned wallet.
  - Risk Score contribution: **`25`** (Decay factor applied).
  - Reason Code: `INDIRECT_SENDER_EXPOSURE_2HOP` or `INDIRECT_RECIPIENT_EXPOSURE_2HOP`.
- **Mixer Interaction**: Counterparty is identified as a known mixer (e.g. Tornado Cash).
  - Risk Score contribution: **`45`**.
  - Reason Code: `INTERACTION_WITH_MIXER`.

### Policy Divergence Example

| Factor | Score | `institution-standard-v1` (Flag: 40, Block: 70) | `institution-lenient-v1` (Flag: 60, Block: 85) |
| :--- | :--- | :--- | :--- |
| **1-Hop Exposure** | 55 | **`FLAG`** (55 ≥ 40) | **`ALLOW`** (55 < 60) |
| **2-Hop Exposure** | 25 | **`ALLOW`** (25 < 40) | **`ALLOW`** (Evaluated as None when max_hop=1) |
| **Mixer Interaction** | 45 | **`FLAG`** (45 ≥ 40) | **`ALLOW`** (45 < 60) |
| **Direct OFAC Match** | 98 | **`BLOCK`** (Direct Hit Rule) | **`BLOCK`** (Direct Hit Rule) |

---

## 3. Registering & Hot-Swapping Policies

### Registering a New Policy in PostgreSQL

```sql
INSERT INTO compliance_policies (policy_id, name, description, is_active, rules)
VALUES (
    'institution-hedgefund-v1',
    'Hedge Fund Zero-Tolerance Policy',
    'Custom zero-tolerance policy flagging any 2-hop exposure.',
    FALSE,
    '{"flag_threshold": 20, "block_threshold": 50, "max_hop_distance": 2, "flag_mixers": true, "strict_mode": true}'::jsonb
);
```

### Hot-Swapping Active Policy via API

Call the Fastify endpoint without restarting the engine:

```bash
curl -X POST http://localhost:3002/api/policy/activate \
  -H "Content-Type: application/json" \
  -d '{"policy_id": "institution-hedgefund-v1"}'
```

All connected dashboards receive an instant WebSocket notification (`policy_changed`), and all subsequent transactions evaluate against the new policy thresholds immediately.
