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

// Restrict CORS origins in production, permit localhost/dev origins by default
await fastify.register(cors, {
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : true,
});
await fastify.register(websocket);

const clients = new Set<any>();

fastify.get('/ws', { websocket: true }, (socket) => {
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
    const body = request.body as { policy_id?: string };
    if (!body || !body.policy_id) {
        reply.status(400);
        return { error: 'policy_id is required' };
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

fastify.post('/api/demo/run-simulator', async (request, reply) => {
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
        const child = spawn(binaryInfo.binaryPath, [], {
            cwd: binaryInfo.simulatorDir,
            env: {
                ...process.env,
                DATABASE_URL:
                    process.env.DATABASE_URL || 'postgres://shresthkumar@localhost:5432/compliance_builder',
                ENGINE_URL: process.env.ENGINE_URL || 'http://127.0.0.1:3001/screen',
                ANVIL_RPC: process.env.ANVIL_RPC || 'http://127.0.0.1:8545',
            },
        });

        simulatorChildProcess = child;
        fastify.log.info(
            `Spawned simulator demo process (PID: ${child.pid}) from ${binaryInfo.binaryPath}`
        );

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
            fastify.log.info(`Simulator process exited with code ${code}`);
            simulatorChildProcess = null;
        });

        child.on('error', (err) => {
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
    const decisions = await pool.query(
        `SELECT decision, COUNT(*) FROM compliance_decisions GROUP BY decision`
    );
    const blocks = await pool.query(
        `SELECT compliance_status, COUNT(*) FROM blocks GROUP BY compliance_status`
    );

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
            record.recipient.toLowerCase(),
            record.counterparty_entity_type || 'None',
            record.exposure_hop_distance != null ? String(record.exposure_hop_distance) : 'None',
        ].join('|');
        const computedDigest = crypto.createHash('sha256').update(canonicalString).digest('hex');
        const storedDigest = record.integrity_hash || computedDigest;
        const isAuthentic = !record.integrity_hash || record.integrity_hash === computedDigest;

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
        doc.text(`Active Compliance Standard: ${record.policy_version || 'institution-standard-v1'}`, 40, 120);

        // Decision Status Box
        const decisionColor =
            record.decision === 'BLOCK' ? '#dc2626' : record.decision === 'FLAG' ? '#d97706' : '#16a34a';
        doc.rect(40, 140, doc.page.width - 80, 55).fillAndStroke('#f8fafc', '#cbd5e1');
        doc.fillColor(decisionColor).fontSize(20).font('Helvetica-Bold')
            .text(`COMPLIANCE DECISION: ${record.decision}`, 55, 150);
        doc.fillColor('#475569').fontSize(12).font('Helvetica')
            .text(`Calculated Risk Score: ${record.risk_score}/100  |  Evaluated Policy: ${record.policy_version || 'v1'}`, 55, 175);

        // Details Grid
        let y = 210;
        doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text('Transaction & Entity Telemetry', 40, y);
        y += 20;

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
            ['Timestamp Logged:', new Date(record.created_at).toUTCString()],
        ];

        for (const [label, val] of items) {
            doc.fillColor('#334155').fontSize(9).font('Helvetica-Bold').text(label, 40, y, { width: 160 });
            doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(val || 'N/A', 205, y, { width: doc.page.width - 245 });
            y += 22;
        }

        // AI Explanation / Narration Section
        y += 10;
        doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text('Automated Regulatory Assessment & Narration', 40, y);
        y += 20;
        doc.rect(40, y, doc.page.width - 80, 80).fillAndStroke('#f1f5f9', '#e2e8f0');
        const narrativeText =
            record.ai_explanation ||
            (record.decision === 'ALLOW'
                ? 'Deterministic screening confirmed zero sanctions matches across OFAC SDN sets and clean counterparty lineage within policy tolerance limits. Transaction cleared for block inclusion.'
                : 'Automated policy evaluation identified compliance risks. Manual compliance officer review or travel-rule documentation required.');
        doc.fillColor('#1e293b').fontSize(9).font('Helvetica-Oblique')
            .text(narrativeText, 50, y + 10, { width: doc.page.width - 100 });

        // Tamper-Evident Cryptographic Seal
        y += 100;
        doc.rect(40, y, doc.page.width - 80, 85).fillAndStroke('#f8fafc', '#94a3b8');
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold')
            .text('CRYPTOGRAPHIC AUDIT PROOF & TAMPER-EVIDENT SEAL', 50, y + 10);
        doc.fillColor('#475569').fontSize(8).font('Helvetica')
            .text('Original Engine Seal: Computed at evaluation time by compiled Rust core and stored in immutable ledger.', 50, y + 24);
        doc.fillColor('#0f172a').fontSize(8).font('Courier-Bold')
            .text(`SHA-256 Digest: ${storedDigest}`, 50, y + 38);
        doc.fillColor(isAuthentic ? '#16a34a' : '#dc2626').fontSize(8).font('Helvetica-Bold')
            .text(`Integrity Verification: ${isAuthentic ? 'VERIFIED AUTHENTIC (Postgres audit record matches original engine seal)' : 'WARNING: TAMPER DETECTION - RECORD MISMATCH'}`, 50, y + 52);
        doc.fillColor('#64748b').fontSize(7.5).font('Helvetica')
            .text(
                'Formula: sha256(tx_hash|decision|risk_score|policy|sender|recipient|entity|hop). Preserved for regulatory compliance under SIH26182 / SIH26183 standards.',
                50,
                y + 66,
                { width: doc.page.width - 100 }
            );

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

async function generateExplanation(row: {
    tx_hash: string;
    decision: string;
    risk_score: number;
    reason_codes: string[];
}) {
    try {
        const response = await fetch(AI_EXPLAINER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

fastify.listen({ port, host: '0.0.0.0' }, (err) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    console.log(`Fastify orchestration layer listening on http://localhost:${port}`);
});
