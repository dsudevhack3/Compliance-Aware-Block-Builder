use compliance_engine::LiveComplianceBackend;
use relay::{RelayState, create_relay_app};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,relay=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&database_url)
        .await
        .expect("Failed to connect to Postgres");

    let redis_client = redis::Client::open(redis_url).expect("Failed to create Redis client");

    let provider = Arc::new(LiveComplianceBackend::new(pool.clone(), redis_client));

    // Ensure sanctions hot-set in Redis is warm
    if let Ok(count) = provider.load_sanctions_into_redis().await {
        info!(records = count, "Sanctions hot-cache verified in Redis");
    }

    let state = Arc::new(RelayState {
        provider,
        pool,
        bids: RwLock::new(Vec::new()),
    });

    let app = create_relay_app(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3003".to_string());
    let bind_addr = format!("{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    info!(bind_addr = %bind_addr, "Compliance relay service listening");
    axum::serve(listener, app).await?;

    Ok(())
}
