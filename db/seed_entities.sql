-- Seed entity labels for VASP / Travel Rule attribution and classification
-- Entities are classified as Exchange, Mixer, DeFiProtocol, or UnknownEOA

INSERT INTO entity_labels (address, entity_name, entity_type, attribution_source, confidence) VALUES
-- Exchanges (VASPs)
('0x28c6c06298d514db089934071355e5743bf21d60', 'Binance Hot Wallet 14', 'Exchange', 'Etherscan Labeled / Chainalysis', 0.99),
('0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase Deposit', 'Exchange', 'Etherscan Labeled', 0.98),
('0x267be1c1d684f74cb4f695ffb584993647247717', 'Kraken Hot Wallet', 'Exchange', 'Etherscan Labeled', 0.99),
('0xdac17f958d2ee523a2206206994597c13d831ec7', 'Tether USD Token Contract', 'DeFiProtocol', 'Contract Registry', 1.00),

-- Mixers & Anonymity Enhancement
('0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc', 'Tornado.Cash: 0.1 ETH', 'Mixer', 'OFAC / Contract Registry', 1.00),
('0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', 'Tornado.Cash: 1 ETH', 'Mixer', 'OFAC / Contract Registry', 1.00),
('0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', 'Tornado.Cash: 10 ETH', 'Mixer', 'OFAC / Contract Registry', 1.00),
('0xa160cd940196f185dd0337a88e845e7df0393779', 'Tornado.Cash: 100 ETH', 'Mixer', 'OFAC / Contract Registry', 1.00),

-- DeFi Protocols
('0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3: SwapRouter', 'DeFiProtocol', 'Contract Registry', 1.00),
('0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap V3: Universal Router', 'DeFiProtocol', 'Contract Registry', 1.00),
('0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', 'Aave: Pool V3', 'DeFiProtocol', 'Contract Registry', 1.00),
('0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', 'Curve.fi: DAI/USDC/USDT Pool', 'DeFiProtocol', 'Contract Registry', 1.00)
ON CONFLICT (address) DO UPDATE SET
    entity_name = EXCLUDED.entity_name,
    entity_type = EXCLUDED.entity_type,
    attribution_source = EXCLUDED.attribution_source,
    confidence = EXCLUDED.confidence;
