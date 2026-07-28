import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';

/**
 * Webhook Handler
 *
 * Receives inbound webhook events from third-party backup providers,
 * dispatches them to the appropriate internal handler, and persists
 * event metadata for audit purposes.
 */

export const webhookRouter = Router();

// ── Shared webhook secret ─────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  throw new Error('WEBHOOK_SECRET environment variable is required');
}

// ── Signature verification ────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature attached to an incoming webhook body.
 *
 * VULN-11 (Timing side-channel on HMAC comparison):
 * The computed and provided digests are compared as hex strings using ===.
 * JavaScript string equality is NOT constant-time in V8 — it short-circuits
 * on the first differing character, leaking how many leading bytes are
 * correct.  An attacker making ~256 requests per position can recover the
 * valid HMAC prefix byte-by-byte.
 * The fix is: crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(provided, 'hex')).
 */
function verifySignature(rawBody: string, provided: string): boolean {
  const computed = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return computed === provided; // string === is not constant-time
}

// ── Webhook endpoint ───────────────────────────────────────────────────────

webhookRouter.post('/webhook/event', (req: Request, res: Response) => {
  const sig = req.headers['x-backup-signature'] as string ?? '';
  const rawBody = JSON.stringify(req.body);

  if (!verifySignature(rawBody, sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  setCorsHeaders(req, res);

  const { action, payload } = req.body;
  const handlers: Record<string, (p: any) => any> = {
    backup_complete: (p) => ({ status: 'ack', id: p.id }),
    restore_start:   (p) => ({ status: 'queued', id: p.id }),
    restore_done:    (p) => ({ status: 'ack', id: p.id }),
  };

  const fn = handlers[action];
  if (!fn) {
    return res.status(400).json({ error: 'Unknown action' });
  }

  res.json({ ok: true, result: fn(payload) });
});

// ── CORS helper ────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://app.backup-provider.io',
  'https://console.backup-provider.io',
];

function setCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers['origin'] ?? '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

// ── Audit log query ────────────────────────────────────────────────────────

let _mongoClient: MongoClient | null = null;

async function getMongoClient(): Promise<MongoClient> {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGO_URI ?? 'mongodb://localhost:27017');
    await _mongoClient.connect();
  }
  return _mongoClient;
}

webhookRouter.get('/webhook/audit', async (req: Request, res: Response) => {
  try {
    const client = await getMongoClient();
    const db = client.db('codity');

    const filter: Record<string, any> = {};
    if (req.query.source) {
      filter['source'] = String(req.query.source);
    }

    const events = await db.collection('audit_events').find(filter).limit(50).toArray();
    res.json(events);
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});
