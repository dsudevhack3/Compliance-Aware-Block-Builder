-- Seed known sanctions entities with fixed UUIDs for deterministic referential integrity
INSERT INTO sanctions_entities (entity_id, name, source, list_type)
VALUES 
    ('fdc51272-322c-46dd-a511-2d2330a2b767', 'OFAC SDN - Digital Currency Addresses', 'OFAC_SDN', 'CRYPTO_ADDRESS'),
    ('c46c5c1c-ac06-4fbe-96a9-d688323328e9', 'Demo Sanctioned Validator Corp', 'DEMO', 'VALIDATOR')
ON CONFLICT (entity_id) DO NOTHING;
