CREATE TABLE IF NOT EXISTS sanctions_entities (
    entity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    source VARCHAR(50) NOT NULL,
    list_type VARCHAR(50) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS address_attributions (
    address VARCHAR(42) PRIMARY KEY,
    entity_id UUID REFERENCES sanctions_entities(entity_id),
    attribution_type VARCHAR(50),
    confidence NUMERIC(3, 2) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_decisions (
    id BIGSERIAL PRIMARY KEY,
    bundle_id TEXT,
    tx_hash VARCHAR(66) NOT NULL,
    sender VARCHAR(42) NOT NULL,
    recipient VARCHAR(42), -- NULLABLE for contract creation transactions
    decision VARCHAR(10) NOT NULL,
    risk_score INT NOT NULL,
    reason_codes TEXT[] NOT NULL,
    ai_explanation TEXT,
    policy_version VARCHAR(50) NOT NULL,
    counterparty_entity_type VARCHAR(50),
    exposure_hop_distance INT,
    integrity_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_decision CHECK (decision IN ('ALLOW', 'FLAG', 'BLOCK', 'REVIEW')),
    CONSTRAINT chk_risk_score CHECK (risk_score >= 0 AND risk_score <= 100)
);

CREATE TABLE IF NOT EXISTS blocks (
    block_hash VARCHAR(66) PRIMARY KEY,
    block_number BIGINT NOT NULL,
    builder_address VARCHAR(42) NOT NULL,
    proposer_entity_id UUID REFERENCES sanctions_entities(entity_id),
    tx_count INT NOT NULL,
    compliance_status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS sanctions_list_updates (
    update_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_name VARCHAR(100) NOT NULL,
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    address_count INT NOT NULL,
    status VARCHAR(20) NOT NULL,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS entity_labels (
    address VARCHAR(42) PRIMARY KEY,
    entity_name VARCHAR(255) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    attribution_source VARCHAR(100) NOT NULL,
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_policies (
    policy_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    rules JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_created_at ON compliance_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_tx_hash ON compliance_decisions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_bundle_id ON compliance_decisions(bundle_id);
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_sender ON compliance_decisions(LOWER(sender));
CREATE INDEX IF NOT EXISTS idx_compliance_decisions_recipient ON compliance_decisions(LOWER(recipient));

CREATE INDEX IF NOT EXISTS idx_blocks_block_number ON blocks(block_number DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_builder_address ON blocks(builder_address);
CREATE INDEX IF NOT EXISTS idx_blocks_builder_address_lower ON blocks(LOWER(builder_address));

CREATE INDEX IF NOT EXISTS idx_address_attributions_entity ON address_attributions(entity_id);
CREATE INDEX IF NOT EXISTS idx_address_attributions_lower ON address_attributions(LOWER(address));

CREATE INDEX IF NOT EXISTS idx_entity_labels_type ON entity_labels(entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_labels_lower ON entity_labels(LOWER(address));

CREATE INDEX IF NOT EXISTS idx_sanctions_list_updates_fetched_at ON sanctions_list_updates(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_relay_bids_slot ON relay_bids(slot DESC);
CREATE INDEX IF NOT EXISTS idx_relay_bids_builder ON relay_bids(builder_id);

-- Partial unique index ensuring only one active policy at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_policies_active ON compliance_policies (is_active) WHERE is_active = TRUE;
