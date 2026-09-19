use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use thiserror::Error;
use tracing::{error as log_error, info as log_info, warn as log_warn};

pub const SANCTIONS_SET_KEY: &str = "sanctioned_addresses";
pub const CONTRACT_CREATION_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

type HmacSha256 = Hmac<Sha256>;

pub fn get_audit_hmac_secret() -> String {
    std::env::var("AUDIT_HMAC_SECRET")
        .or_else(|_| std::env::var("AUDIT_SECRET_KEY"))
        .unwrap_or_else(|_| "compliance-audit-secret-2026".to_string())
}

pub fn get_sanctions_env_key() -> String {
    let env = std::env::var("APP_ENV")
        .or_else(|_| std::env::var("NODE_ENV"))
        .unwrap_or_else(|_| "prod".to_string());
    format!("sanctions:{}", env)
}

#[allow(clippy::too_many_arguments)]
pub fn compute_decision_digest(
    tx_hash: &str,
    decision: &str,
    risk_score: i32,
    policy_version: &str,
    sender: &str,
    recipient: Option<&str>,
    counterparty_entity_type: Option<&str>,
    exposure_hop_distance: Option<i32>,
) -> String {
    let secret = get_audit_hmac_secret();
    let recipient_str = recipient.map_or("none".to_string(), |r| r.to_lowercase());
    let canonical = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        tx_hash.to_lowercase(),
        decision,
        risk_score,
        policy_version,
        sender.to_lowercase(),
        recipient_str,
        counterparty_entity_type.unwrap_or("None"),
        exposure_hop_distance.map_or("None".to_string(), |h| h.to_string()),
    );
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Computes a binary Merkle tree root over hex-encoded transaction digests.
pub fn compute_merkle_root(hashes: &[String]) -> String {
    if hashes.is_empty() {
        let mut hasher = Sha256::new();
        hasher.update(b"EMPTY_MERKLE_ROOT");
        return hex::encode(hasher.finalize());
    }

    let mut current_level: Vec<Vec<u8>> = hashes
        .iter()
        .map(|h| hex::decode(h).unwrap_or_else(|_| Sha256::digest(h.as_bytes()).to_vec()))
        .collect();

    while current_level.len() > 1 {
        let mut next_level = Vec::new();
        for chunk in current_level.chunks(2) {
            let mut hasher = Sha256::new();
            hasher.update(&chunk[0]);
            if chunk.len() > 1 {
                hasher.update(&chunk[1]);
            } else {
                hasher.update(&chunk[0]);
            }
            next_level.push(hasher.finalize().to_vec());
        }
        current_level = next_level;
    }

    hex::encode(&current_level[0])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityType {
    Exchange,
    Mixer,
    DeFiProtocol,
    UnknownEOA,
}

impl EntityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntityType::Exchange => "Exchange",
            EntityType::Mixer => "Mixer",
            EntityType::DeFiProtocol => "DeFiProtocol",
            EntityType::UnknownEOA => "UnknownEOA",
        }
    }

    pub fn from_str_opt(s: &str) -> Self {
        match s {
            "Exchange" => EntityType::Exchange,
            "Mixer" => EntityType::Mixer,
            "DeFiProtocol" => EntityType::DeFiProtocol,
            _ => EntityType::UnknownEOA,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyParameters {
    pub flag_threshold: i32,
    pub block_threshold: i32,
    pub max_hop_distance: i32,
    pub flag_mixers: bool,
    pub flag_unregistered_vasp: bool,
    pub strict_mode: bool,
    pub require_vasp_attribution_above_usd: Option<f64>,
    #[serde(default)]
    pub travel_threshold: Option<f64>,
}

impl PolicyParameters {
    pub fn validate(&self) -> Result<(), String> {
        if self.flag_threshold < 0 {
            return Err("flag_threshold cannot be negative".to_string());
        }
        if self.block_threshold < 0 {
            return Err("block_threshold cannot be negative".to_string());
        }
        if self.flag_threshold > self.block_threshold {
            return Err(format!(
                "flag_threshold ({}) cannot exceed block_threshold ({})",
                self.flag_threshold, self.block_threshold
            ));
        }
        if self.max_hop_distance < 0 {
            return Err("max_hop_distance cannot be negative".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompliancePolicy {
    pub policy_id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub parameters: PolicyParameters,
}

impl Default for CompliancePolicy {
    fn default() -> Self {
        Self {
            policy_id: "institution-standard-v1".to_string(),
            name: "Standard Institutional Policy".to_string(),
            version: "1.0.0".to_string(),
            description: Some("Default standard institutional policy".to_string()),
            parameters: PolicyParameters {
                flag_threshold: 40,
                block_threshold: 70,
                max_hop_distance: 2,
                flag_mixers: true,
                flag_unregistered_vasp: false,
                strict_mode: true,
                require_vasp_attribution_above_usd: Some(10000.0),
                travel_threshold: Some(10000.0),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ScreenRequest {
    pub tx_hash: String,
    pub sender: String,
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default)]
    pub value: Option<u64>,
    #[serde(default)]
    pub policy: Option<String>,
    #[serde(default)]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub value_usd: Option<f64>,
    #[serde(default)]
    pub vasp_metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub identity_verified: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ScreenResponse {
    pub tx_hash: String,
    pub decision: String,
    pub risk_score: i32,
    pub reasons: Vec<String>,
    #[serde(default)]
    pub counterparty_entity_type: Option<String>,
    #[serde(default)]
    pub exposure_hop_distance: Option<i32>,
    #[serde(default)]
    pub policy_version: Option<String>,
    #[serde(default)]
    pub integrity_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub tx_hash: String,
    pub sender: String,
    pub recipient: Option<String>,
    pub decision: String,
    pub risk_score: i32,
    pub reasons: Vec<String>,
    pub policy_version: String,
    pub counterparty_entity_type: Option<String>,
    pub exposure_hop_distance: Option<i32>,
    pub integrity_hash: Option<String>,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Invalid address: {0}")]
    InvalidAddress(String),
    #[error("Invalid transaction hash: {0}")]
    InvalidTxHash(String),
    #[error("Invalid policy configuration: {0}")]
    InvalidPolicy(String),
    #[error("Compliance provider error: {0}")]
    ProviderError(String),
    #[error("Storage error: {0}")]
    StorageError(String),
    #[error("Unauthorized: {0}")]
    Unauthorized(String),
    #[error("Rate limit exceeded: {0}")]
    RateLimitExceeded(String),
}

impl IntoResponse for EngineError {
    fn into_response(self) -> Response {
        let (status, err_code, err_msg) = match self {
            EngineError::InvalidAddress(msg) => (StatusCode::BAD_REQUEST, "INVALID_ADDRESS", msg),
            EngineError::InvalidTxHash(msg) => (StatusCode::BAD_REQUEST, "INVALID_TX_HASH", msg),
            EngineError::InvalidPolicy(msg) => (StatusCode::BAD_REQUEST, "INVALID_POLICY", msg),
            EngineError::ProviderError(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, "PROVIDER_ERROR", msg)
            }
            EngineError::StorageError(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, "STORAGE_ERROR", msg)
            }
            EngineError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg),
            EngineError::RateLimitExceeded(msg) => {
                (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMIT_EXCEEDED", msg)
            }
        };

        let body = Json(serde_json::json!({
            "error": err_msg,
            "code": err_code,
        }));

        (status, body).into_response()
    }
}

pub fn validate_eth_address(address: &str) -> Result<String, EngineError> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err(EngineError::InvalidAddress(
            "Address cannot be empty".to_string(),
        ));
    }
    if !trimmed.starts_with("0x") && !trimmed.starts_with("0X") {
        return Err(EngineError::InvalidAddress(format!(
            "Address '{}' must start with '0x'",
            trimmed
        )));
    }
    if trimmed.len() != 42 {
        return Err(EngineError::InvalidAddress(format!(
            "Address '{}' has invalid length {} (expected 42 characters)",
            trimmed,
            trimmed.len()
        )));
    }
    if !trimmed[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(EngineError::InvalidAddress(format!(
            "Address '{}' contains non-hexadecimal characters",
            trimmed
        )));
    }
    Ok(trimmed.to_lowercase())
}

#[async_trait]
pub trait ComplianceDataProvider: Send + Sync {
    async fn is_sanctioned(&self, address: &str) -> Result<bool, EngineError>;
    async fn has_indirect_exposure(&self, address: &str) -> Result<bool, EngineError>;
    async fn record_decision(&self, record: &DecisionRecord) -> Result<(), EngineError>;

    async fn classify_entity(&self, _address: &str) -> Result<EntityType, EngineError> {
        Ok(EntityType::UnknownEOA)
    }

    async fn check_exposure_multihop(
        &self,
        address: &str,
        _max_hops: i32,
    ) -> Result<Option<i32>, EngineError> {
        if self.has_indirect_exposure(address).await? {
            Ok(Some(1))
        } else {
            Ok(None)
        }
    }

    async fn get_active_policy(
        &self,
        _policy_id_override: Option<&str>,
    ) -> Result<CompliancePolicy, EngineError> {
        Ok(CompliancePolicy::default())
    }

    async fn refresh_sanctions(&self) -> Result<usize, EngineError> {
        Ok(0)
    }
}

/// Evaluates compliance for a transaction request against the provided data backend.
pub async fn evaluate_transaction<P: ComplianceDataProvider + ?Sized>(
    provider: &P,
    req: &ScreenRequest,
) -> Result<ScreenResponse, EngineError> {
    if req.tx_hash.trim().is_empty() {
        return Err(EngineError::InvalidTxHash(
            "tx_hash cannot be empty".to_string(),
        ));
    }

    let sender_lower = validate_eth_address(&req.sender)?;

    let is_contract_creation = match &req.recipient {
        None => true,
        Some(r) => r.trim().is_empty(),
    };

    let policy = provider.get_active_policy(req.policy.as_deref()).await?;

    let mut reasons = Vec::new();
    let mut decision = "ALLOW".to_string();
    let mut risk_score = 0;
    let mut counterparty_entity_type: Option<EntityType> = None;
    let mut exposure_hop_distance: Option<i32> = None;

    let validated_recipient = if is_contract_creation {
        let sender_direct_hit = provider.is_sanctioned(&sender_lower).await?;
        if sender_direct_hit {
            reasons.push("SANCTIONED_SENDER".to_string());
            decision = "BLOCK".to_string();
            risk_score = 98;
        } else {
            let hop_res = provider
                .check_exposure_multihop(&sender_lower, policy.parameters.max_hop_distance)
                .await?;
            if let Some(hop) = hop_res {
                exposure_hop_distance = Some(hop);
                if hop == 1 {
                    reasons.push("INDIRECT_SENDER_EXPOSURE".to_string());
                    risk_score = 55;
                } else {
                    reasons.push("INDIRECT_SENDER_EXPOSURE_2HOP".to_string());
                    risk_score = 25;
                }
            }
        }
        None
    } else {
        let recipient_raw = req.recipient.as_ref().unwrap();
        let recipient_lower = validate_eth_address(recipient_raw)?;

        let (sender_hit_res, recipient_hit_res) = tokio::join!(
            provider.is_sanctioned(&sender_lower),
            provider.is_sanctioned(&recipient_lower)
        );
        let sender_direct_hit = sender_hit_res?;
        let recipient_direct_hit = recipient_hit_res?;

        if sender_direct_hit {
            reasons.push("SANCTIONED_SENDER".to_string());
            decision = "BLOCK".to_string();
            risk_score = 98;
        }
        if recipient_direct_hit {
            reasons.push("SANCTIONED_RECIPIENT".to_string());
            decision = "BLOCK".to_string();
            risk_score = 98;
        }

        // Entity classification for recipient
        let entity_type = provider.classify_entity(&recipient_lower).await?;
        counterparty_entity_type = Some(entity_type.clone());

        // Mixer flag handling
        if entity_type == EntityType::Mixer && policy.parameters.flag_mixers {
            reasons.push("INTERACTION_WITH_MIXER".to_string());
            if risk_score < 45 {
                risk_score = 45;
            }
        }

        // VASP counterparty attribution check & Travel Rule
        if entity_type == EntityType::Exchange {
            reasons.push("VASP_COUNTERPARTY_IDENTIFIED".to_string());

            let travel_thresh = policy
                .parameters
                .travel_threshold
                .or(policy.parameters.require_vasp_attribution_above_usd)
                .unwrap_or(10000.0);

            // Compute USD value: direct value_usd or on-chain wei converted via $3,000/ETH reference oracle
            let val_usd = req
                .value_usd
                .unwrap_or_else(|| req.value.map(|v| (v as f64 / 1e18) * 3000.0).unwrap_or(0.0));
            if val_usd > travel_thresh && req.vasp_metadata.is_none() {
                reasons.push("FLAG:VASP_ATTRIBUTION_REQUIRED".to_string());
                if decision != "BLOCK" {
                    decision = "FLAG".to_string();
                    let min_flag_score = policy.parameters.flag_threshold.max(60);
                    if risk_score < min_flag_score {
                        risk_score = min_flag_score;
                    }
                }
            }
        }

        // Direct match wins. Only evaluate indirect exposure if direct check passed.
        if decision != "BLOCK" {
            let (sender_hop_res, recipient_hop_res) = tokio::join!(
                provider.check_exposure_multihop(&sender_lower, policy.parameters.max_hop_distance),
                provider
                    .check_exposure_multihop(&recipient_lower, policy.parameters.max_hop_distance)
            );
            let sender_hop = sender_hop_res?;
            let recipient_hop = recipient_hop_res?;

            let mut min_hop: Option<i32> = None;
            if let Some(h) = sender_hop {
                min_hop = Some(min_hop.map_or(h, |m: i32| m.min(h)));
                if h == 1 {
                    reasons.push("INDIRECT_SENDER_EXPOSURE".to_string());
                } else {
                    reasons.push("INDIRECT_SENDER_EXPOSURE_2HOP".to_string());
                }
            }
            if let Some(h) = recipient_hop {
                min_hop = Some(min_hop.map_or(h, |m: i32| m.min(h)));
                if h == 1 {
                    reasons.push("INDIRECT_RECIPIENT_EXPOSURE".to_string());
                } else {
                    reasons.push("INDIRECT_RECIPIENT_EXPOSURE_2HOP".to_string());
                }
            }

            if let Some(hop) = min_hop {
                exposure_hop_distance = Some(hop);
                let hop_risk = if hop == 1 { 55 } else { 25 };
                if hop_risk > risk_score {
                    risk_score = hop_risk;
                }
            }
        }

        Some(recipient_lower)
    };

    // Evaluate on-chain identity credential eligibility
    if let Some(true) = req.identity_verified {
        reasons.push("ONCHAIN_IDENTITY_VERIFIED".to_string());
    } else if let Some(false) = req.identity_verified {
        reasons.push("UNVERIFIED_SENDER_REVERT_RISK".to_string());
        if risk_score < policy.parameters.flag_threshold {
            risk_score = policy.parameters.flag_threshold;
        }
    }

    // Evaluate final decision based on policy thresholds unless direct sanctions blocked
    if decision != "BLOCK" {
        if risk_score >= policy.parameters.block_threshold {
            decision = "BLOCK".to_string();
        } else if risk_score >= policy.parameters.flag_threshold {
            decision = "FLAG".to_string();
        } else {
            decision = "ALLOW".to_string();
        }
    }

    let entity_type_str = counterparty_entity_type
        .as_ref()
        .map(|e| e.as_str().to_string());

    let recipient_for_audit =
        validated_recipient.unwrap_or_else(|| CONTRACT_CREATION_ADDRESS.to_string());

    let digest = compute_decision_digest(
        &req.tx_hash,
        &decision,
        risk_score,
        &policy.policy_id,
        &sender_lower,
        Some(&recipient_for_audit),
        entity_type_str.as_deref(),
        exposure_hop_distance,
    );

    let response = ScreenResponse {
        tx_hash: req.tx_hash.clone(),
        decision: decision.clone(),
        risk_score,
        reasons: reasons.clone(),
        counterparty_entity_type: entity_type_str.clone(),
        exposure_hop_distance,
        policy_version: Some(policy.policy_id.clone()),
        integrity_hash: Some(digest.clone()),
    };

    let record = DecisionRecord {
        tx_hash: req.tx_hash.clone(),
        sender: sender_lower,
        recipient: Some(recipient_for_audit),
        decision,
        risk_score,
        reasons,
        policy_version: policy.policy_id,
        counterparty_entity_type: entity_type_str,
        exposure_hop_distance,
        integrity_hash: Some(digest),
        bundle_id: req.bundle_id.clone(),
    };

    if let Err(e) = provider.record_decision(&record).await {
        log_warn!(
            tx_hash = %req.tx_hash,
            error = %e,
            "Could not persist audit record (continuing screening path)"
        );
    }

    Ok(response)
}

pub struct MockComplianceBackend {
    pub sanctioned: RwLock<HashSet<String>>,
    pub indirect: RwLock<HashSet<String>>,
    pub entities: RwLock<HashMap<String, EntityType>>,
    pub multihop: RwLock<HashMap<String, i32>>,
    pub policies: RwLock<HashMap<String, CompliancePolicy>>,
    pub active_policy_id: RwLock<String>,
    pub decisions: RwLock<Vec<DecisionRecord>>,
    pub fail_sanctions: AtomicBool,
    pub fail_indirect: AtomicBool,
    pub fail_record: AtomicBool,
}

impl MockComplianceBackend {
    pub fn new() -> Self {
        Self {
            sanctioned: RwLock::new(HashSet::new()),
            indirect: RwLock::new(HashSet::new()),
            entities: RwLock::new(HashMap::new()),
            multihop: RwLock::new(HashMap::new()),
            policies: RwLock::new(HashMap::new()),
            active_policy_id: RwLock::new("institution-standard-v1".to_string()),
            decisions: RwLock::new(Vec::new()),
            fail_sanctions: AtomicBool::new(false),
            fail_indirect: AtomicBool::new(false),
            fail_record: AtomicBool::new(false),
        }
    }

    pub fn with_sanctioned(self, addresses: Vec<&str>) -> Self {
        {
            let mut set = self.sanctioned.write().unwrap();
            for a in addresses {
                set.insert(a.to_lowercase());
            }
        }
        self
    }

    pub fn with_indirect(self, addresses: Vec<&str>) -> Self {
        {
            let mut set = self.indirect.write().unwrap();
            for a in addresses {
                set.insert(a.to_lowercase());
            }
        }
        self
    }

    pub fn with_entity(self, address: &str, entity_type: EntityType) -> Self {
        {
            let mut map = self.entities.write().unwrap();
            map.insert(address.to_lowercase(), entity_type);
        }
        self
    }

    pub fn with_multihop(self, address: &str, hop: i32) -> Self {
        {
            let mut map = self.multihop.write().unwrap();
            map.insert(address.to_lowercase(), hop);
        }
        self
    }

    pub fn with_policy(self, policy: CompliancePolicy) -> Self {
        {
            let mut map = self.policies.write().unwrap();
            map.insert(policy.policy_id.clone(), policy);
        }
        self
    }

    pub fn set_active_policy(&self, policy_id: &str) {
        let mut active = self.active_policy_id.write().unwrap();
        *active = policy_id.to_string();
    }
}

impl Default for MockComplianceBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ComplianceDataProvider for MockComplianceBackend {
    async fn is_sanctioned(&self, address: &str) -> Result<bool, EngineError> {
        if self.fail_sanctions.load(Ordering::Relaxed) {
            return Err(EngineError::ProviderError(
                "Mock sanctions lookup failure".into(),
            ));
        }
        let set = self.sanctioned.read().unwrap();
        Ok(set.contains(&address.to_lowercase()))
    }

    async fn has_indirect_exposure(&self, address: &str) -> Result<bool, EngineError> {
        if self.fail_indirect.load(Ordering::Relaxed) {
            return Err(EngineError::ProviderError("Mock graph walk failure".into()));
        }
        let set = self.indirect.read().unwrap();
        Ok(set.contains(&address.to_lowercase()))
    }

    async fn classify_entity(&self, address: &str) -> Result<EntityType, EngineError> {
        let map = self.entities.read().unwrap();
        Ok(map
            .get(&address.to_lowercase())
            .cloned()
            .unwrap_or(EntityType::UnknownEOA))
    }

    async fn check_exposure_multihop(
        &self,
        address: &str,
        max_hops: i32,
    ) -> Result<Option<i32>, EngineError> {
        if self.fail_indirect.load(Ordering::Relaxed) {
            return Err(EngineError::ProviderError("Mock graph walk failure".into()));
        }
        let map = self.multihop.read().unwrap();
        if let Some(&hop) = map.get(&address.to_lowercase()).filter(|&&h| h <= max_hops) {
            return Ok(Some(hop));
        }
        let set = self.indirect.read().unwrap();
        if set.contains(&address.to_lowercase()) && max_hops >= 1 {
            return Ok(Some(1));
        }
        Ok(None)
    }

    async fn get_active_policy(
        &self,
        policy_id_override: Option<&str>,
    ) -> Result<CompliancePolicy, EngineError> {
        let policies = self.policies.read().unwrap();
        let target_id = match policy_id_override {
            Some(id) => id.to_string(),
            None => self.active_policy_id.read().unwrap().clone(),
        };
        if let Some(p) = policies.get(&target_id) {
            p.parameters
                .validate()
                .map_err(EngineError::InvalidPolicy)?;
            Ok(p.clone())
        } else {
            let default_policy = CompliancePolicy::default();
            default_policy
                .parameters
                .validate()
                .map_err(EngineError::InvalidPolicy)?;
            Ok(default_policy)
        }
    }

    async fn record_decision(&self, record: &DecisionRecord) -> Result<(), EngineError> {
        if self.fail_record.load(Ordering::Relaxed) {
            return Err(EngineError::StorageError("Mock DB write failure".into()));
        }
        let mut list = self.decisions.write().unwrap();
        list.push(record.clone());
        Ok(())
    }

    async fn refresh_sanctions(&self) -> Result<usize, EngineError> {
        let count = self.sanctioned.read().unwrap().len();
        Ok(count)
    }
}

pub struct LiveComplianceBackend {
    pub db: PgPool,
    pub redis: redis::Client,
}

impl LiveComplianceBackend {
    pub fn new(db: PgPool, redis: redis::Client) -> Self {
        Self { db, redis }
    }

    pub async fn load_sanctions_into_redis(&self) -> eyre::Result<usize> {
        let mut conn = self.redis.get_multiplexed_async_connection().await?;

        let rows: Vec<(String,)> = sqlx::query_as("SELECT address FROM address_attributions")
            .fetch_all(&self.db)
            .await?;

        let addresses: Vec<String> = rows.into_iter().map(|(a,)| a.to_lowercase()).collect();
        let count = addresses.len();
        let env_key = get_sanctions_env_key();

        if count > 0 {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs();
            let staging_key = format!("sanctions:v{}_{}", ts, std::process::id());

            let _: () = conn.del(&staging_key).await.unwrap_or(());
            let _: () = conn.sadd(&staging_key, &addresses).await?;

            // Lua-atomic swap: staging -> env_key
            let lua_script = r#"
                redis.call('RENAME', KEYS[1], KEYS[2])
                return 1
            "#;
            let _: i32 = redis::Script::new(lua_script)
                .key(&staging_key)
                .key(&env_key)
                .invoke_async(&mut conn)
                .await?;

            // Maintain legacy SANCTIONS_SET_KEY
            let staging_legacy = format!("{}_staging_{}", SANCTIONS_SET_KEY, std::process::id());
            let _: () = conn.del(&staging_legacy).await.unwrap_or(());
            let _: () = conn.sadd(&staging_legacy, &addresses).await?;
            let _: () = conn.rename(&staging_legacy, SANCTIONS_SET_KEY).await?;
        }

        // Record update in sanctions_list_updates
        let _ = sqlx::query(
            "INSERT INTO sanctions_list_updates (source_name, address_count, status) VALUES ($1, $2, $3)"
        )
        .bind("0xB10C_OFAC_Mirror")
        .bind(count as i32)
        .bind("SUCCESS")
        .execute(&self.db)
        .await;

        Ok(count)
    }

    async fn retry_with_backoff<F, Fut, T, E>(
        retries: usize,
        initial_backoff: Duration,
        op_name: &str,
        f: F,
    ) -> Result<T, E>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        let mut backoff = initial_backoff;
        for attempt in 1..=retries {
            match f().await {
                Ok(val) => return Ok(val),
                Err(err) => {
                    log_warn!(
                        op = %op_name,
                        attempt,
                        retries,
                        error = %err,
                        "Operation failed, retrying after backoff"
                    );
                    if attempt == retries {
                        return Err(err);
                    }
                    tokio::time::sleep(backoff).await;
                    backoff *= 2;
                }
            }
        }
        unreachable!()
    }
}

#[async_trait]
impl ComplianceDataProvider for LiveComplianceBackend {
    async fn is_sanctioned(&self, address: &str) -> Result<bool, EngineError> {
        let address_lower = address.to_lowercase();
        let env_key = get_sanctions_env_key();
        let res =
            Self::retry_with_backoff(3, Duration::from_millis(50), "redis_sismember", || async {
                let mut conn = self
                    .redis
                    .get_multiplexed_async_connection()
                    .await
                    .map_err(|e| e.to_string())?;
                let in_env: bool = conn
                    .sismember(&env_key, &address_lower)
                    .await
                    .map_err(|e| e.to_string())?;
                if in_env {
                    return Ok(true);
                }
                conn.sismember(SANCTIONS_SET_KEY, &address_lower)
                    .await
                    .map_err(|e| e.to_string())
            })
            .await;

        match res {
            Ok(is_member) => Ok(is_member),
            Err(e) => {
                log_error!(address = %address, error = %e, "Redis sanctions lookup failed after retries — failing closed");
                Err(EngineError::ProviderError(format!(
                    "Redis connection failed: {e}"
                )))
            }
        }
    }

    async fn has_indirect_exposure(&self, address: &str) -> Result<bool, EngineError> {
        let hop = self.check_exposure_multihop(address, 1).await?;
        Ok(hop.is_some())
    }

    async fn classify_entity(&self, address: &str) -> Result<EntityType, EngineError> {
        let address_lower = address.to_lowercase();
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT entity_type FROM entity_labels WHERE LOWER(address) = $1 LIMIT 1",
        )
        .bind(&address_lower)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| EngineError::StorageError(format!("DB query failed: {e}")))?;

        match row {
            Some((t,)) => Ok(EntityType::from_str_opt(&t)),
            None => Ok(EntityType::UnknownEOA),
        }
    }

    async fn check_exposure_multihop(
        &self,
        address: &str,
        max_hops: i32,
    ) -> Result<Option<i32>, EngineError> {
        if max_hops <= 0 {
            return Ok(None);
        }
        let address_lower = address.to_lowercase();
        let res = Self::retry_with_backoff::<_, _, Option<i32>, String>(
            3,
            Duration::from_millis(50),
            "sql_multihop_graph_walk",
            || async {
                let row: Option<(Option<i32>,)> = sqlx::query_as(
                    r#"
                    WITH RECURSIVE exposure_graph(counterparty, hop) AS (
                        SELECT 
                            CASE 
                                WHEN LOWER(cd.sender) = $1 THEN LOWER(cd.recipient)
                                WHEN LOWER(cd.recipient) = $1 THEN LOWER(cd.sender)
                            END AS counterparty,
                            1 AS hop
                        FROM compliance_decisions cd
                        WHERE (LOWER(cd.sender) = $1 OR LOWER(cd.recipient) = $1)
                        
                        UNION
                        
                        SELECT
                            CASE
                                WHEN LOWER(cd.sender) = eg.counterparty THEN LOWER(cd.recipient)
                                WHEN LOWER(cd.recipient) = eg.counterparty THEN LOWER(cd.sender)
                            END AS counterparty,
                            eg.hop + 1 AS hop
                        FROM compliance_decisions cd
                        JOIN exposure_graph eg ON (LOWER(cd.sender) = eg.counterparty OR LOWER(cd.recipient) = eg.counterparty)
                        WHERE eg.hop < $2
                    )
                    SELECT MIN(eg.hop)
                    FROM exposure_graph eg
                    JOIN address_attributions aa ON LOWER(aa.address) = eg.counterparty
                    "#,
                )
                .bind(&address_lower)
                .bind(max_hops)
                .fetch_optional(&self.db)
                .await
                .map_err(|e: sqlx::Error| e.to_string())?;

                Ok(row.and_then(|(min_hop,)| min_hop))
            },
        )
        .await;

        match res {
            Ok(hop_opt) => Ok(hop_opt),
            Err(e) => {
                log_error!(address = %address, error = %e, "SQL multihop graph walk failed after retries — failing closed");
                Err(EngineError::StorageError(format!("DB query failed: {e}")))
            }
        }
    }

    async fn get_active_policy(
        &self,
        policy_id_override: Option<&str>,
    ) -> Result<CompliancePolicy, EngineError> {
        let row: Option<(String, String, Option<String>, serde_json::Value)> = sqlx::query_as(
            r#"
            SELECT policy_id, name, description, rules
            FROM compliance_policies
            WHERE ($1::VARCHAR IS NOT NULL AND policy_id = $1)
               OR ($1::VARCHAR IS NULL AND is_active = TRUE)
            ORDER BY is_active DESC, updated_at DESC
            LIMIT 1
            "#,
        )
        .bind(policy_id_override)
        .fetch_optional(&self.db)
        .await
        .map_err(|e| EngineError::StorageError(format!("DB policy query failed: {e}")))?;

        if let Some((policy_id, name, description, rules_json)) = row {
            let parameters: PolicyParameters = serde_json::from_value(rules_json).map_err(|e| {
                EngineError::InvalidPolicy(format!("Failed to parse policy rules: {e}"))
            })?;
            parameters.validate().map_err(EngineError::InvalidPolicy)?;
            Ok(CompliancePolicy {
                policy_id,
                name,
                version: "1.0.0".to_string(),
                description,
                parameters,
            })
        } else {
            let default_policy = CompliancePolicy::default();
            default_policy
                .parameters
                .validate()
                .map_err(EngineError::InvalidPolicy)?;
            Ok(default_policy)
        }
    }

    async fn record_decision(&self, record: &DecisionRecord) -> Result<(), EngineError> {
        let res = Self::retry_with_backoff::<_, _, (), String>(
            3,
            Duration::from_millis(50),
            "sql_insert_decision",
            || async {
                sqlx::query(
                    "INSERT INTO compliance_decisions (bundle_id, tx_hash, sender, recipient, decision, risk_score, reason_codes, policy_version, counterparty_entity_type, exposure_hop_distance, integrity_hash)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT (tx_hash) DO NOTHING",
                )
                .bind(&record.bundle_id)
                .bind(&record.tx_hash)
                .bind(&record.sender)
                .bind(&record.recipient)
                .bind(&record.decision)
                .bind(record.risk_score)
                .bind(&record.reasons)
                .bind(&record.policy_version)
                .bind(&record.counterparty_entity_type)
                .bind(record.exposure_hop_distance)
                .bind(&record.integrity_hash)
                .execute(&self.db)
                .await
                .map_err(|e: sqlx::Error| e.to_string())?;

                if record.decision == "FLAG" {
                    let reasons_json = serde_json::to_value(&record.reasons)
                        .unwrap_or_else(|_| serde_json::json!([]));
                    let _ = sqlx::query(
                        "INSERT INTO edd_cases (case_ref, tx_hash, status, risk_score, reasons)
                         VALUES ($1, $2, 'OPEN', $3, $4)",
                    )
                    .bind(&record.tx_hash)
                    .bind(&record.tx_hash)
                    .bind(record.risk_score)
                    .bind(reasons_json)
                    .execute(&self.db)
                    .await;
                }

                Ok(())
            },
        )
        .await;

        match res {
            Ok(_) => Ok(()),
            Err(e) => {
                log_error!(tx_hash = %record.tx_hash, error = %e, "Failed to persist compliance decision audit record");
                Err(EngineError::StorageError(e))
            }
        }
    }

    async fn refresh_sanctions(&self) -> Result<usize, EngineError> {
        self.load_sanctions_into_redis()
            .await
            .map_err(|e| EngineError::ProviderError(format!("Failed to refresh sanctions: {e}")))
    }
}

// Atomic rate limiter tracking requests per 1-second window
static RATE_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RATE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const MAX_SCREEN_RPS: u64 = 2500;

pub async fn screen_handler(
    State(provider): State<Arc<dyn ComplianceDataProvider>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ScreenRequest>,
) -> Result<Json<ScreenResponse>, EngineError> {
    // 1. API Key Auth Check
    let expected_key =
        std::env::var("ENGINE_API_KEY").unwrap_or_else(|_| "dev-engine-secret-2026".to_string());
    if !expected_key.is_empty() {
        let header_key = headers
            .get("x-engine-api-key")
            .and_then(|v| v.to_str().ok());
        let auth_header = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));

        let key_matches = match header_key.or(auth_header) {
            Some(k) => k == expected_key,
            None => false,
        };

        if !key_matches {
            return Err(EngineError::Unauthorized(
                "Valid x-engine-api-key header required".to_string(),
            ));
        }
    }

    // 2. High-performance atomic rate limiting
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let current_window = RATE_WINDOW.load(std::sync::atomic::Ordering::Relaxed);
    if current_window != now_sec {
        RATE_WINDOW.store(now_sec, std::sync::atomic::Ordering::Relaxed);
        RATE_COUNT.store(1, std::sync::atomic::Ordering::Relaxed);
    } else {
        let count = RATE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if count > MAX_SCREEN_RPS {
            return Err(EngineError::RateLimitExceeded(
                "Engine screening request threshold exceeded".to_string(),
            ));
        }
    }
    log_info!(
        tx_hash = %req.tx_hash,
        sender = %req.sender,
        recipient = ?req.recipient,
        bundle_id = ?req.bundle_id,
        "Received screening request"
    );

    let resp = evaluate_transaction(provider.as_ref(), &req).await?;

    log_info!(
        tx_hash = %resp.tx_hash,
        decision = %resp.decision,
        risk_score = resp.risk_score,
        reasons = ?resp.reasons,
        "Screening evaluation completed"
    );

    Ok(Json(resp))
}

