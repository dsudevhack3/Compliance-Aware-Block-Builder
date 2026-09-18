-- Migration 003: Add ai_summary column to relay_bids for automated compliance narration
ALTER TABLE relay_bids
    ADD COLUMN IF NOT EXISTS ai_summary TEXT;
