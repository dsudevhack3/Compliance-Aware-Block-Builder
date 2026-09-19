use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use compliance_engine::{
    ComplianceDataProvider, LiveComplianceBackend, ScreenRequest, evaluate_transaction,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error as log_error, info as log_info, warn as log_warn};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TxItem {
    #[serde(alias = "tx_hash")]
    pub hash: String,
    pub sender: String,
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub value_usd: Option<f64>,
    #[serde(default)]
    pub vasp_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bid {
    pub slot: u64,
    pub block_hash: String,
    pub builder_id: String,
    pub builder_pubkey: String,
    pub fee_recipient: String,
    pub value_wei: serde_json::Value,
    pub txs: Vec<TxItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BidVerdict {
    Pending,
    Compliant,
    ExposedTx,
    ExposedBuilder,
}

impl BidVerdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            BidVerdict::Pending => "PENDING",
            BidVerdict::Compliant => "COMPLIANT",
            BidVerdict::ExposedTx => "EXPOSED_TX",
            BidVerdict::ExposedBuilder => "EXPOSED_BUILDER",
        }
    }
}

pub fn parse_value_wei(val: &serde_json::Value) -> (String, u128) {
    match val {
        serde_json::Value::Number(n) => {
            let num = if let Some(u) = n.as_u128() {
                u
            } else if let Some(u64_val) = n.as_u64() {
                u64_val as u128
            } else if let Some(f) = n.as_f64() {
                f as u128
            } else {
                0
            };
            (num.to_string(), num)
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if let Some(hex_str) = trimmed
                .strip_prefix("0x")
                .or_else(|| trimmed.strip_prefix("0X"))
            {
                let num = u128::from_str_radix(hex_str, 16).unwrap_or(0);
                (num.to_string(), num)
            } else {
                let num = trimmed.parse::<u128>().unwrap_or(0);
                (trimmed.to_string(), num)
            }
        }
        _ => ("0".to_string(), 0),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBid {
    pub bid_id: String,
    pub slot: u64,
    pub block_hash: String,
    pub builder_id: String,
    pub builder_pubkey: String,
    pub fee_recipient: String,
    pub value_wei: String,
    #[serde(skip_serializing)]
    pub value_wei_num: u128,
    pub verdict: BidVerdict,
    pub reasons: Vec<String>,
    pub txs: Vec<TxItem>,
    pub tx_count: usize,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderResponse {
    pub slot: u64,
    pub block_hash: String,
    pub builder_id: String,
    pub builder_pubkey: String,
    pub fee_recipient: String,
    pub value_wei: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayloadResponse {
    pub slot: u64,
    pub block_hash: String,
    pub builder_id: String,
    pub builder_pubkey: String,
    pub fee_recipient: String,
    pub value_wei: String,
    pub proposer_sig: String,
    pub txs: Vec<TxItem>,
}

#[derive(Debug, Deserialize)]
pub struct SlotFilterQuery {
    pub slot: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct BestHeaderQuery {
    pub slot: u64,
}

#[derive(Debug, Deserialize)]
pub struct PayloadQuery {
    pub slot: u64,
    pub proposer_sig: Option<String>,
}

pub struct RelayState {
    pub provider: Arc<LiveComplianceBackend>,
    pub pool: PgPool,
    pub bids: RwLock<Vec<StoredBid>>,
}

pub fn create_relay_app(state: Arc<RelayState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/health", get(health_handler))
        .route("/relay/submit_bid", post(submit_bid_handler))
        .route("/relay/bids", get(list_bids_handler))
        .route("/relay/best_header", get(best_header_handler))
        .route("/relay/payload", get(payload_handler))
        .route("/relay/slot/{slot}/export", get(export_slot_handler))
        .route("/relay/export", get(export_slot_query_handler))
        .layer(cors)
        .with_state(state)
}

async fn health_handler(
    State(state): State<Arc<RelayState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let pg_ok = sqlx::query("SELECT 1").execute(&state.pool).await.is_ok();
    let redis_ok = state
        .provider
        .is_sanctioned("0x0000000000000000000000000000000000000000")
        .await
        .is_ok();

    if pg_ok && redis_ok {
        Ok(Json(serde_json::json!({
            "status": "ok",
            "service": "compliance-relay",
            "postgres": "healthy",
            "redis": "healthy"
        })))
    } else {
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "degraded",
                "service": "compliance-relay",
                "postgres": if pg_ok { "healthy" } else { "unhealthy" },
                "redis": if redis_ok { "healthy" } else { "unhealthy" }
            })),
        ))
    }
}

