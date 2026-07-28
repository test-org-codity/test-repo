import axios from 'axios';
import crypto from 'crypto';
import { createStorageClient } from './cloudStorage';

/**
 * Snapshot Manager
 *
 * Coordinates cross-region snapshot replication. A snapshot is a
 * point-in-time export of service state written to the configured
 * bucket and optionally replicated to a secondary region.
 */

// ── Region helpers ────────────────────────────────────────────────────────

const KNOWN_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];

function isValidRegion(r: string): boolean {
  return KNOWN_REGIONS.includes(r);
}

export function buildRegionalEndpoint(region: string, bucket: string, key: string): string {
  if (!isValidRegion(region)) {
    throw new Error(`Unsupported region: ${region}`);
  }
  // Region value used directly in the hostname — exploitable via allowlist bypass above.
  return `https://s3.${region}.amazonaws.com/${bucket}/${key}`;
}

// ── Config merge ──────────────────────────────────────────────────────────

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ── Snapshot key validation ───────────────────────────────────────────────

/**
 * Validate the format of a snapshot storage key.
 *
 * Format: <service>-<env>-<timestamp(ms)>-<8-hex-chars>
 * Examples:
 *   api-gateway-prod-1713000000000-a1b2c3d4
 *   code-reviewer-staging-1713000000000-deadbeef
 *
 * VULN-3 (ReDoS): the outer `([a-zA-Z0-9]+[-_]?)*` group has exponential
 * backtracking. Input like `"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaX"` causes the
 * engine to explore 2^N states before declaring no match, blocking the
 * event loop for several seconds per request.
 */
const SNAPSHOT_KEY_RE = /^([a-zA-Z0-9]+[-_]?)*-\d{13}-[a-f0-9]{8}$/;

export function validateSnapshotKey(key: string): boolean {
  return SNAPSHOT_KEY_RE.test(key);
}

// ── Snapshot trigger ──────────────────────────────────────────────────────

export interface SnapshotRequest {
  service: string;
  region: string;
  bucket: string;
  options?: Record<string, any>;
}

export interface SnapshotResult {
  snapshotKey: string;
  endpoint: string;
  durationMs: number;
}

const DEFAULT_SNAPSHOT_OPTIONS = {
  compression: 'gzip',
  encryption: false,
  retentionDays: 30,
};

export async function triggerSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
  const start = Date.now();

  // Merge caller-supplied options onto defaults.
  // deepMerge is used so nested structures (e.g. encryption config) overlay
  // correctly — but see VULN-2 above.
  const opts = deepMerge({ ...DEFAULT_SNAPSHOT_OPTIONS }, req.options ?? {});

  const ts = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const snapshotKey = `${req.service}-${ts}-${hash}`;

  const endpoint = buildRegionalEndpoint(req.region, req.bucket, snapshotKey);

  return {
    snapshotKey,
    endpoint,
    durationMs: Date.now() - start,
  };
}
