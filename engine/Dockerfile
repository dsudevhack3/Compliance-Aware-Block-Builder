FROM rust:1.85-slim-bookworm AS builder
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY engine ./engine
WORKDIR /usr/src/app/engine
RUN cargo build --release --bin compliance_engine

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /usr/src/app/engine/target/release/compliance_engine /app/compliance_engine

ENV HOST=0.0.0.0
ENV PORT=10000
EXPOSE 10000
CMD ["/app/compliance_engine"]
