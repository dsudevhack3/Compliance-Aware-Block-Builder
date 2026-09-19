FROM rust:1.85-slim-bookworm AS builder
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY engine ./engine
COPY relay ./relay
WORKDIR /usr/src/app/relay
RUN cargo build --release --bin relay

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /usr/src/app/relay/target/release/relay /app/relay

ENV HOST=0.0.0.0
ENV PORT=10000
EXPOSE 10000
CMD ["/app/relay"]