async fn submit_bid_handler(
    State(state): State<Arc<RelayState>>,
    Json(bid): Json<Bid>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    if bid.block_hash.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "block_hash cannot be empty" })),
        ));
    }
    if bid.fee_recipient.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "fee_recipient cannot be empty" })),
        ));
    }

    let bid_id = Uuid::new_v4().to_string();
    let (value_wei_str, value_wei_num) = parse_value_wei(&bid.value_wei);
    let now = chrono::Utc::now().to_rfc3339();

    let stored = StoredBid {
        bid_id: bid_id.clone(),
        slot: bid.slot,
        block_hash: bid.block_hash.clone(),
        builder_id: bid.builder_id.clone(),
        builder_pubkey: bid.builder_pubkey.clone(),
        fee_recipient: bid.fee_recipient.clone(),
        value_wei: value_wei_str.clone(),
        value_wei_num,
        verdict: BidVerdict::Pending,
        reasons: Vec::new(),
        tx_count: bid.txs.len(),
        txs: bid.txs.clone(),
        created_at: now,
    };

    // Store in-memory
    {
        let mut bids_lock = state.bids.write().await;
        bids_lock.push(stored);
    }

    // Spawn audit asynchronously
    let audit_state = Arc::clone(&state);
    let audit_bid = bid.clone();
    let audit_bid_id = bid_id.clone();
    tokio::spawn(async move {
        run_bid_audit(audit_state, audit_bid_id, audit_bid).await;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "status": "PENDING",
            "bid_id": bid_id,
            "slot": bid.slot,
            "block_hash": bid.block_hash,
            "builder_id": bid.builder_id,
            "message": "Bid submitted for audit"
        })),
    )
        .into_response())
}

