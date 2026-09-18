use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TxItem {
    hash: String,
    sender: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BidPayload {
    slot: u64,
    block_hash: String,
    builder_id: String,
    builder_pubkey: String,
    fee_recipient: String,
    value_wei: String,
    txs: Vec<TxItem>,
}

#[derive(Debug, Deserialize)]
struct StoredBidResponse {
    builder_id: String,
    verdict: String,
    value_wei: String,
    reasons: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HeaderResponse {
    slot: u64,
    block_hash: String,
    builder_id: String,
    value_wei: String,
}

#[tokio::main]
async fn main() -> eyre::Result<()> {
    dotenvy::dotenv().ok();

    let args: Vec<String> = std::env::args().collect();
    let mut slot: u64 = 12;
    let mut relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "http://127.0.0.1:3003".to_string());

    let mut i = 1;
    while i < args.len() {
        if args[i] == "--slot" && i + 1 < args.len() {
            slot = args[i + 1].parse().unwrap_or(12);
            i += 1;
        } else if args[i] == "--relay-url" && i + 1 < args.len() {
            relay_url = args[i + 1].clone();
            i += 1;
        }
        i += 1;
    }

    println!("============================================================");
    println!("  MOCK BUILDERS SIMULATION — TARGETING RELAY");
    println!("  Target Relay: {}", relay_url);
    println!("  Target Slot:  {}", slot);
    println!("============================================================");

    let client = Client::builder().timeout(Duration::from_secs(10)).build()?;

    // Profile B1: Clean builder with 20 clean transactions, 2.0 ETH
    let b1_sender = format!("0x{:08x}b100{:028x}", slot, 1);
    let b1_recipient = format!("0x{:08x}b100{:028x}", slot, 2);
    let b1_fee_recipient = format!("0x{:08x}b100{:028x}", slot, 0xfee);
    let mut b1_txs = Vec::new();
    for idx in 1..=20 {
        b1_txs.push(TxItem {
            hash: format!("0x{:016x}b1{:046x}", slot, idx),
            sender: b1_sender.clone(),
            recipient: Some(b1_recipient.clone()),
            value: Some(100 * idx),
            bundle_id: None,
        });
    }
    let b1 = BidPayload {
        slot,
        block_hash: format!(
            "0x{:016x}b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            slot
        ),
        builder_id: "builder-b1-clean".to_string(),
        builder_pubkey: "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
            .to_string(),
        fee_recipient: b1_fee_recipient,
        value_wei: "2000000000000000000".to_string(), // 2.0 ETH
        txs: b1_txs,
    };

    // Profile B2: Builder with 1 directly sanctioned transaction, 2.5 ETH
    let b2_recipient = format!("0x{:08x}b200{:028x}", slot, 2);
    let b2_fee_recipient = format!("0x{:08x}b200{:028x}", slot, 0xfee);
    let b2 = BidPayload {
        slot,
        block_hash: format!(
            "0x{:016x}b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
            slot
        ),
        builder_id: "builder-b2-sanctioned-tx".to_string(),
        builder_pubkey: "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
            .to_string(),
        fee_recipient: b2_fee_recipient,
        value_wei: "2500000000000000000".to_string(), // 2.5 ETH
        txs: vec![TxItem {
            hash: format!("0x{:016x}b2{:046x}", slot, 1),
            sender: "0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b".to_string(), // OFAC Sanctioned address
            recipient: Some(b2_recipient),
            value: Some(500),
            bundle_id: None,
        }],
    };

    // Profile B3: Builder interacting with Tornado Cash Mixer + Sanctioned fee recipient, 1.8 ETH
    let b3_sender = format!("0x{:08x}b300{:028x}", slot, 1);
    let b3 = BidPayload {
        slot,
        block_hash: format!(
            "0x{:016x}b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3",
            slot
        ),
        builder_id: "builder-b3-mixer-bad-fee".to_string(),
        builder_pubkey: "0xb3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3"
            .to_string(),
        fee_recipient: "0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b".to_string(), // Sanctioned fee recipient
        value_wei: "1800000000000000000".to_string(),                            // 1.8 ETH
        txs: vec![TxItem {
            hash: format!("0x{:016x}b3{:046x}", slot, 1),
            sender: b3_sender,
            recipient: Some("0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc".to_string()), // Tornado Cash Mixer
            value: Some(1000),
            bundle_id: None,
        }],
    };

    let profiles = vec![
        ("B1 (Clean Builder, 2.0 ETH, 20 txs)", b1),
        ("B2 (Sanctioned Tx, 2.5 ETH, 1 tx)", b2),
        ("B3 (Mixer + Sanctioned Fee Recipient, 1.8 ETH)", b3),
    ];

    for (name, payload) in profiles {
        println!("\n[+] Submitting profile: {}", name);
        let resp = client
            .post(format!("{}/relay/submit_bid", relay_url))
            .json(&payload)
            .send()
            .await?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp.json().await?;
            println!("    Status:   {}", body["status"]);
            println!("    Bid ID:   {}", body["bid_id"]);
            println!("    Message:  {}", body["message"]);
        } else {
            let err_text = resp.text().await?;
            eprintln!("    Submission failed: {}", err_text);
        }
    }

    println!("\n[*] Waiting 1.0s for relay audit execution...");
    sleep(Duration::from_millis(1000)).await;

    // Fetch and display all bids for this slot
    println!("\n[+] Querying all bids for slot {}:", slot);
    let bids_resp = client
        .get(format!("{}/relay/bids?slot={}", relay_url, slot))
        .send()
        .await?;

    if bids_resp.status().is_success() {
        let bids: Vec<StoredBidResponse> = bids_resp.json().await?;
        for bid in bids {
            let eth_val = bid.value_wei.parse::<f64>().unwrap_or(0.0) / 1e18;
            println!(
                "    - Builder: {:<28} | Verdict: {:<16} | Value: {:>4.1} ETH | Reasons: {:?}",
                bid.builder_id, bid.verdict, eth_val, bid.reasons
            );
        }
    }

    // Query winning best header
    println!("\n[+] Querying best header (fail-closed winner selection):");
    let header_resp = client
        .get(format!("{}/relay/best_header?slot={}", relay_url, slot))
        .send()
        .await?;

    if header_resp.status().is_success() {
        let header: HeaderResponse = header_resp.json().await?;
        let eth_val = header.value_wei.parse::<f64>().unwrap_or(0.0) / 1e18;
        println!("    WINNER SELECTED: {}", header.builder_id);
        println!("    Block Hash:      {}", header.block_hash);
        println!("    Compliant Value: {:.1} ETH", eth_val);
        println!("    Slot:            {}", header.slot);
        assert_eq!(
            header.builder_id, "builder-b1-clean",
            "B1 must win because B2 and B3 are non-compliant!"
        );
        println!("\n>> SUCCESS: Clean builder B1 won despite B2 having higher bid value!");
    } else {
        let err_text = header_resp.text().await?;
        eprintln!("    Best header error: {}", err_text);
    }

    Ok(())
}
