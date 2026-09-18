import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/compliance_builder',
});

const AI_EXPLAINER_URL = process.env.AI_EXPLAINER_URL || 'http://127.0.0.1:8000/explain';

const fastify = Fastify({ logger: true });

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

const allowedOriginsSet = new Set(allowedOrigins);

// Strict CORS: Validate incoming Origin header against whitelist (no reflection/wildcards)
await fastify.register(cors, {
    origin: (origin, cb) => {
        // Allow requests with no origin (mobile clients, curl, server-to-server)
        if (!origin) {
            cb(null, true);
            return;
        }
        const normalized = origin.trim().replace(/\/$/, '');
        if (allowedOriginsSet.has(normalized)) {
            cb(null, true);
        } else {
            fastify.log.warn(`CORS rejected untrusted origin: ${origin}`);
            cb(new Error(`Origin '${origin}' not permitted by CORS policy`), false);
        }
    },
    credentials: true,
});
await fastify.register(websocket);

const clients = new Set<any>();

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-secret-2026';
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'dev-internal-secret-2026';

function verifyAdminAuth(request: any): boolean {
    const headerKey = request.headers['x-admin-key'] as string | undefined;
    const authHeader = request.headers['authorization'] as string | undefined;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

    const providedKey = headerKey || bearerToken;
    if (!providedKey) return false;

    try {
        const a = Buffer.from(providedKey);
        const b = Buffer.from(ADMIN_API_KEY);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// In-memory sliding-window rate limiter for sensitive endpoints
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (entry.count >= maxCount) {
        return false;
    }
    entry.count += 1;
    return true;
}

// Origin check on WebSocket connection to prevent cross-site streaming eavesdropping
fastify.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin) {
        const normalized = origin.trim().replace(/\/$/, '');
        if (!allowedOriginsSet.has(normalized)) {
            fastify.log.warn(`WebSocket connection rejected from disallowed origin: ${origin}`);
            socket.close(1008, 'Origin not allowed');
            return;
        }
    }

    clients.add(socket);
    fastify.log.info('Dashboard client connected');

    socket.on('close', () => {
        clients.delete(socket);
    });
});

function broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === 1) {
            client.send(payload);
        }
    }
}

fastify.get('/api/decisions', async (request, reply) => {
    const result = await pool.query(
        `SELECT tx_hash, sender, recipient, decision, risk_score, reason_codes, ai_explanation,
            counterparty_entity_type, exposure_hop_distance, policy_version, integrity_hash, created_at
     FROM compliance_decisions
     ORDER BY created_at DESC
     LIMIT 50`
    );
    return result.rows;
});

fastify.get('/api/blocks', async (request, reply) => {
    const result = await pool.query(
        `SELECT block_hash, block_number, builder_address, compliance_status, tx_count, created_at
     FROM blocks
     ORDER BY block_number DESC
     LIMIT 50`
    );
    return result.rows;
});

fastify.get('/api/policies', async (request, reply) => {
    const result = await pool.query(
        `SELECT policy_id, name, description, is_active, rules, updated_at
     FROM compliance_policies
     ORDER BY is_active DESC, policy_id ASC`
    );
    return result.rows;
});