pub async fn admin_refresh_handler(
    headers: axum::http::HeaderMap,
    State(provider): State<Arc<dyn ComplianceDataProvider>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let expected_token =
        std::env::var("ADMIN_SECRET_KEY").unwrap_or_else(|_| "admin-dev-secret-key".to_string());

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let authorized = match auth_header {
        Some(header) => {
            let token = header.strip_prefix("Bearer ").unwrap_or(header).trim();
            token == expected_token
        }
        None => false,
    };

    if !authorized {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Unauthorized: invalid or missing Bearer token",
                "code": "UNAUTHORIZED"
            })),
        ));
    }

    match provider.refresh_sanctions().await {
        Ok(count) => Ok(Json(serde_json::json!({
            "status": "success",
            "message": "Sanctions list atomically refreshed",
            "records_count": count
        }))),
        Err(err) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": err.to_string(),
                "code": "REFRESH_ERROR"
            })),
        )),
    }
}

pub async fn health_handler(
    State(provider): State<Arc<dyn ComplianceDataProvider>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let pg_ok = provider.get_active_policy(None).await.is_ok();
    let redis_ok = provider
        .is_sanctioned("0x0000000000000000000000000000000000000000")
        .await
        .is_ok();

    if pg_ok && redis_ok {
        Ok(Json(serde_json::json!({
            "status": "ok",
            "service": "compliance-engine",
            "postgres": "healthy",
            "redis": "healthy"
        })))
    } else {
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "degraded",
                "service": "compliance-engine",
                "postgres": if pg_ok { "healthy" } else { "unhealthy" },
                "redis": if redis_ok { "healthy" } else { "unhealthy" }
            })),
        ))
    }
}

