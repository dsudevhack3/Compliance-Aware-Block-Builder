-- Seed compliance policies
INSERT INTO compliance_policies (policy_id, name, description, is_active, rules) VALUES
(
    'institution-standard-v1',
    'Standard Institutional Policy',
    'Standard institutional policy: strict 2-hop decay screening, flag threshold at 40, block threshold at 70, mandatory VASP attribution requirement above $10,000 USD equivalent.',
    TRUE,
    '{"flag_threshold": 40, "block_threshold": 70, "max_hop_distance": 2, "flag_mixers": true, "flag_unregistered_vasp": false, "strict_mode": true, "require_vasp_attribution_above_usd": 10000.0}'::jsonb
),
(
    'institution-lenient-v1',
    'Lenient Institutional Policy',
    'Lenient institutional policy: 1-hop only screening, relaxed thresholds (flag: 60, block: 85), higher threshold for VASP attribution reporting ($50,000 USD equivalent).',
    FALSE,
    '{"flag_threshold": 60, "block_threshold": 85, "max_hop_distance": 1, "flag_mixers": true, "flag_unregistered_vasp": false, "strict_mode": false, "require_vasp_attribution_above_usd": 50000.0}'::jsonb
)
ON CONFLICT (policy_id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    rules = EXCLUDED.rules;