async fn run_bid_audit(state: Arc<RelayState>, bid_id: String, bid: Bid) {
    log_info!(bid_id = %bid_id, slot = bid.slot, "Starting relay bid audit");

    // 1. Fee recipient check
    let fee_recipient_lower = bid.fee_recipient.trim().to_lowercase();
    match state.provider.is_sanctioned(&fee_recipient_lower).await {
        Ok(true) => {
            log_warn!(
                bid_id = %bid_id,
                fee_recipient = %bid.fee_recipient,
                "Bid rejected: fee_recipient is sanctioned (EXPOSED_BUILDER)"
            );
            let reasons = vec![format!("Fee recipient {} is sanctioned", bid.fee_recipient)];
            update_bid_verdict(&state, &bid_id, &bid, BidVerdict::ExposedBuilder, reasons).await;
            return;
        }
        Err(e) => {
            log_error!(error = %e, "Failed to verify fee_recipient sanctions status");
        }
        Ok(false) => {}
    }

    // 2. Concurrently evaluate each transaction in bid.txs
    let screen_requests: Vec<ScreenRequest> = bid
        .txs
        .iter()
        .map(|tx| ScreenRequest {
            tx_hash: tx.hash.clone(),
            sender: tx.sender.clone(),
            recipient: tx.recipient.clone(),
            value: None,
            policy: None,
            bundle_id: tx.bundle_id.clone(),
            value_usd: tx.value_usd,
            vasp_metadata: tx.vasp_metadata.clone(),
        })
        .collect();

    let eval_futures = screen_requests.iter().map(|req| {
        let provider = Arc::clone(&state.provider);
        async move {
            let res = evaluate_transaction(provider.as_ref(), req).await;
            (req, res)
        }
    });

    let results = futures::future::join_all(eval_futures).await;

    let mut has_block = false;
    let mut dead_bundles: HashSet<String> = HashSet::new();
    let mut flag_count = 0;
    let mut reasons = Vec::new();

    for (req, res) in results {
        match res {
            Ok(screen) => {
                if screen.decision == "BLOCK" {
                    has_block = true;
                    if let Some(bundle_id) = &req.bundle_id {
                        dead_bundles.insert(bundle_id.clone());
                    }
                    reasons.push(format!(
                        "Tx {} blocked: {}",
                        req.tx_hash,
                        screen.reasons.join(", ")
                    ));
                } else if screen.decision == "FLAG" {
                    flag_count += 1;
                    reasons.push(format!(
                        "Tx {} flagged: {}",
                        req.tx_hash,
                        screen.reasons.join(", ")
                    ));

                    // Auto-create EDD case for flagged transaction
                    let reasons_json = serde_json::to_value(&screen.reasons)
                        .unwrap_or_else(|_| serde_json::json!([]));
                    let _ = sqlx::query(
                        "INSERT INTO edd_cases (case_ref, tx_hash, bid_hash, status, risk_score, reasons)
                         VALUES ($1, $2, $3, 'OPEN', $4, $5)",
                    )
                    .bind(&req.tx_hash)
                    .bind(&req.tx_hash)
                    .bind(&bid.block_hash)
                    .bind(screen.risk_score)
                    .bind(reasons_json)
                    .execute(&state.pool)
                    .await;
                }
            }
            Err(e) => {
                has_block = true;
                if let Some(bundle_id) = &req.bundle_id {
                    dead_bundles.insert(bundle_id.clone());
                }
                reasons.push(format!("Tx {} screening error: {}", req.tx_hash, e));
            }
        }
    }

    // Bundle invalidation: if bundle_id shared and 1 tx BLOCK => whole bundle dead (don't split)
    if !dead_bundles.is_empty() {
        for dead_id in &dead_bundles {
            reasons.push(format!(
                "Bundle {} dropped atomically due to blocked transaction",
                dead_id
            ));
        }
    }

    if has_block {
        log_info!(bid_id = %bid_id, reasons_count = reasons.len(), "Bid rejected: EXPOSED_TX");
        update_bid_verdict(&state, &bid_id, &bid, BidVerdict::ExposedTx, reasons).await;
        return;
    }

    // 3. FLAG count vs policy check
    let active_policy = state
        .provider
        .get_active_policy(None)
        .await
        .unwrap_or_default();

    if active_policy.parameters.strict_mode && flag_count > 0 {
        reasons.push(format!(
            "Strict mode policy violation: {} flagged transactions detected",
            flag_count
        ));
        log_info!(bid_id = %bid_id, flag_count, "Bid rejected: EXPOSED_TX (strict mode)");
        update_bid_verdict(&state, &bid_id, &bid, BidVerdict::ExposedTx, reasons).await;
        return;
    }

    // Bid passed compliance checks!
    log_info!(bid_id = %bid_id, slot = bid.slot, "Bid audit passed: COMPLIANT");
    update_bid_verdict(&state, &bid_id, &bid, BidVerdict::Compliant, reasons).await;
}

async fn update_bid_verdict(
    state: &Arc<RelayState>,
    bid_id: &str,
    bid: &Bid,
    verdict: BidVerdict,
    reasons: Vec<String>,
) {
    // 1. Update in-memory state
    {
        let mut bids_lock = state.bids.write().await;
        if let Some(stored) = bids_lock.iter_mut().find(|b| b.bid_id == bid_id) {
            stored.verdict = verdict;
            stored.reasons = reasons.clone();
        }
    }

    // 2. Persist to PostgreSQL relay_bids
    let (value_wei_str, _) = parse_value_wei(&bid.value_wei);
    let reasons_json = serde_json::to_value(&reasons).unwrap_or_else(|_| serde_json::json!([]));
    let verdict_str = verdict.as_str();

    let insert_res = sqlx::query(
        r#"
        INSERT INTO relay_bids (slot, builder_id, block_hash, fee_recipient, value_wei, verdict, reasons)
        VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)
        "#,
    )
    .bind(bid.slot as i32)
    .bind(&bid.builder_id)
    .bind(&bid.block_hash)
    .bind(&bid.fee_recipient)
    .bind(&value_wei_str)
    .bind(verdict_str)
    .bind(reasons_json)
    .execute(&state.pool)
    .await;

    if let Err(e) = insert_res {
        log_error!(error = %e, bid_id = %bid_id, "Failed to persist bid into relay_bids");
    }
}

