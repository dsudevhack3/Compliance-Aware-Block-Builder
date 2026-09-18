-- Migration 001: Phase 1 DB Hardening for Relay MVP

-- 1. Create relay_bids table
CREATE TABLE IF NOT EXISTS relay_bids (
    id BIGSERIAL PRIMARY KEY,
    slot INT NOT NULL,
    builder_id TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    fee_recipient TEXT NOT NULL,
    value_wei NUMERIC NOT NULL,
    verdict TEXT NOT NULL,
    reasons JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relay_bids_slot ON relay_bids(slot DESC);
CREATE INDEX IF NOT EXISTS idx_relay_bids_builder ON relay_bids(builder_id);

-- 2. Harden compliance_decisions
-- Make recipient nullable
ALTER TABLE compliance_decisions ALTER COLUMN recipient DROP NOT NULL;

-- Add bundle_id column if not exists
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='compliance_decisions' AND column_name='bundle_id') THEN
        ALTER TABLE compliance_decisions ADD COLUMN bundle_id TEXT;
    END IF;
END $$;

-- Add surrogate PK if tx_hash is currently PK
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='compliance_decisions' AND column_name='id') THEN
        ALTER TABLE compliance_decisions DROP CONSTRAINT IF EXISTS compliance_decisions_pkey;
        ALTER TABLE compliance_decisions ADD COLUMN id BIGSERIAL PRIMARY KEY;
        CREATE INDEX IF NOT EXISTS idx_compliance_decisions_tx_hash ON compliance_decisions(tx_hash);
    END IF;
END $$;

-- Add CHECK constraints
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_decision') THEN
        ALTER TABLE compliance_decisions ADD CONSTRAINT chk_decision CHECK (decision IN ('ALLOW', 'FLAG', 'BLOCK', 'REVIEW'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_risk_score') THEN
        ALTER TABLE compliance_decisions ADD CONSTRAINT chk_risk_score CHECK (risk_score >= 0 AND risk_score <= 100);
    END IF;
END $$;

-- 3. Add Partial unique index on compliance_policies
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_policies_active ON compliance_policies (is_active) WHERE is_active = TRUE;

-- 4. Add Performance and Case-Insensitive LOWER() indexes
CREATE INDEX IF NOT EXISTS idx_blocks_builder_address ON blocks(builder_address);
CREATE INDEX IF NOT EXISTS idx_blocks_builder_address_lower ON blocks(LOWER(builder_address));
CREATE INDEX IF NOT EXISTS idx_address_attributions_lower ON address_attributions(LOWER(address));
CREATE INDEX IF NOT EXISTS idx_entity_labels_lower ON entity_labels(LOWER(address));
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_bundle_id ON compliance_decisions(bundle_id);
