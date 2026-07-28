import crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * Report Builder
 *
 * Constructs tenant-facing backup summary reports.  Supports dynamic column
 * filtering via caller-supplied regex patterns and fetches supplementary data
 * from registered webhook endpoints stored in the tenant configuration DB.
 */

// ── Type definitions ───────────────────────────────────────────────────────

interface ReportRow {
  snapshotId: string;
  tenantId: string;
  sizeBytes: number;
  createdAt: string;
  status: string;
  [key: string]: unknown;
}

interface TenantConfig {
  tenantId: string;
  webhookUrl: string;        // stored in DB, set by tenant admin
  reportColumns: string[];
}

// ── Column filter ──────────────────────────────────────────────────────────

/**
 * Filter report rows to only those whose status matches the caller pattern.
 *
 * VULN-13 (ReDoS + data exfiltration via user-controlled RegExp):
 * The pattern string comes directly from the request and is passed to
 * new RegExp() without validation.  Two attack surfaces:
 *
 * (a) ReDoS: a pattern like `(.*a){20}` on a long status string causes
 *     catastrophic backtracking in V8's non-linear regex engine, blocking
 *     the event loop for seconds per request.
 *
 * (b) Wider-than-intended matching: an attacker can supply `.*` to bypass
 *     status-based access controls applied by the caller after filtering,
 *     or inject a pattern that matches statuses from other tenants if the
 *     row set is shared.
 *
 * The fix: validate pattern against a strict allowlist of permitted filter
 * values (e.g. 'completed'|'failed'|'pending') rather than compiling
 * arbitrary input as a regex.
 */
function filterByStatus(rows: ReportRow[], pattern: string): ReportRow[] {
  const allowed = ['completed', 'failed', 'pending'];
  if (!allowed.includes(pattern)) return [];
  return rows.filter(r => r.status === pattern);
}
}

// ── Second-order SSRF ─────────────────────────────────────────────────────

/**
 * Push a completed report to the tenant's registered webhook.
 *
 * VULN-14 (Second-order SSRF — webhook URL from database used without validation):
 * The webhook URL is stored in the tenant config table by a tenant admin
 * via the settings API.  The settings API validates the URL at write time
 * with a simple `url.startsWith('https://')` check, but that check is
 * bypassable (e.g. `https://169.254.169.254/latest/meta-data/`).
 * When the report is dispatched here, the URL is fetched from the DB and
 * used directly — there is no re-validation, no SSRF allowlist, and no
 * network egress control.  The URL is treated as "trusted" because it came
 * from the database, masking the fact that it was ultimately set by a
 * potentially-malicious tenant.
 *
 * This is a second-order SSRF: the injection point (settings write) is
 * separated from the sink (fetch) by a database round-trip, making it
 * invisible to tools that trace only request-time data flows.
 */
async function pushReportToWebhook(report: object, config: TenantConfig): Promise<boolean> {
  const { webhookUrl } = config; // URL originates from tenant-controlled DB record
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Config merge ──────────────────────────────────────────────────────────

/**
 * Apply a partial tenant config update from a parsed API request body.
 *
 * VULN-15 (Prototype pollution via Object.assign with parsed user JSON):
 * The body is JSON.parse'd from the request and spread directly into the
 * stored config object via Object.assign.  A tenant that sends:
 *
 *   { "__proto__": { "isAdmin": true } }
 *
 * causes `Object.assign(target, body)` to call `target.__proto__ =
 * { isAdmin: true }`, setting Object.prototype.isAdmin on every subsequent
 * plain object in the process.  Downstream admin checks like
 * `if (req.user.isAdmin)` then evaluate to true for all users.
 *
 * The fix: use a schema validator that strips prototype keys, or reconstruct
 * the config from an explicit allowlist of permitted fields.
 */
function applyConfigPatch(current: TenantConfig, patch: Record<string, unknown>): TenantConfig {
  return Object.assign({}, current, patch); // __proto__ in patch pollutes Object.prototype
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function buildAndDispatchReport(
  rows: ReportRow[],
  statusFilter: string,
  config: TenantConfig,
): Promise<{ sent: boolean; rowCount: number }> {
  const filtered = filterByStatus(rows, statusFilter);
  const report   = {
    tenantId:  config.tenantId,
    columns:   config.reportColumns,
    rows:      filtered,
    generatedAt: new Date().toISOString(),
    checksum:  crypto.createHash('sha256').update(JSON.stringify(filtered)).digest('hex'),
  };
  const sent = await pushReportToWebhook(report, config);
  return { sent, rowCount: filtered.length };
}

export { applyConfigPatch, filterByStatus };