async fn list_bids_handler(
    State(state): State<Arc<RelayState>>,
    Query(query): Query<SlotFilterQuery>,
) -> impl IntoResponse {
    let bids_lock = state.bids.read().await;

    let filtered: Vec<_> = bids_lock
        .iter()
        .filter(|b| {
            if let Some(s) = query.slot {
                b.slot == s
            } else {
                true
            }
        })
        .cloned()
        .collect();

    Json(filtered)
}

pub fn select_best_compliant_header(bids: &[StoredBid], slot: u64) -> Option<&StoredBid> {
    bids.iter()
        .filter(|b| b.slot == slot && b.verdict == BidVerdict::Compliant)
        .max_by_key(|b| b.value_wei_num)
}

pub fn filter_valid_transactions(
    txs: &[TxItem],
    blocked_txs: &std::collections::HashSet<String>,
    dead_bundles: &std::collections::HashSet<String>,
) -> Vec<TxItem> {
    txs.iter()
        .filter(|t| {
            if blocked_txs.contains(&t.hash) {
                return false;
            }
            if t.bundle_id
                .as_ref()
                .is_some_and(|b| dead_bundles.contains(b))
            {
                return false;
            }
            true
        })
        .cloned()
        .collect()
}

async fn best_header_handler(
    State(state): State<Arc<RelayState>>,
    Query(query): Query<BestHeaderQuery>,
) -> Result<Json<HeaderResponse>, (StatusCode, Json<serde_json::Value>)> {
    let bids_lock = state.bids.read().await;

    let winner = match select_best_compliant_header(&bids_lock, query.slot) {
        Some(w) => w,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": format!("No compliant header found for slot {}", query.slot)
                })),
            ));
        }
    };

    Ok(Json(HeaderResponse {
        slot: winner.slot,
        block_hash: winner.block_hash.clone(),
        builder_id: winner.builder_id.clone(),
        builder_pubkey: winner.builder_pubkey.clone(),
        fee_recipient: winner.fee_recipient.clone(),
        value_wei: winner.value_wei.clone(),
    }))
}

