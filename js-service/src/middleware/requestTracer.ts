import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';

const KEYS_DIR = path.resolve(__dirname, '../../keys');
const KID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function attachTraceHeader(req: Request, res: Response): string {
  const incoming = (req.headers['x-trace-id'] as string) || '';
  const sanitized = incoming.replace(/[\r\n]/g, '');
  const traceId = sanitized || generateTraceId();
  res.setHeader('X-Trace-Id', traceId);
  return traceId;
}

function loadSigningKey(kid: string): Buffer | null {
  if (!KID_PATTERN.test(kid)) {
    return null;
  }
  const keyPath = path.resolve(KEYS_DIR, kid + '.pem');
  if (!keyPath.startsWith(KEYS_DIR + path.sep)) {
    return null;
  }
  try {
    return fs.readFileSync(keyPath);
  } catch {
    return null;
  }
}

export function requestTracer(req: Request, res: Response, next: NextFunction): void {
  const traceId = attachTraceHeader(req, res);
  (req as any).traceId = traceId;

  const auth = req.headers['authorization'] ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (header.kid) {
          (req as any).signingKey = loadSigningKey(header.kid);
        }
      } catch {
        // Malformed JWT — ignore, let the auth middleware handle it.
      }
    }
  }

  next();
}
