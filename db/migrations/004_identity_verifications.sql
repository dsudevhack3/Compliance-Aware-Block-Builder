-- Migration: 004_identity_verifications.sql
-- Description: Creates persistent storage for on-chain & off-chain KYC / Decentralized Identity verifications

CREATE TABLE IF NOT EXISTS identity_verifications (
    applicant VARCHAR(42) PRIMARY KEY,
    is_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    nationality_country_code INT NOT NULL DEFAULT 0,
    provider VARCHAR(50) NOT NULL,
    credential_hash VARCHAR(66),
    request_id VARCHAR(66),
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_verifications_eligible ON identity_verifications(is_eligible);
CREATE INDEX IF NOT EXISTS idx_identity_verifications_expires_at ON identity_verifications(expires_at);

-- Pre-seed demo institutional wallet
INSERT INTO identity_verifications (
    applicant,
    is_eligible,
    nationality_country_code,
    provider,
    credential_hash,
    request_id,
    verified_at,
    expires_at,
    updated_at
) VALUES (
    '0x28c6c06298d514db089934071355e5743bf21d60',
    TRUE,
    840,
    'EXCHANGE_KYC',
    '0x9c56cc920978c61304e3887b44071ce879365bc045ff6e1d2ec1d40bb7993838',
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    NOW(),
    NOW() + INTERVAL '365 days',
    NOW()
)
ON CONFLICT (applicant) DO NOTHING;
