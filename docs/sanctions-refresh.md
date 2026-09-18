# Sanctions List Refresh Mechanism

## Overview

The Compliance-Aware Block Builder utilizes a dynamic sanctions synchronization job to maintain an up-to-date sanctions hot-set without downtime or static seed reliance.

The refresh job fetches sanctioned digital currency addresses directly from the community-maintained 0xB10C OFAC SDN mirror:
- **Source**: `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt`
- **Cadence**: Recommended once daily (OFAC updates publication around 00:00 UTC).

---

## Architecture & Failure Isolation

1. **Deterministic Fetch & Validation**:
   - Downloads raw Ethereum addresses from the authoritative mirror.
   - Validates each address format (must be 42 characters, start with `0x`, hex-encoded).
   - Filters out malformed entries or comments.

2. **Database Diff & Upsert**:
   - Compares fetched addresses against existing rows in Postgres `address_attributions`.
   - Inserts newly identified addresses and updates timestamps on existing records.
   - Associates each address with the canonical `sanctions_entities` entry.

3. **Atomic Redis Hot-Set Refresh**:
   - Atomically refreshes the Redis `sanctioned_addresses` set via `load_sanctions_into_redis`.
   - The running Axum compliance engine picks up newly sanctioned addresses immediately without requiring a restart.

4. **Fail-Safe Isolation (Never Wipe Good Data)**:
   - If the network request fails, times out, or returns 0 addresses, the refresh job records `status = 'FAILURE'` in `sanctions_list_updates` and halts.
   - The existing Postgres addresses and Redis hot-set remain 100% untouched.

5. **Audit Trail & Observability**:
   - Every refresh attempt is logged to the `sanctions_list_updates` table:
     ```sql
     CREATE TABLE sanctions_list_updates (
         update_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         source_name VARCHAR(100) NOT NULL,
         fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
         address_count INT NOT NULL,
         status VARCHAR(20) NOT NULL, -- 'SUCCESS' | 'FAILURE'
         error_message TEXT
     );
     ```
   - The Fastify API surfaces the latest update timestamp and address count on `/api/stats`.
   - The Next.js dashboard displays live sanctions status and timestamp in the top status bar.

---

## Triggering a Refresh

### Manual Execution

Inside the `engine/` directory:

```bash
cargo run --bin refresh_sanctions
```

### Environment Configuration

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | *(Required)* | Postgres connection string |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |
| `SANCTIONS_SOURCE_URL` | `https://raw.githubusercontent.com/...` | Raw list URL to sync |
| `SANCTIONS_SOURCE_NAME` | `0xB10C OFAC SDN Mirror` | Human-readable audit name |

### Automated Scheduling (Cron / Systemd)

To schedule automatic synchronization every night at midnight:

```cron
0 0 * * * cd /path/to/compliance-block-builder/engine && cargo run --release --bin refresh_sanctions >> /var/log/sanctions_refresh.log 2>&1
```