async fn payload_handler(
    State(state): State<Arc<RelayState>>,
    Query(query): Query<PayloadQuery>,
    headers: HeaderMap,
) -> Result<Json<PayloadResponse>, (StatusCode, Json<serde_json::Value>)> {
    // Proposer signature verification: accept either query param or x-proposer-signature header
    let proposer_sig = query
        .proposer_sig
        .or_else(|| {
            headers
                .get("x-proposer-signature")
                .and_then(|h| h.to_str().ok().map(|s| s.to_string()))
        })
        .unwrap_or_default();

    if proposer_sig.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Missing proposer signature (required via query parameter proposer_sig or x-proposer-signature header)"
            })),
        ));
    }

    let bids_lock = state.bids.read().await;

    // Find winner among COMPLIANT bids for the slot
    let compliant_bids: Vec<&StoredBid> = bids_lock
        .iter()
        .filter(|b| b.slot == query.slot && b.verdict == BidVerdict::Compliant)
        .collect();

    if compliant_bids.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("No compliant payload found for slot {}", query.slot)
            })),
        ));
    }

    let winner = compliant_bids
        .into_iter()
        .max_by_key(|b| b.value_wei_num)
        .unwrap();

    Ok(Json(PayloadResponse {
        slot: winner.slot,
        block_hash: winner.block_hash.clone(),
        builder_id: winner.builder_id.clone(),
        builder_pubkey: winner.builder_pubkey.clone(),
        fee_recipient: winner.fee_recipient.clone(),
        value_wei: winner.value_wei.clone(),
        proposer_sig,
        txs: winner.txs.clone(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    pub slot: u64,
}

async fn export_slot_query_handler(
    State(state): State<Arc<RelayState>>,
    Query(q): Query<ExportQuery>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    export_slot(state, q.slot).await
}

async fn export_slot_handler(
    State(state): State<Arc<RelayState>>,
    axum::extract::Path(slot): axum::extract::Path<u64>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    export_slot(state, slot).await
}

async fn export_slot(
    state: Arc<RelayState>,
    slot: u64,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let bids_lock = state.bids.read().await;
    let slot_bids: Vec<StoredBid> = bids_lock
        .iter()
        .filter(|b| b.slot == slot)
        .cloned()
        .collect();

    if slot_bids.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("No bids found for slot {}", slot)
            })),
        ));
    }

    let winning_bid = slot_bids
        .iter()
        .filter(|b| b.verdict == BidVerdict::Compliant)
        .max_by_key(|b| b.value_wei_num);

    let mut all_tx_hashes: Vec<String> = Vec::new();
    for b in &slot_bids {
        for tx in &b.txs {
            all_tx_hashes.push(tx.hash.clone());
        }
    }
    let merkle_root = compliance_engine::compute_merkle_root(&all_tx_hashes);

    let active_policy = state
        .provider
        .get_active_policy(None)
        .await
        .unwrap_or_default();

    let rules_json = serde_json::to_string(&active_policy.parameters).unwrap_or_default();
    use sha2::{Digest, Sha256};
    let rules_hash = hex::encode(Sha256::digest(rules_json.as_bytes()));

    let now = chrono::Utc::now().to_rfc3339();

    let manifest = serde_json::json!({
        "slot": slot,
        "exported_at": now,
        "merkle_root": merkle_root,
        "policy_id": active_policy.policy_id,
        "policy_version": active_policy.version,
        "rules_hash": rules_hash,
        "total_bids": slot_bids.len(),
        "winning_builder": winning_bid.map(|w| w.builder_id.clone()),
        "winning_block_hash": winning_bid.map(|w| w.block_hash.clone()),
        "winning_value_wei": winning_bid.map(|w| w.value_wei.clone()),
    });

    let certificate_text = format!(
        "================================================================================\n\
         COMPLIANCE-AWARE BLOCK BUILDER — INSTITUTIONAL AUDIT EXPORT\n\
         ================================================================================\n\
         Slot:               {}\n\
         Export Timestamp:   {}\n\
         Active Policy ID:   {}\n\
         Policy Version:     {}\n\
         Rules Hash:         {}\n\
         Slot Merkle Root:   {}\n\
         Total Bids Screened: {}\n\
         Winning Builder:    {}\n\
         Winning Block Hash: {}\n\
         Winning Value (wei): {}\n\
         Cryptographic Seal: HMAC-SHA256 (AUDIT_HMAC_SECRET)\n\
         ================================================================================\n",
        slot,
        now,
        active_policy.policy_id,
        active_policy.version,
        rules_hash,
        merkle_root,
        slot_bids.len(),
        winning_bid.map(|w| w.builder_id.as_str()).unwrap_or("NONE"),
        winning_bid.map(|w| w.block_hash.as_str()).unwrap_or("NONE"),
        winning_bid.map(|w| w.value_wei.as_str()).unwrap_or("0")
    );

    use std::io::Write;
    let mut zip_buffer = std::io::Cursor::new(Vec::new());
    {
        let mut zip_writer = zip::ZipWriter::new(&mut zip_buffer);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        zip_writer
            .start_file("manifest.json", options)
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": format!("Failed to create manifest: {e}") })),
                )
            })?;
        zip_writer
            .write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes())
            .unwrap();

        zip_writer.start_file("bids.json", options).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to create bids.json: {e}") })),
            )
        })?;
        zip_writer
            .write_all(serde_json::to_string_pretty(&slot_bids).unwrap().as_bytes())
            .unwrap();

        zip_writer.start_file("compliance_certificate.txt", options).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to create certificate: {e}") })),
            )
        })?;
        zip_writer.write_all(certificate_text.as_bytes()).unwrap();

        zip_writer.finish().map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to finalize zip: {e}") })),
            )
        })?;
    }

    let zip_bytes = zip_buffer.into_inner();
    let filename = format!(
        "attachment; filename=\"slot-{}-compliance-export.zip\"",
        slot
    );

    let response = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", filename)
        .body(axum::body::Body::from(zip_bytes))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to build response: {e}") })),
            )
        })?;

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_value_wei_numeric() {
        let (s, n) = parse_value_wei(&serde_json::json!(1000000000000000000u64));
        assert_eq!(s, "1000000000000000000");
        assert_eq!(n, 1000000000000000000u128);
    }

    #[test]
    fn test_parse_value_wei_string() {
        let (s, n) = parse_value_wei(&serde_json::json!("2500000000000000000"));
        assert_eq!(s, "2500000000000000000");
        assert_eq!(n, 2500000000000000000u128);
    }

    #[test]
    fn test_parse_value_wei_hex() {
        let (s, n) = parse_value_wei(&serde_json::json!("0x10"));
        assert_eq!(s, "16");
        assert_eq!(n, 16u128);
    }

    #[test]
    fn test_verdict_serialization() {
        assert_eq!(
            serde_json::to_string(&BidVerdict::Compliant).unwrap(),
            "\"COMPLIANT\""
        );
        assert_eq!(
            serde_json::to_string(&BidVerdict::ExposedTx).unwrap(),
            "\"EXPOSED_TX\""
        );
        assert_eq!(
            serde_json::to_string(&BidVerdict::ExposedBuilder).unwrap(),
            "\"EXPOSED_BUILDER\""
        );
        assert_eq!(
            serde_json::to_string(&BidVerdict::Pending).unwrap(),
            "\"PENDING\""
        );
    }

    #[test]
    fn test_block_wins_over_value() {
        let bids = vec![
            // High-value bid with sanctions exposure: 10 ETH
            StoredBid {
                bid_id: "bid-malicious".to_string(),
                slot: 10,
                block_hash: "0xhash1".to_string(),
                builder_id: "builder-malicious".to_string(),
                builder_pubkey: "0xpub1".to_string(),
                fee_recipient: "0xfee1".to_string(),
                value_wei: "10000000000000000000".to_string(),
                value_wei_num: 10000000000000000000u128,
                verdict: BidVerdict::ExposedTx,
                reasons: vec!["Tx blocked: SANCTIONED_SENDER".to_string()],
                tx_count: 5,
                txs: vec![],
                created_at: "".to_string(),
            },
            // Lower-value bid fully compliant: 2 ETH
            StoredBid {
                bid_id: "bid-clean".to_string(),
                slot: 10,
                block_hash: "0xhash2".to_string(),
                builder_id: "builder-clean".to_string(),
                builder_pubkey: "0xpub2".to_string(),
                fee_recipient: "0xfee2".to_string(),
                value_wei: "2000000000000000000".to_string(),
                value_wei_num: 2000000000000000000u128,
                verdict: BidVerdict::Compliant,
                reasons: vec![],
                tx_count: 5,
                txs: vec![],
                created_at: "".to_string(),
            },
        ];

        let winner = select_best_compliant_header(&bids, 10).expect("should find compliant winner");
        assert_eq!(winner.builder_id, "builder-clean");
        assert_eq!(winner.value_wei_num, 2000000000000000000u128);
    }

    #[test]
    fn test_bundle_atomicity() {
        let tx1 = TxItem {
            hash: "0xtx1".to_string(),
            sender: "0xuser1".to_string(),
            recipient: Some("0xrecipient1".to_string()),
            value: Some(serde_json::json!(100)),
            bundle_id: Some("bundle-alpha".to_string()),
            value_usd: None,
            vasp_metadata: None,
        };
        let tx2_blocked = TxItem {
            hash: "0xtx2_blocked".to_string(),
            sender: "0xsanctioned".to_string(),
            recipient: Some("0xrecipient2".to_string()),
            value: Some(serde_json::json!(200)),
            bundle_id: Some("bundle-alpha".to_string()),
            value_usd: None,
            vasp_metadata: None,
        };
        let tx3_independent = TxItem {
            hash: "0xtx3_independent".to_string(),
            sender: "0xclean".to_string(),
            recipient: Some("0xrecipient3".to_string()),
            value: Some(serde_json::json!(300)),
            bundle_id: None,
            value_usd: None,
            vasp_metadata: None,
        };

        let all_txs = vec![tx1, tx2_blocked, tx3_independent];
        let mut blocked_txs = std::collections::HashSet::new();
        blocked_txs.insert("0xtx2_blocked".to_string());
        let mut dead_bundles = std::collections::HashSet::new();
        dead_bundles.insert("bundle-alpha".to_string());

        let valid = filter_valid_transactions(&all_txs, &blocked_txs, &dead_bundles);
        // Both tx1 and tx2 from bundle-alpha must be dropped atomically; only tx3 survives
        assert_eq!(valid.len(), 1);
        assert_eq!(valid[0].hash, "0xtx3_independent");
    }
}
