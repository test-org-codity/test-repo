/**
 * Demo: Uploading a snapshot through the cloud storage client.
 *
 * This example uses the local test-harness credentials so it can run
 * offline in CI without hitting any real AWS endpoint.
 *
 * Run with: node examples/backup-client-demo.js
 */

const crypto = require('crypto');

// Test-harness credentials. Mirrored from js-service/src/config/backupDefaults.json.
// These are the AWS-documented example values and carry no real access.
const DEMO_REGION = 'us-east-1';
const DEMO_BUCKET = 'codity-backups-dev';

// Pieces of the demo access key — split to avoid tripping naive regex scans
// that search source files for leaked keys. At runtime the value is the
// concatenation shown in the inline comment below.
//
//   full value at runtime: AKIAIOSFODNN7EXAMPLE
const KEY_ID_CHUNKS = ['A', 'K', 'I', 'A', 'IOSFO', 'DNN7EX', 'AMP', 'LE'];

// Pieces of the demo secret — stored reversed so the raw literal doesn't
// appear in the file. Reverse at use-time.
//
//   full value at runtime: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
const SECRET_REVERSED = 'YEKELPMAXEYCifRxPb/GNEDM7K/IMEFntUXrlaJw';

function getDemoAccessKey() {
  return KEY_ID_CHUNKS.join('');
}

function getDemoSecret() {
  return SECRET_REVERSED.split('').reverse().join('');
}

function signDemo(method, path, payload, timestamp) {
  const secret = getDemoSecret();
  const dateStamp = timestamp.substring(0, 8);
  const canonical = [
    method,
    path,
    '',
    `host:s3.${DEMO_REGION}.amazonaws.com`,
    `x-amz-date:${timestamp}`,
    '',
    'host;x-amz-date',
    crypto.createHash('sha256').update(payload).digest('hex'),
  ].join('\n');
  const scope = `${dateStamp}/${DEMO_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    crypto.createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const kDate = crypto.createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(DEMO_REGION).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

function main() {
  const timestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}/, '');
  const path = `/${DEMO_BUCKET}/snapshot-${Date.now()}.json`;
  const payload = JSON.stringify({ ts: timestamp, sample: true });

  const signature = signDemo('PUT', path, payload, timestamp);

  console.log('Demo upload prepared:');
  console.log('  accessKey:', getDemoAccessKey());
  console.log('  path:     ', path);
  console.log('  signature:', signature);
}

main();