pub fn create_app(provider: Arc<dyn ComplianceDataProvider>) -> Router {
    Router::new()
        .route("/screen", post(screen_handler))
        .route("/health", get(health_handler))
        .route("/admin/refresh", post(admin_refresh_handler))
        .with_state(provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_policy_validation() {
        let valid = PolicyParameters {
            flag_threshold: 40,
            block_threshold: 70,
            max_hop_distance: 2,
            flag_mixers: true,
            flag_unregistered_vasp: false,
            strict_mode: true,
            require_vasp_attribution_above_usd: Some(10000.0),
            travel_threshold: Some(10000.0),
        };
        assert!(valid.validate().is_ok());

        let invalid_order = PolicyParameters {
            flag_threshold: 80,
            block_threshold: 70,
            ..valid.clone()
        };
        assert!(invalid_order.validate().is_err());

        let negative_flag = PolicyParameters {
            flag_threshold: -5,
            ..valid.clone()
        };
        assert!(negative_flag.validate().is_err());

        let negative_hop = PolicyParameters {
            max_hop_distance: -1,
            ..valid
        };
        assert!(negative_hop.validate().is_err());
    }

    #[test]
    fn test_compute_decision_digest_deterministic() {
        let d1 = compute_decision_digest(
            "0xabcdef",
            "BLOCK",
            100,
            "v1",
            "0x1111111111111111111111111111111111111111",
            Some("0x2222222222222222222222222222222222222222"),
            Some("Mixer"),
            Some(1),
        );
        let d2 = compute_decision_digest(
            "0xabcdef",
            "BLOCK",
            100,
            "v1",
            "0x1111111111111111111111111111111111111111",
            Some("0x2222222222222222222222222222222222222222"),
            Some("Mixer"),
            Some(1),
        );
        assert_eq!(d1, d2);
        assert_eq!(d1.len(), 64);

        let d_none = compute_decision_digest(
            "0xabcdef",
            "BLOCK",
            100,
            "v1",
            "0x1111111111111111111111111111111111111111",
            None,
            None,
            None,
        );
        assert_ne!(d1, d_none);
    }

    #[test]
    fn test_screen_request_deserialization() {
        let json_with_bundle = r#"{
            "tx_hash": "0x123",
            "sender": "0x1111111111111111111111111111111111111111",
            "bundle_id": "bundle-001"
        }"#;
        let req: ScreenRequest = serde_json::from_str(json_with_bundle).unwrap();
        assert_eq!(req.bundle_id, Some("bundle-001".to_string()));
        assert_eq!(req.recipient, None);

        let json_without_bundle = r#"{
            "tx_hash": "0x123",
            "sender": "0x1111111111111111111111111111111111111111",
            "value_usd": 15000.5
        }"#;
        let req2: ScreenRequest = serde_json::from_str(json_without_bundle).unwrap();
        assert_eq!(req2.bundle_id, None);
        assert_eq!(req2.value_usd, Some(15000.5));
    }

    #[test]
    fn test_compute_merkle_root() {
        let empty_root = compute_merkle_root(&[]);
        assert_eq!(empty_root.len(), 64);

        let h1 = compute_decision_digest(
            "0x1",
            "ALLOW",
            0,
            "v1",
            "0x1111111111111111111111111111111111111111",
            None,
            None,
            None,
        );
        let h2 = compute_decision_digest(
            "0x2",
            "FLAG",
            60,
            "v1",
            "0x2222222222222222222222222222222222222222",
            None,
            None,
            None,
        );
        let root1 = compute_merkle_root(&[h1.clone(), h2.clone()]);
        let root2 = compute_merkle_root(&[h1, h2]);
        assert_eq!(root1, root2);
        assert_eq!(root1.len(), 64);
    }

    #[tokio::test]
    async fn test_max_hops_zero() {
        let mock = MockComplianceBackend::new();
        let addr = "0x2222222222222222222222222222222222222222";
        mock.multihop.write().unwrap().insert(addr.to_string(), 1);

        let mut policy = CompliancePolicy::default();
        policy.policy_id = "test-zero-hop".to_string();
        policy.parameters.max_hop_distance = 0;
        mock.policies
            .write()
            .unwrap()
            .insert("test-zero-hop".to_string(), policy);
        mock.set_active_policy("test-zero-hop");

        let req = ScreenRequest {
            tx_hash: "0xabc001".to_string(),
            sender: "0x1111111111111111111111111111111111111111".to_string(),
            recipient: Some(addr.to_string()),
            value: Some(100),
            policy: Some("test-zero-hop".to_string()),
            bundle_id: None,
            value_usd: None,
            vasp_metadata: None,
            identity_verified: None,
        };

        let res = evaluate_transaction(&mock, &req).await.unwrap();
        assert_eq!(res.decision, "ALLOW");
        assert_eq!(res.exposure_hop_distance, None);
        assert!(
            !res.reasons
                .iter()
                .any(|r| r.contains("INDIRECT_RECIPIENT_EXPOSURE"))
        );
    }

    #[tokio::test]
    async fn test_duplicate_tx_hash_append_only() {
        let mock = MockComplianceBackend::new();
        let record = DecisionRecord {
            tx_hash: "0xduplicate_hash_test".to_string(),
            sender: "0x1111111111111111111111111111111111111111".to_string(),
            recipient: Some("0x2222222222222222222222222222222222222222".to_string()),
            decision: "ALLOW".to_string(),
            risk_score: 0,
            reasons: vec![],
            counterparty_entity_type: None,
            exposure_hop_distance: None,
            policy_version: "v1".to_string(),
            integrity_hash: Some("hash1".to_string()),
            bundle_id: None,
        };

        assert!(mock.record_decision(&record).await.is_ok());
        assert!(mock.record_decision(&record).await.is_ok());

        let decisions = mock.decisions.read().unwrap();
        assert_eq!(decisions.len(), 2);
        assert_eq!(decisions[0].tx_hash, "0xduplicate_hash_test");
        assert_eq!(decisions[1].tx_hash, "0xduplicate_hash_test");
    }
}
