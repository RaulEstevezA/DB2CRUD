//! Starts the API on PORT (8080 by default) with the settings of the environment.

use catalog_api::build;
use catalog_api::common::settings::Settings;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let port = std::env::var("PORT").ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(8080);
    let app = build(Settings::from_env()).await.expect("the API could not start");
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("the port is free");
    tracing::info!("Listening on http://localhost:{port}");
    axum::serve(listener, app).await.expect("the server stopped");
}
