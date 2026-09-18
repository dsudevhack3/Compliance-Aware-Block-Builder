import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    slot_screening_throughput: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 60, // 10 VUs * 60 iterations = 600 screens per test run
      maxDuration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% failure rate
    http_req_duration: ['p(95)<15', 'p(99)<25'], // Sub-15ms p95, sub-25ms p99 SLA
  },
};

const ENGINE_URL = __ENV.ENGINE_URL || 'http://127.0.0.1:3001/screen';
const ENGINE_API_KEY = __ENV.ENGINE_API_KEY || 'dev-engine-secret-2026';

const CLEAN_ACCOUNTS = [
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x976ea74026e72cd178867bf30701878cf1102400',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
];

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const sender = CLEAN_ACCOUNTS[iterId % CLEAN_ACCOUNTS.length];
  const recipient = CLEAN_ACCOUNTS[(iterId + 1) % CLEAN_ACCOUNTS.length];

  const payload = JSON.stringify({
    tx_hash: `0xk6_${vuId}_${iterId}_${Date.now()}`,
    sender: sender,
    recipient: recipient,
    value: 1000000000,
    policy: 'institution-standard-v1',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-engine-api-key': ENGINE_API_KEY,
    },
  };

  const res = http.post(ENGINE_URL, payload, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'decision is present': (r) => {
      try {
        const json = r.json();
        return json && json.decision !== undefined;
      } catch (e) {
        return false;
      }
    },
  });
}
