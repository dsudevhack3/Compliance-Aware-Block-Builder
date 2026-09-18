use alloy::providers::{Provider, ProviderBuilder};
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost:5432/compliance_builder".to_string());
    let anvil_rpc = std::env::var("ANVIL_RPC")
        .unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());

    let provider = ProviderBuilder::new().connect_http(anvil_rpc.parse()?);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    println!("Attribution worker started. Polling for new blocks...");

    let mut last_seen_block: u64 = 0;

    loop {
        let latest_block_number = provider.get_block_number().await?;

        if latest_block_number > last_seen_block {
            for block_num in (last_seen_block + 1)..=latest_block_number {
                if let Some(block) = provider.get_block_by_number(block_num.into()).await? {
                    let miner = format!("{:?}", block.header.beneficiary).to_lowercase();
                    let block_hash = format!("{:?}", block.header.hash);
                    let tx_count = block.transactions.len() as i32;

                    // Check if this address is a known sanctioned entity
                    let attribution: Option<(String, uuid::Uuid)> = sqlx::query_as(
                        "SELECT attribution_type, entity_id FROM address_attributions WHERE address = $1",
                    )
                    .bind(&miner)
                    .fetch_optional(&pool)
                    .await?;

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

                    sqlx::query(
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
                    .await?;
                }
            }
            last_seen_block = latest_block_number;
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
