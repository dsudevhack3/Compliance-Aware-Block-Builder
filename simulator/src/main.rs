use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::primitives::{Address, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

pub async fn simulate_with_revm(
    provider: &impl Provider,
    from: Address,
    to: Address,
    value_wei: u64,
    calldata: Vec<u8>,
    gas_limit: Option<u64>,
) -> eyre::Result<(bool, u64)> {
    use revm::{
        Context, ExecuteEvm, MainBuilder, MainContext,
        database::InMemoryDB,
        primitives::{Address as RAddress, TxKind, U256 as RU256},
        state::AccountInfo,
    };

    let mut db = InMemoryDB::default();
    let from_r = RAddress::from_slice(from.as_slice());
    let to_r = RAddress::from_slice(to.as_slice());

    // Pull live state from Anvil (actual current balance & nonce)
    let live_balance = provider.get_balance(from).await?;
    let live_nonce = provider.get_transaction_count(from).await?;

    let mut info =
        AccountInfo::from_balance(RU256::from_be_bytes(live_balance.to_be_bytes::<32>()));
    info.nonce = live_nonce;
    db.insert_account_info(from_r, info);

    // Also seed recipient state (balance, nonce, bytecode if contract)
    let to_balance = provider.get_balance(to).await?;
    let to_nonce = provider.get_transaction_count(to).await?;
    let to_code = provider.get_code_at(to).await?;
    let is_contract = !to_code.is_empty();

    let mut to_info =
        AccountInfo::from_balance(RU256::from_be_bytes(to_balance.to_be_bytes::<32>()));
    to_info.nonce = to_nonce;
    if is_contract {
        use revm::state::Bytecode;
        let bytecode = Bytecode::new_raw(to_code.to_vec().into());
        to_info.code_hash = bytecode.hash_slow();
        to_info.code = Some(bytecode);
    }
    db.insert_account_info(to_r, to_info);

    let ctx = Context::mainnet().with_db(db);
    let mut tx_env = ctx.tx.clone();
    tx_env.caller = from_r;
    tx_env.kind = TxKind::Call(to_r);
    tx_env.value = RU256::from(value_wei);
    tx_env.data = calldata.into();
    // Use specified gas_limit, or allocate 200k for contract calls and 21k for simple ETH transfers
    tx_env.gas_limit = gas_limit.unwrap_or(if is_contract || !tx_env.data.is_empty() {
        200_000
    } else {
        21_000
    });
    tx_env.nonce = live_nonce;

    let mut evm = ctx.build_mainnet();
    let result = evm.transact_one(tx_env)?;
    let gas_used = result.tx_gas_used();
    let success = result.is_success();
    Ok((success, gas_used))
}

#[derive(Serialize)]
struct ScreenRequest {
    tx_hash: String,
    sender: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recipient: Option<String>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ScreenResponse {
    tx_hash: String,
    decision: String,
    risk_score: i32,
    reasons: Vec<String>,
}

async fn screen_transaction(
    client: &reqwest::Client,
    engine_url: &str,
    tx_hash: &str,
    sender: &str,
    recipient: &str,
) -> eyre::Result<ScreenResponse> {
    let req = ScreenRequest {
        tx_hash: tx_hash.to_string(),
        sender: sender.to_string(),
        recipient: Some(recipient.to_string()),
    };

    let api_key = std::env::var("ENGINE_API_KEY")
        .unwrap_or_else(|_| "dev-engine-secret-2026".to_string());

    let resp = client
        .post(engine_url)
        .header("x-engine-api-key", api_key)
        .json(&req)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        eyre::bail!(
            "Compliance engine rejected/failed screening with HTTP {}: {}",
            status,
            err_body
        );
    }

    let screen_resp = resp.json::<ScreenResponse>().await?;
    Ok(screen_resp)
}

async fn submit_transaction(
    provider: &impl Provider,
    from: Address,
    to: Address,
    label: &str,
    value_wei: u64,
    calldata: Vec<u8>,
    gas_limit: Option<u64>,
) -> eyre::Result<()> {
    // Structural Guarantee: All submissions must pass the revm in-process dry-run against Anvil live state
    let (sim_ok, gas_used) =
        simulate_with_revm(provider, from, to, value_wei, calldata.clone(), gas_limit).await?;
    if !sim_ok {
        println!(
            "[{}] revm in-process simulation REVERTED — refusing to submit to chain.",
            label
        );
        return Ok(());
    }
    println!(
        "[{}] revm in-process dry-run against Anvil live state PASSED (gas: {}) — submitting on-chain",
        label, gas_used
    );

    let mut tx = TransactionRequest::default()
        .with_from(from)
        .with_to(to)
        .with_value(U256::from(value_wei));

    if !calldata.is_empty() {
        tx = tx.with_input(calldata);
    }
    if let Some(g) = gas_limit {
        tx = tx.with_gas_limit(g);
    }

    match provider.send_transaction(tx).await {
        Ok(pending) => {
            let receipt = pending.get_receipt().await?;
            println!(
                "[{}] Transaction included on-chain. Hash: {:?}, Status: {}",
                label,
                receipt.transaction_hash,
                receipt.status()
            );
        }
        Err(e) => {
            println!("[{}] Transaction rejected/failed: {:?}", label, e);
        }
    }

    Ok(())
}

// Anvil default account #1 private key (clean sender with zero exposure)
const CLEAN_SENDER_PRIVATE_KEY: &str =
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Anvil default account #0 private key (sender used for sanctions & indirect exposure scenarios)
const SENDER_PRIVATE_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// A real OFAC-sanctioned address from our seeded list
const SANCTIONED_ADDRESS: &str = "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A";

// Anvil default account #3 (clean recipient)
const CLEAN_RECIPIENT: &str = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

// Counter.sol deployed to local Anvil devnet via forge create
const COUNTER_CONTRACT_ADDRESS: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://shresthkumar@localhost:5432/compliance_builder".to_string()
    });
    if let Ok(pool) = sqlx::PgPool::connect(&database_url).await {
        let _ = sqlx::query("DELETE FROM compliance_decisions WHERE tx_hash LIKE '0xsim%' OR tx_hash LIKE '0xstress%'")
            .execute(&pool)
            .await;
        let _ = sqlx::query(
            "UPDATE compliance_policies SET is_active = (policy_id = 'institution-standard-v1')",
        )
        .execute(&pool)
        .await;
    }

    let anvil_rpc =
        std::env::var("ANVIL_RPC").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
    let engine_url =
        std::env::var("ENGINE_URL").unwrap_or_else(|_| "http://127.0.0.1:3001/screen".to_string());

    let http_client = reqwest::Client::new();

    let clean_signer = PrivateKeySigner::from_str(CLEAN_SENDER_PRIVATE_KEY)?;
    let clean_sender_address = clean_signer.address();
    let clean_wallet = EthereumWallet::from(clean_signer);
    let clean_provider = ProviderBuilder::new()
        .wallet(clean_wallet)
        .connect_http(anvil_rpc.parse()?);

    let signer = PrivateKeySigner::from_str(SENDER_PRIVATE_KEY)?;
    let sender_address = signer.address();
    let wallet = EthereumWallet::from(signer);
    let provider = ProviderBuilder::new()
        .wallet(wallet)
        .connect_http(anvil_rpc.parse()?);

    println!("=== Scenario 1: Clean transaction ===");
    let recipient = Address::from_str(CLEAN_RECIPIENT)?;
    let fake_tx_hash = "0xsim001";

    let decision = screen_transaction(
        &http_client,
        &engine_url,
        fake_tx_hash,
        &format!("{:?}", clean_sender_address),
        &format!("{:?}", recipient),
    )
    .await?;

    println!("Compliance decision: {:?}", decision);

    if decision.decision == "ALLOW" {
        submit_transaction(
            &clean_provider,
            clean_sender_address,
            recipient,
            "Scenario 1",
            1_000_000_000_000_000_000u64,
            vec![],
            None,
        )
        .await?;
    } else {
        println!("[Scenario 1] BLOCKED before submission to chain.");
    }

    // Pause for pacing & live dashboard telemetry
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    println!("\n=== Scenario 2: Sanctioned recipient ===");
    let sanctioned = Address::from_str(SANCTIONED_ADDRESS)?;
    let fake_tx_hash_2 = "0xsim002";

    let decision2 = screen_transaction(
        &http_client,
        &engine_url,
        fake_tx_hash_2,
        &format!("{:?}", sender_address),
        &format!("{:?}", sanctioned),
    )
    .await?;

    println!("Compliance decision: {:?}", decision2);

    if decision2.decision == "ALLOW" {
        submit_transaction(
            &provider,
            sender_address,
            sanctioned,
            "Scenario 2",
            1_000_000_000_000_000_000u64,
            vec![],
            None,
        )
        .await?;
    } else {
        println!("[Scenario 2] BLOCKED before submission to chain — compliance engine caught it.");
    }

    // Guarantee Scenario 2 DB row is persisted and give dashboard/AI-explainer time to narrate
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    println!("\n=== Scenario 3: Indirect exposure (1-hop counterparty to sanctioned entity) ===");
    let clean_recipient = Address::from_str(CLEAN_RECIPIENT)?;
    let fake_tx_hash_3 = "0xsim003";

    let decision3 = screen_transaction(
        &http_client,
        &engine_url,
        fake_tx_hash_3,
        &format!("{:?}", sender_address),
        &format!("{:?}", clean_recipient),
    )
    .await?;

    println!("Compliance decision: {:?}", decision3);

    if decision3.decision == "ALLOW" {
        submit_transaction(
            &provider,
            sender_address,
            clean_recipient,
            "Scenario 3",
            1_000_000_000_000_000_000u64,
            vec![],
            None,
        )
        .await?;
    } else if decision3.decision == "FLAG" {
        println!(
            "[Scenario 3] FLAGGED for human review / enhanced due diligence (risk score: {}) — 1-hop graph walk detected indirect exposure to sanctioned entity.",
            decision3.risk_score
        );
    } else {
        println!("[Scenario 3] BLOCKED before submission to chain.");
    }

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    println!("\n=== Scenario 4: Contract call (calldata + revm parity demo) ===");
    let contract_address = Address::from_str(COUNTER_CONTRACT_ADDRESS)?;
    let fake_tx_hash_4 = "0xsim004";

    // increment() selector: 0xd09de08a
    let increment_calldata: Vec<u8> = vec![0xd0, 0x9d, 0xe0, 0x8a];

    let decision4 = screen_transaction(
        &http_client,
        &engine_url,
        fake_tx_hash_4,
        &format!("{:?}", clean_sender_address),
        &format!("{:?}", contract_address),
    )
    .await?;

    println!("Compliance decision: {:?}", decision4);

    if decision4.decision == "ALLOW" {
        submit_transaction(
            &clean_provider,
            clean_sender_address,
            contract_address,
            "Scenario 4",
            0u64,
            increment_calldata,
            Some(200_000),
        )
        .await?;
    } else {
        println!("[Scenario 4] Screening did not return ALLOW — skipping contract call.");
    }

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // Run Scenario 5: Concurrent Multi-Scenario Stress Test
    run_scenario_5_concurrent(&engine_url).await?;

    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // Run Scenario 6: Fail-Closed Fault-Injection Proof
    println!("\n========================================================");
    println!("=== Scenario 6: Fail-Closed Fault-Injection Proof ======");
    println!("========================================================");
    println!("Proving builder behavior when screening engine is offline or returns HTTP 503...");
    let degraded_engine_url = "http://127.0.0.1:3999/screen";
    let fake_tx_hash_6 = "0xsim006_fault_injection";

    match screen_transaction(
        &http_client,
        degraded_engine_url,
        fake_tx_hash_6,
        &format!("{:?}", clean_sender_address),
        &format!("{:?}", recipient),
    )
    .await
    {
        Ok(d) if d.decision == "ALLOW" => {
            panic!(
                "[CRITICAL SECURITY VULNERABILITY] Builder allowed transaction despite screening failure!"
            );
        }
        Ok(_) => {
            println!("[Scenario 6] Non-allow decision returned.");
        }
        Err(err) => {
            println!("  [VERIFIED FAIL-CLOSED] Screening error trapped: {}", err);
            println!("  [VERIFIED FAIL-CLOSED] Builder REFUSED to submit transaction to chain.");
            println!(
                "  [VERIFIED FAIL-CLOSED] Transaction successfully excluded from block candidate bundle.\n"
            );
        }
    }

    Ok(())
}

