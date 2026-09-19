use alloy::providers::{Provider, ProviderBuilder};
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost:5432/compliance_builder".to_string());
    let anvil_rpc =
        std::env::var("ANVIL_RPC").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());

    let provider = ProviderBuilder::new().connect_http(anvil_rpc.parse()?);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("Attribution worker started. Polling for new blocks...");

    let max_db_block: Option<i64> = sqlx::query_scalar("SELECT MAX(block_number) FROM blocks")
        .fetch_optional(&pool)
        .await?
        .flatten();

    let latest = provider.get_block_number().await.unwrap_or(0);
    let mut last_seen_block: u64 = match max_db_block {
        Some(b) if (b as u64) > latest.saturating_sub(50) => b as u64,
        _ => latest.saturating_sub(10),
    };

    println!(
        "Attribution worker started. Starting polling from block {} (latest on-chain: {})...",
        last_seen_block,
        provider.get_block_number().await.unwrap_or(0)
    );

    loop {
        match provider.get_block_number().await {
            Ok(latest_block_number) => {
                if latest_block_number > last_seen_block {
                    // Process in bounded batches of at most 20 blocks
                    let end_block = std::cmp::min(latest_block_number, last_seen_block + 20);
                    for block_num in (last_seen_block + 1)..=end_block {
                        match provider.get_block_by_number(block_num.into()).await {
                            Ok(Some(block)) => {
                                let miner = format!("{:?}", block.header.beneficiary).to_lowercase();
                                let block_hash = format!("{:?}", block.header.hash);
                                let tx_count = block.transactions.len() as i32;

                                // Check if this address is a known sanctioned entity
                                let attribution: Option<(String, uuid::Uuid)> = match sqlx::query_as(
                                    "SELECT attribution_type, entity_id FROM address_attributions WHERE address = $1",
                                )
                                .bind(&miner)
                                .fetch_optional(&pool)
                                .await {
                                    Ok(res) => res,
                                    Err(e) => {
                                        eprintln!("[Block {}] DB attribution query error: {}", block_num, e);
                                        None
                                    }
                                };

                                let (compliance_status, proposer_entity_id) = match &attribution {
                                    Some((_, entity_id)) => {
                                        println!(
                                            "[Block {}] ALERT: proposer {} is a SANCTIONED entity ({})",
                                            block_num, miner, entity_id
                                        );
                                        ("EXPOSED_EXTERNAL", Some(*entity_id))
                                    }
                                    None => {
                                        println!(
                                            "[Block {}] proposer {} — compliant, status COMPLIANT_BUILD",
                                            block_num, miner
                                        );
                                        ("COMPLIANT_BUILD", None)
                                    }
                                };

                                let _ = sqlx::query(
                                    "INSERT INTO blocks (block_hash, block_number, builder_address, proposer_entity_id, tx_count, compliance_status)
                                     VALUES ($1, $2, $3, $4, $5, $6)
                                     ON CONFLICT (block_hash) DO NOTHING",
                                )
                                .bind(&block_hash)
                                .bind(block_num as i64)
                                .bind(&miner)
                                .bind(proposer_entity_id)
                                .bind(tx_count)
                                .bind(compliance_status)
                                .execute(&pool)
                                .await;

                                last_seen_block = block_num;
                            }
                            Ok(None) => {
                                last_seen_block = block_num;
                            }
                            Err(e) => {
                                eprintln!("[Block {}] RPC block fetch error: {}, will retry...", block_num, e);
                                break;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("RPC error getting block number: {}, retrying...", e);
            }
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
