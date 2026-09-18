-- Migration 002: EDD Cases Queue for Enhanced Due Diligence

CREATE TABLE IF NOT EXISTS edd_cases (
    id BIGSERIAL PRIMARY KEY,
    case_ref TEXT NOT NULL,
    tx_hash TEXT,
    bid_hash TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    assignee TEXT,
    note TEXT,
    risk_score INT,
    reasons JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_edd_cases_status ON edd_cases(status);
CREATE INDEX IF NOT EXISTS idx_edd_cases_tx_hash ON edd_cases(tx_hash);
CREATE INDEX IF NOT EXISTS idx_edd_cases_case_ref ON edd_cases(case_ref);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_edd_status') THEN
        ALTER TABLE edd_cases ADD CONSTRAINT chk_edd_status CHECK (status IN ('OPEN', 'APPROVED', 'QUARANTINED'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_compliance_decisions_tx_hash') THEN
        ALTER TABLE compliance_decisions ADD CONSTRAINT uq_compliance_decisions_tx_hash UNIQUE (tx_hash);
    END IF;
END $$;
