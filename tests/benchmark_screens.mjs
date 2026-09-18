// Node.js fallback benchmark to verify 600 screens/slot latency SLAs
const ENGINE_URL = process.env.ENGINE_URL || 'http://127.0.0.1:3001/screen';
const ENGINE_API_KEY = process.env.ENGINE_API_KEY || 'dev-engine-secret-2026';

const CLEAN_ACCOUNTS = [
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x976ea74026e72cd178867bf30701878cf1102400',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
];

async function runBenchmark() {
  console.log('=== Benchmarking 600 Screens/Slot Against Engine ===');
  console.log(`Target: ${ENGINE_URL}`);

  const totalRequests = 600;
  const concurrency = 10;
  const durations = [];
  let completed = 0;
  let failed = 0;

  const startTime = Date.now();

  async function worker(workerId) {
    const iters = totalRequests / concurrency;
    for (let i = 0; i < iters; i++) {
      const sender = CLEAN_ACCOUNTS[i % CLEAN_ACCOUNTS.length];
      const recipient = CLEAN_ACCOUNTS[(i + 1) % CLEAN_ACCOUNTS.length];
      const txHash = `0xbench_${workerId}_${i}_${Date.now()}`;

      const t0 = performance.now();
      try {
        const res = await fetch(ENGINE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-engine-api-key': ENGINE_API_KEY,
          },
          body: JSON.stringify({
            tx_hash: txHash,
            sender,
            recipient,
            value: 1000000000,
            policy: 'institution-standard-v1',
          }),
        });

        const elapsed = performance.now() - t0;
        durations.push(elapsed);

        if (res.ok) {
          completed++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, idx) => worker(idx));
  await Promise.all(workers);

  const totalTime = Date.now() - startTime;
  durations.sort((a, b) => a - b);

  const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] || 0;
  const rps = (completed / (totalTime / 1000)).toFixed(1);

  console.log('\n--- Latency Benchmark Results ---');
  console.log(`Total Requests: ${totalRequests}`);
  console.log(`Successful:     ${completed}`);
  console.log(`Failed:         ${failed}`);
  console.log(`Throughput:     ${rps} req/sec`);
  console.log(`p50 Latency:    ${p50.toFixed(2)} ms`);
  console.log(`p95 Latency:    ${p95.toFixed(2)} ms (Threshold: <15ms)`);
  console.log(`p99 Latency:    ${p99.toFixed(2)} ms (Threshold: <25ms)`);

  if (p95 <= 15 && p99 <= 25) {
    console.log('✓ SLA VALIDATION PASSED');
  } else {
    console.log('⚠ SLA exceeded under current local conditions');
  }
}

runBenchmark();
