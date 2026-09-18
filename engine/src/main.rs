use compliance_engine::{LiveComplianceBackend, create_app};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,compliance_engine=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("failed to connect to Postgres");

    let redis_client = redis::Client::open(redis_url).expect("failed to create Redis client");

    let backend = Arc::new(LiveComplianceBackend::new(pool, redis_client));

    let loaded = backend
        .load_sanctions_into_redis()
        .await
        .expect("failed to warm Redis sanctions cache");
    info!(loaded_count = loaded, "Loaded sanctions hot-set into Redis");

    // Spawn scheduled hourly background task for sanctions synchronization
    let refresh_backend = Arc::clone(&backend);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        interval.tick().await; // Skip initial tick since we just loaded
        loop {
            interval.tick().await;
            info!("Running hourly scheduled sanctions refresh from mirror");
            match refresh_backend.load_sanctions_into_redis().await {
                Ok(count) => info!(records = count, "Scheduled hourly sanctions refresh completed"),
                Err(e) => tracing::error!(error = %e, "Scheduled hourly sanctions refresh failed"),
            }
        }
    });

    let app = create_app(backend);

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let bind_addr = format!("{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await.unwrap();
    info!(bind_addr = %bind_addr, "Compliance engine listening");
    axum::serve(listener, app).await.unwrap();

    Ok(())
}