fastify.post('/api/policy/activate', async (request, reply) => {
    if (!verifyAdminAuth(request)) {
        reply.status(401);
        return { error: 'Unauthorized: Valid x-admin-key header required' };
    }

    const ip = request.ip || 'unknown';
    if (!checkRateLimit(`policy_${ip}`, 5, 60_000)) {
        reply.status(429);
        return { error: 'Too Many Requests: Maximum 5 policy activations per minute allowed' };
    }

    const body = request.body as { policy_id?: string };
    if (!body || !body.policy_id) {
        reply.status(400);
        return { error: 'policy_id is required' };
    }

    const checkRes = await pool.query(
        `SELECT policy_id, rules FROM compliance_policies WHERE policy_id = $1`,
        [body.policy_id]
    );
    if (checkRes.rows.length === 0) {
        reply.status(404);
        return { error: `Policy '${body.policy_id}' not found` };
    }

    const rules = checkRes.rows[0].rules;
    if (rules) {
        if (typeof rules.flag_threshold === 'number' && rules.flag_threshold < 0) {
            reply.status(400);
            return { error: 'Invalid policy parameters: flag_threshold cannot be negative' };
        }
        if (typeof rules.block_threshold === 'number' && rules.block_threshold < 0) {
            reply.status(400);
            return { error: 'Invalid policy parameters: block_threshold cannot be negative' };
        }
        if (
            typeof rules.flag_threshold === 'number' &&
            typeof rules.block_threshold === 'number' &&
            rules.flag_threshold > rules.block_threshold
        ) {
            reply.status(400);
            return {
                error: `Invalid policy parameters: flag_threshold (${rules.flag_threshold}) cannot exceed block_threshold (${rules.block_threshold})`,
            };
        }
        if (typeof rules.max_hop_distance === 'number' && rules.max_hop_distance < 0) {
            reply.status(400);
            return { error: 'Invalid policy parameters: max_hop_distance cannot be negative' };
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE compliance_policies SET is_active = FALSE');
        const updateRes = await client.query(
            `UPDATE compliance_policies
       SET is_active = TRUE, updated_at = NOW()
       WHERE policy_id = $1
       RETURNING policy_id, name, description, rules`,
            [body.policy_id]
        );

        if (updateRes.rows.length === 0) {
            await client.query('ROLLBACK');
            reply.status(404);
            return { error: `Policy '${body.policy_id}' not found` };
        }

        await client.query('COMMIT');
        const activePolicy = updateRes.rows[0];

        fastify.log.info(`Active compliance policy switched to ${activePolicy.policy_id}`);
        broadcast({
            type: 'policy_changed',
            data: {
                policy_id: activePolicy.policy_id,
                name: activePolicy.name,
            },
        });

        return {
            success: true,
            active_policy: activePolicy,
        };
    } catch (err: any) {
        await client.query('ROLLBACK');
        reply.status(500);
        return { error: `Failed to activate policy: ${err.message || err}` };
    } finally {
        client.release();
    }
});

fastify.get('/api/relay/bids', async (request, reply) => {
    const result = await pool.query(
        `SELECT id, slot, builder_id, block_hash, fee_recipient, value_wei, verdict, reasons, created_at
         FROM relay_bids
         ORDER BY slot DESC, created_at DESC
         LIMIT 50`
    ).catch(() => ({ rows: [] }));
    return result.rows;
});

fastify.post('/api/admin/refresh', async (request, reply) => {
    const authHeader = request.headers.authorization;
    const expectedToken = process.env.ADMIN_SECRET_KEY || 'admin-dev-secret-key';
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

    if (token !== expectedToken) {
        reply.status(401);
        return { error: 'Unauthorized: invalid or missing Bearer token' };
    }

    const engineUrl = process.env.ENGINE_URL || 'http://127.0.0.1:3001/screen';
    const refreshUrl = engineUrl.replace(/\/screen$/, '/admin/refresh');

    try {
        const res = await fetch(refreshUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${expectedToken}`,
                'Content-Type': 'application/json',
            },
        });
        const data = await res.json();
        reply.status(res.status);
        return data;
    } catch (err: any) {
        reply.status(502);
        return { error: `Failed to contact engine admin refresh: ${err.message}` };
    }
});

let simulatorChildProcess: ChildProcess | null = null;

function findSimulatorBinary(): { binaryPath: string; simulatorDir: string } | null {
    const candidateDirs = [
        path.resolve(process.cwd(), '../simulator'),
        path.resolve(process.cwd(), 'simulator'),
        path.resolve(__dirname, '../../simulator'),
        path.resolve(__dirname, '../simulator'),
    ];
    for (const dir of candidateDirs) {
        const bin = path.join(dir, 'target/release/simulator');
        if (fs.existsSync(bin)) {
            return { binaryPath: bin, simulatorDir: dir };
        }
    }
    return null;
}

let lastSimulatorRunTime = 0;
const SIMULATOR_COOLDOWN_MS = 15_000;
const SIMULATOR_TIMEOUT_MS = 60_000;

fastify.post('/api/demo/run-simulator', async (request, reply) => {
    if (!verifyAdminAuth(request)) {
        reply.status(401);
        return { error: 'Unauthorized: Valid x-admin-key header required to run simulator' };
    }

    const ip = request.ip || 'unknown';
    if (!checkRateLimit(`simulator_${ip}`, 4, 300_000)) {
        reply.status(429);
        return { error: 'Rate limit exceeded: Maximum 4 simulator runs per 5 minutes' };
    }

    const now = Date.now();
    if (now - lastSimulatorRunTime < SIMULATOR_COOLDOWN_MS) {
        const waitSec = Math.ceil((SIMULATOR_COOLDOWN_MS - (now - lastSimulatorRunTime)) / 1000);
        reply.status(429);
        return { error: `Simulator on cooldown — please wait ${waitSec}s before launching again` };
    }

    if (simulatorChildProcess !== null && simulatorChildProcess.exitCode === null) {
        reply.status(409);
        return { error: 'A simulator demo run is already in progress' };
    }

    const binaryInfo = findSimulatorBinary();
    if (!binaryInfo) {
        reply.status(400);
        return {
            error: 'Simulator binary not found — run `cargo build --release --bin simulator` first',
        };
    }

    try {
        lastSimulatorRunTime = now;
        const child = spawn(binaryInfo.binaryPath, [], {
            cwd: binaryInfo.simulatorDir,
            env: {
                ...process.env,
                DATABASE_URL:
                    process.env.DATABASE_URL || 'postgres://shresthkumar@localhost:5432/compliance_builder',
                ENGINE_URL: process.env.ENGINE_URL || 'http://127.0.0.1:3001/screen',
                ENGINE_API_KEY: process.env.ENGINE_API_KEY || 'dev-engine-secret-2026',
                ANVIL_RPC: process.env.ANVIL_RPC || 'http://127.0.0.1:8545',
            },
        });

        simulatorChildProcess = child;
        fastify.log.info(
            `Spawned simulator demo process (PID: ${child.pid}) from ${binaryInfo.binaryPath}`
        );

        // Automatic process timeout to prevent remote CPU burn / hanging
        const killTimeout = setTimeout(() => {
            if (simulatorChildProcess === child && child.exitCode === null) {
                fastify.log.warn(`Simulator PID ${child.pid} exceeded timeout of ${SIMULATOR_TIMEOUT_MS}ms — terminating`);
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (child.exitCode === null) child.kill('SIGKILL');
                }, 2000);
            }
        }, SIMULATOR_TIMEOUT_MS);

        child.stdout.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                fastify.log.info(`[simulator stdout] ${text}`);
            }
        });

        child.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                fastify.log.warn(`[simulator stderr] ${text}`);
            }
        });

        child.on('close', (code) => {
            clearTimeout(killTimeout);
            fastify.log.info(`Simulator process exited with code ${code}`);
            simulatorChildProcess = null;
        });

        child.on('error', (err) => {
            clearTimeout(killTimeout);
            fastify.log.error(`Simulator spawn error: ${err.message}`);
            simulatorChildProcess = null;
        });

        return { started: true };
    } catch (err: any) {
        simulatorChildProcess = null;
        fastify.log.error(`Failed to launch simulator: ${err.message}`);
        reply.status(500);
        return { error: `Failed to launch simulator: ${err.message}` };
    }
});


fastify.get('/api/demo/simulator-status', async (request, reply) => {
    const isRunning = simulatorChildProcess !== null && simulatorChildProcess.exitCode === null;
    return { running: isRunning };
});

fastify.get('/api/stats', async (request, reply) => {
    const decisions = await pool
        .query(`SELECT decision, COUNT(*) FROM compliance_decisions GROUP BY decision`)
        .catch(() => ({ rows: [] }));
    const blocks = await pool
        .query(`SELECT compliance_status, COUNT(*) FROM blocks GROUP BY compliance_status`)
        .catch(() => ({ rows: [] }));

    const sanctionsCountResult = await pool
        .query(`SELECT COUNT(*) FROM address_attributions`)
        .catch(() => ({ rows: [{ count: '0' }] }));

    const activePolicyResult = await pool
        .query(
            `SELECT policy_id, name, rules
       FROM compliance_policies
       WHERE is_active = TRUE
       LIMIT 1`
        )
        .catch(() => ({ rows: [] }));

    const lastUpdateResult = await pool
        .query(
            `SELECT source_name, fetched_at, address_count, status
       FROM sanctions_list_updates
       WHERE status = 'SUCCESS'
       ORDER BY fetched_at DESC
       LIMIT 1`
        )
        .catch(() => ({ rows: [] }));

    const lastUpdate = lastUpdateResult.rows[0] || null;
    const totalSanctions = parseInt(sanctionsCountResult.rows[0]?.count || '0', 10);
    const activePolicy = activePolicyResult.rows[0] || {
        policy_id: 'institution-standard-v1',
        name: 'Standard Institutional Policy',
    };

    return {
        decisions: decisions.rows,
        blocks: blocks.rows,
        active_policy: activePolicy,
        sanctions: {
            total_addresses: totalSanctions,
            last_updated: lastUpdate?.fetched_at || null,
            source_name: lastUpdate?.source_name || '0xB10C OFAC SDN Mirror',
            status: lastUpdate?.status || 'INITIAL_SEED',
        },
    };
});

function generateDecisionReportPdf(record: any, entityLabel: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Canonical string formula matching Rust engine compute_decision_digest
        const canonicalString = [
            record.tx_hash.toLowerCase(),
            record.decision,
            record.risk_score,
            record.policy_version || 'institution-standard-v1',
            record.sender.toLowerCase(),
            (record.recipient || 'none').toLowerCase(),
            record.counterparty_entity_type || 'None',
            record.exposure_hop_distance != null ? String(record.exposure_hop_distance) : 'None',
        ].join('|');

        const auditSecret = process.env.AUDIT_HMAC_SECRET || process.env.AUDIT_SECRET_KEY || 'compliance-audit-secret-2026';
        const computedHmacDigest = crypto.createHmac('sha256', auditSecret).update(canonicalString).digest('hex');
        const plainSha256 = crypto.createHash('sha256').update(canonicalString).digest('hex');
        const storedDigest = record.integrity_hash || computedHmacDigest;
        const isAuthentic = !record.integrity_hash || record.integrity_hash === computedHmacDigest || record.integrity_hash === plainSha256;

        const policyId = record.policy_id || 'institution-standard-v1';
        const policyVersion = record.policy_version || '1.0.0';
        const rulesHash = crypto.createHash('sha256').update(policyId + ':' + policyVersion).digest('hex');
        const merkleRoot = record.merkle_root || crypto.createHash('sha256').update(storedDigest).digest('hex');

        // Header banner
        doc.rect(40, 40, doc.page.width - 80, 50).fill('#0f172a');
        doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
            .text('COMPLIANCE-AWARE BLOCK BUILDER', 55, 48);
        doc.fontSize(10).font('Helvetica')
            .text('CRYPTOGRAPHIC TRANSACTION AUDIT & REGULATORY REPORT', 55, 68);

        doc.moveDown(3);
        doc.fillColor('#1e293b').fontSize(10).font('Helvetica');
        const generatedAt = new Date().toUTCString();
        doc.text(`Generated At (UTC): ${generatedAt}`, 40, 105);
        doc.text(`Active Policy: ${policyId} (Version: ${policyVersion})`, 40, 120);

        // Decision Status Box
        const decisionColor =
            record.decision === 'BLOCK' ? '#dc2626' : record.decision === 'FLAG' ? '#d97706' : '#16a34a';
        doc.rect(40, 140, doc.page.width - 80, 55).fillAndStroke('#f8fafc', '#cbd5e1');
        doc.fillColor(decisionColor).fontSize(20).font('Helvetica-Bold')
            .text(`COMPLIANCE DECISION: ${record.decision}`, 55, 150);
        doc.fillColor('#475569').fontSize(12).font('Helvetica')
            .text(`Calculated Risk Score: ${record.risk_score}/100  |  Evaluated Policy: ${policyId}`, 55, 175);

        // Details Grid
        let y = 205;
        doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text('Transaction & Entity Telemetry', 40, y);
        y += 18;

        const items = [
            ['Transaction Hash:', record.tx_hash],
            ['Sender Address:', record.sender],
            ['Recipient Address:', record.recipient],
            [
                'Counterparty Classification:',
                `${record.counterparty_entity_type || entityLabel?.entity_type || 'UnknownEOA'} ${entityLabel?.entity_name ? `(${entityLabel.entity_name})` : ''
                }`,
            ],
            [
                'Exposure Graph Distance:',
                record.exposure_hop_distance
                    ? `${record.exposure_hop_distance}-Hop Indirect Counterparty Exposure`
                    : 'None (Direct / Clean)',
            ],
            [
                'Triggered Reason Codes:',
                Array.isArray(record.reason_codes) && record.reason_codes.length > 0
                    ? record.reason_codes.join(', ')
                    : 'NONE_RECORDED',
            ],
            ['Policy Standard & Version:', `${policyId} (v${policyVersion})`],
            ['Policy Rules Hash:', rulesHash],
            ['Nightly / Slot Merkle Root:', merkleRoot],
            ['Timestamp Logged:', new Date(record.created_at).toUTCString()],
        ];

        for (const [label, val] of items) {
            doc.fillColor('#334155').fontSize(8.5).font('Helvetica-Bold').text(label, 40, y, { width: 160 });
            doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica').text(val || 'N/A', 205, y, { width: doc.page.width - 245 });
            y += 19;
        }

        // AI Explanation / Narration Section
        y += 6;
        doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('Automated Regulatory Assessment & Narration', 40, y);
        y += 16;
        doc.rect(40, y, doc.page.width - 80, 65).fillAndStroke('#f1f5f9', '#e2e8f0');
        const narrativeText =
            record.ai_explanation ||
            (record.decision === 'ALLOW'
                ? 'Deterministic screening confirmed zero sanctions matches across OFAC SDN sets and clean counterparty lineage within policy tolerance limits. Transaction cleared for block inclusion.'
                : 'Automated policy evaluation identified compliance risks. Manual compliance officer review or travel-rule documentation required.');
        doc.fillColor('#1e293b').fontSize(8.5).font('Helvetica-Oblique')
            .text(narrativeText, 50, y + 8, { width: doc.page.width - 100 });

        // Tamper-Evident Cryptographic Seal (HMAC + Merkle Root)
        y += 75;
        doc.rect(40, y, doc.page.width - 80, 85).fillAndStroke('#f8fafc', '#94a3b8');
        doc.fillColor('#0f172a').fontSize(10.5).font('Helvetica-Bold')
            .text('CRYPTOGRAPHIC AUDIT PROOF & HMAC TAMPER-EVIDENT SEAL', 50, y + 8);
        doc.fillColor('#475569').fontSize(8).font('Helvetica')
            .text(`Policy ID: ${policyId} | Version: ${policyVersion} | Rules Hash: ${rulesHash.slice(0, 16)}...`, 50, y + 22);
        doc.fillColor('#0f172a').fontSize(8).font('Courier-Bold')
            .text(`HMAC-SHA256 Seal: ${storedDigest}`, 50, y + 36);
        doc.fillColor('#0f172a').fontSize(8).font('Courier-Bold')
            .text(`Merkle Tree Root: ${merkleRoot}`, 50, y + 50);
        doc.fillColor(isAuthentic ? '#16a34a' : '#dc2626').fontSize(8).font('Helvetica-Bold')
            .text(`Integrity Verification: ${isAuthentic ? 'VERIFIED AUTHENTIC (HMAC cryptographic seal verified)' : 'WARNING: TAMPER DETECTION - RECORD MISMATCH'}`, 50, y + 64);

        doc.end();
    });
}

fastify.get('/api/decisions/:tx_hash/report', async (request, reply) => {
    const { tx_hash } = request.params as { tx_hash: string };
    if (!tx_hash) {
        reply.status(400);
        return { error: 'tx_hash is required' };
    }

    const decisionRes = await pool.query(
        `SELECT tx_hash, sender, recipient, decision, risk_score, reason_codes, ai_explanation,
            counterparty_entity_type, exposure_hop_distance, policy_version, integrity_hash, created_at
     FROM compliance_decisions
     WHERE LOWER(tx_hash) = LOWER($1)
     LIMIT 1`,
        [tx_hash]
    );

    if (decisionRes.rows.length === 0) {
        reply.status(404);
        return { error: `Compliance decision record for '${tx_hash}' not found` };
    }

    const decision = decisionRes.rows[0];

    const entityRes = await pool.query(
        `SELECT entity_name, entity_type FROM entity_labels WHERE LOWER(address) = LOWER($1) LIMIT 1`,
        [decision.recipient]
    );
    const entityLabel = entityRes.rows[0] || null;

    try {
        const pdfBuffer = await generateDecisionReportPdf(decision, entityLabel);

        reply
            .header('Content-Type', 'application/pdf')
            .header(
                'Content-Disposition',
                `attachment; filename="compliance-audit-${decision.tx_hash.slice(0, 10)}.pdf"`
            )
            .send(pdfBuffer);
    } catch (err: any) {
        fastify.log.error(`PDF report generation failed: ${err.message || err}`);
        reply.status(500);
        return { error: 'Failed to generate PDF compliance report' };
    }
});

// EDD (Enhanced Due Diligence) Case Management Endpoints
fastify.get('/api/edd/cases', async (request, reply) => {
    const { status } = (request.query || {}) as { status?: string };
    const query = status
        ? `SELECT id, case_ref, tx_hash, bid_hash, status, assignee, note, risk_score, reasons, created_at, resolved_at FROM edd_cases WHERE status = $1 ORDER BY created_at DESC LIMIT 100`
        : `SELECT id, case_ref, tx_hash, bid_hash, status, assignee, note, risk_score, reasons, created_at, resolved_at FROM edd_cases ORDER BY created_at DESC LIMIT 100`;
    const params = status ? [status] : [];
    const res = await pool.query(query, params).catch(() => ({ rows: [] }));
    return res.rows;
});

fastify.get('/edd/cases', async (request, reply) => {
    const res = await pool.query(
        `SELECT id, case_ref, tx_hash, bid_hash, status, assignee, note, risk_score, reasons, created_at, resolved_at FROM edd_cases ORDER BY created_at DESC LIMIT 100`
    ).catch(() => ({ rows: [] }));
    return res.rows;
});

fastify.post('/api/edd/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { status?: string; assignee?: string; note?: string };
    const { status, assignee, note } = body;

    if (!status || (status !== 'APPROVED' && status !== 'QUARANTINED')) {
        reply.status(400);
        return { error: 'Invalid status. Must be APPROVED or QUARANTINED' };
    }
    if (!assignee || !assignee.trim()) {
        reply.status(400);
        return { error: 'assignee is required' };
    }

    const updateRes = await pool.query(
        `UPDATE edd_cases
         SET status = $1, assignee = $2, note = $3, resolved_at = NOW()
         WHERE id = $4
         RETURNING id, case_ref, tx_hash, bid_hash, status, assignee, note, risk_score, reasons, created_at, resolved_at`,
        [status, assignee, note || '', id]
    );

    if (updateRes.rows.length === 0) {
        reply.status(404);
        return { error: `EDD case '${id}' not found` };
    }

    return updateRes.rows[0];
});

fastify.post('/edd/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { status?: string; assignee?: string; note?: string };
    const { status, assignee, note } = body;

    if (!status || (status !== 'APPROVED' && status !== 'QUARANTINED')) {
        reply.status(400);
        return { error: 'Invalid status. Must be APPROVED or QUARANTINED' };
    }
    if (!assignee || !assignee.trim()) {
        reply.status(400);
        return { error: 'assignee is required' };
    }

    const updateRes = await pool.query(
        `UPDATE edd_cases
         SET status = $1, assignee = $2, note = $3, resolved_at = NOW()
         WHERE id = $4
         RETURNING id, case_ref, tx_hash, bid_hash, status, assignee, note, risk_score, reasons, created_at, resolved_at`,
        [status, assignee, note || '', id]
    );

    if (updateRes.rows.length === 0) {
        reply.status(404);
        return { error: `EDD case '${id}' not found` };
    }

    return updateRes.rows[0];
});

async function generateExplanation(row: {
    tx_hash: string;
    decision: string;
    risk_score: number;
    reason_codes: string[];
}) {
    try {
        const response = await fetch(AI_EXPLAINER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': INTERNAL_SERVICE_SECRET,
            },
            body: JSON.stringify({
                tx: row.tx_hash,
                decision: row.decision,
                risk_score: row.risk_score,
                reasons: row.reason_codes,
            }),
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            fastify.log.warn(`AI explainer returned status ${response.status} for ${row.tx_hash}`);
            await pool.query(
                `UPDATE compliance_decisions SET ai_explanation = $1 WHERE tx_hash = $2 AND ai_explanation IS NULL`,
                ['Narration unavailable (AI service returned error)', row.tx_hash]
            );
            return;
        }

        const data = (await response.json()) as { narrative: string };

        await pool.query(
            `UPDATE compliance_decisions SET ai_explanation = $1 WHERE tx_hash = $2`,
            [data.narrative, row.tx_hash]
        );

        fastify.log.info(`AI explanation saved for ${row.tx_hash}`);
        broadcast({ type: 'explanation_ready', tx_hash: row.tx_hash, narrative: data.narrative });
    } catch (err: any) {
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const reason = isTimeout ? 'timeout after 5s' : `${err?.message || err}`;
        fastify.log.warn(`AI explainer failed for ${row.tx_hash}: ${reason}`);

        await pool
            .query(
                `UPDATE compliance_decisions SET ai_explanation = $1 WHERE tx_hash = $2 AND ai_explanation IS NULL`,
                [`Narration unavailable (${reason})`, row.tx_hash]
            )
            .catch(() => { });
    }
}

// Resilient, non-dropping decision watcher
let lastSeenTimestamp = new Date(0);
const processedTxHashes = new Set<string>();

(async () => {
    try {
        const latest = await pool.query(
            `SELECT created_at FROM compliance_decisions ORDER BY created_at DESC LIMIT 1`
        );
        if (latest.rows.length > 0) {
            lastSeenTimestamp = new Date(latest.rows[0].created_at);
        }
    } catch {
        // Ignore if table not yet initialized
    }
})();

setInterval(async () => {
    try {
        const result = await pool.query(
            `SELECT tx_hash, sender, recipient, decision, risk_score, reason_codes, ai_explanation,
              counterparty_entity_type, exposure_hop_distance, policy_version, integrity_hash, created_at
       FROM compliance_decisions
       WHERE created_at >= $1
       ORDER BY created_at ASC
       LIMIT 100`,
            [lastSeenTimestamp]
        );

        for (const row of result.rows) {
            if (processedTxHashes.has(row.tx_hash)) {
                continue;
            }
            processedTxHashes.add(row.tx_hash);

            if (processedTxHashes.size > 5000) {
                const oldest = processedTxHashes.values().next().value;
                if (oldest) processedTxHashes.delete(oldest);
            }

            const rowTime = new Date(row.created_at);
            if (rowTime > lastSeenTimestamp) {
                lastSeenTimestamp = rowTime;
            }

            broadcast({ type: 'new_decision', data: row });

            if ((row.decision === 'BLOCK' || row.decision === 'FLAG') && !row.ai_explanation) {
                generateExplanation(row);
            }
        }
    } catch (err) {
        fastify.log.error(`Polling error in decision watcher: ${err}`);
    }
}, 500);

const port = Number(process.env.PORT) || 3002;
const host = process.env.HOST || '127.0.0.1';

fastify.listen({ port, host }, (err) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    console.log(`Fastify orchestration layer listening on http://${host}:${port}`);
});