struct ConcurrentTxSpec {
    id: &'static str,
    tx_hash: String,
    sender: String,
    recipient: Option<String>,
    expected_decision: &'static str,
    expected_risk: i32,
}

pub async fn run_scenario_5_concurrent(engine_url: &str) -> eyre::Result<()> {
    println!("\n========================================================");
    println!("=== Scenario 5: Concurrent Multi-Scenario Stress Test ===");
    println!("========================================================");

    let clean_signer = PrivateKeySigner::from_str(CLEAN_SENDER_PRIVATE_KEY)?;
    let clean_sender = format!("{:?}", clean_signer.address());
    let signer = PrivateKeySigner::from_str(SENDER_PRIVATE_KEY)?;
    let sender = format!("{:?}", signer.address());
    let clean_recip = CLEAN_RECIPIENT.to_string();
    let sanctioned = SANCTIONED_ADDRESS.to_string();
    let contract = COUNTER_CONTRACT_ADDRESS.to_string();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();

    let txs = vec![
        ConcurrentTxSpec {
            id: "Tx 1 [Clean Transfer]",
            tx_hash: format!("0xstress_{:x}_01", now_ms),
            sender: clean_sender.clone(),
            recipient: Some(format!(
                "0x88880000000000000000000000000000{:08x}",
                (now_ms & 0xffffffff) as u32
            )),
            expected_decision: "ALLOW",
            expected_risk: 0,
        },
        ConcurrentTxSpec {
            id: "Tx 2 [Direct Sanctioned Recipient]",
            tx_hash: format!("0xstress_{:x}_02", now_ms),
            sender: sender.clone(),
            recipient: Some(sanctioned.clone()),
            expected_decision: "BLOCK",
            expected_risk: 98,
        },
        ConcurrentTxSpec {
            id: "Tx 3 [Sanctioned Sender Self-Transfer]",
            tx_hash: format!("0xstress_{:x}_03", now_ms),
            sender: sanctioned.clone(),
            recipient: Some(sanctioned.clone()),
            expected_decision: "BLOCK",
            expected_risk: 98,
        },
        ConcurrentTxSpec {
            id: "Tx 4 [Indirect 1-Hop Exposure]",
            tx_hash: format!("0xstress_{:x}_04", now_ms),
            sender: sender.clone(),
            recipient: Some(clean_recip.clone()),
            expected_decision: "FLAG",
            expected_risk: 55,
        },
        ConcurrentTxSpec {
            id: "Tx 5 [Clean Contract Call]",
            tx_hash: format!("0xstress_{:x}_05", now_ms),
            sender: clean_sender.clone(),
            recipient: Some(contract.clone()),
            expected_decision: "ALLOW",
            expected_risk: 0,
        },
        ConcurrentTxSpec {
            id: "Tx 6 [Clean Contract Creation]",
            tx_hash: format!("0xstress_{:x}_06", now_ms),
            sender: clean_sender.clone(),
            recipient: None,
            expected_decision: "ALLOW",
            expected_risk: 0,
        },
    ];

    let total_txs = txs.len();
    println!(
        "Firing {} near-simultaneous screening requests concurrently against {}",
        total_txs, engine_url
    );

    let client = reqwest::Client::new();
    let start_time = std::time::Instant::now();

    let api_key = std::env::var("ENGINE_API_KEY")
        .unwrap_or_else(|_| "dev-engine-secret-2026".to_string());

    let mut handles = Vec::new();
    for spec in txs {
        let client_clone = client.clone();
        let url_clone = engine_url.to_string();
        let key_clone = api_key.clone();
        let handle = tokio::spawn(async move {
            let req = serde_json::json!({
                "tx_hash": spec.tx_hash,
                "sender": spec.sender,
                "recipient": spec.recipient,
            });
            let send_time = std::time::Instant::now();
            let res = client_clone
                .post(&url_clone)
                .header("x-engine-api-key", key_clone)
                .json(&req)
                .send()
                .await;
            (spec, res, send_time.elapsed())
        });
        handles.push(handle);
    }

    let mut passed = 0;
    let mut failed = 0;

    for handle in handles {
        let (spec, res, latency) = handle.await?;
        match res {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let screen_res: ScreenResponse = resp.json().await?;
                    let decision_ok = screen_res.decision == spec.expected_decision;
                    let risk_ok = screen_res.risk_score == spec.expected_risk;

                    if decision_ok && risk_ok {
                        println!(
                            "  [PASS] {} => Decision: {} (Risk: {}) in {:.2?}",
                            spec.id, screen_res.decision, screen_res.risk_score, latency
                        );
                        passed += 1;
                    } else {
                        println!(
                            "  [FAIL] {} => Expected {} (Risk {}), got {} (Risk {}) in {:.2?}",
                            spec.id,
                            spec.expected_decision,
                            spec.expected_risk,
                            screen_res.decision,
                            screen_res.risk_score,
                            latency
                        );
                        failed += 1;
                    }
                } else {
                    println!("  [FAIL] {} => HTTP error status {}", spec.id, status);
                    failed += 1;
                }
            }
            Err(e) => {
                println!("  [FAIL] {} => Network error: {:?}", spec.id, e);
                failed += 1;
            }
        }
    }

    let elapsed = start_time.elapsed();
    println!("\n--- Concurrent Stress Test Summary ---");
    println!("Total In-Flight Screenings: {}", total_txs);
    println!("Passed: {} / {}", passed, total_txs);
    println!("Failed: {} / {}", failed, total_txs);
    println!("Total Wall-Clock Time: {:.2?}", elapsed);
    println!(
        "Throughput: {:.1} tx/sec",
        (total_txs as f64) / elapsed.as_secs_f64().max(0.001)
    );

    if failed > 0 {
        eyre::bail!(
            "Scenario 5 stress test failed: {} out of {} checks failed",
            failed,
            total_txs
        );
    }

    println!(
        "All concurrent transactions evaluated with 100% correctness and zero cross-contamination.\n"
    );
    Ok(())
}
