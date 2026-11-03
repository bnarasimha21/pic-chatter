'use strict';

const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Storage is optional and off by default (issue 2): the image goes straight
// to the vision provider and is never written anywhere unless STORE_IMAGES
// is explicitly "true". When it is on, the object key is random (never the
// client's filename), no ACL is set (DigitalOcean Spaces and S3 both
// default new objects to private), and deletion is scheduled with a timer.
//
// What that timer actually guarantees: it deletes the object after the
// retention window IF the process stays alive that whole time. A crash,
// redeploy, or restart during the window loses the timer along with the
// process, so two more things exist specifically to cover that gap:
//   - sweepExpiredOnStartup(): runs once when the server starts and
//     deletes anything already past its retention window, so a restart
//     self-heals instead of leaking that photo forever.
//   - ensureLifecyclePolicy(): a bucket-level lifecycle rule as a backstop,
//     independent of this process. S3/Spaces lifecycle rules only support
//     whole-day granularity, so this cannot enforce the (default 10
//     minute) retention window itself; it exists to guarantee an outer
//     bound (default 1 day) on anything that slips through the other two
//     paths, e.g. a sweep that never got to run because the bucket was
//     unreachable at every startup since the orphaned object was written.
// See readme.md's "Privacy and consent" section for what this does and
// does not guarantee.

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const DEFAULT_RETENTION_MINUTES = Number(process.env.STORE_RETENTION_MINUTES || 10);
const DEFAULT_LIFECYCLE_DAYS = Number(process.env.STORE_LIFECYCLE_DAYS || 1);
const MAX_DELETE_ATTEMPTS = 3;

let client = null;
let callCount = 0;
let retryBaseMs = Number(process.env.STORE_DELETE_RETRY_BASE_MS || 1000);
const pendingDeletions = new Set();
const pendingRetries = new Set();

function isEnabled() {
  return process.env.STORE_IMAGES === 'true';
}

function getRetentionMinutes() {
  return Number(process.env.STORE_RETENTION_MINUTES || DEFAULT_RETENTION_MINUTES);
}

function getClient() {
  if (!client) {
    client = new S3Client({
      endpoint: `https://${process.env.SPACES_ENDPOINT}`,
      region: process.env.SPACES_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET
      }
    });
  }
  return client;
}

function bucket() {
  return process.env.SPACES_BUCKET;
}

// Deletes one key, retrying with exponential backoff on failure instead of
// logging once and giving up (the pre-fix behaviour). Still never throws:
// a stuck deletion must not crash the process or the request that
// triggered it.
async function deleteWithRetry(key, attempt = 0) {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if (attempt + 1 < MAX_DELETE_ATTEMPTS) {
      const delayMs = retryBaseMs * 2 ** attempt;
      const timer = setTimeout(() => {
        pendingRetries.delete(timer);
        deleteWithRetry(key, attempt + 1);
      }, delayMs);
      timer.unref();
      pendingRetries.add(timer);
      return;
    }
    // Deletion failures must not crash the process; log size-free, no
    // image data, consistent with the no-sensitive-logging rule below.
    console.warn(`Deletion failed for a stored image after ${MAX_DELETE_ATTEMPTS} attempts (key length ${key.length}):`, err.message);
  }
}

function scheduleDelete(key, retentionMinutes) {
  const ms = Math.max(0, retentionMinutes) * 60 * 1000;
  const timer = setTimeout(() => {
    pendingDeletions.delete(timer);
    deleteWithRetry(key, 0);
  }, ms);
  timer.unref();
  pendingDeletions.add(timer);
  return timer;
}

// Stores buffer if STORE_IMAGES=true, returning { key, url, expiresAt } or
// null if storage is disabled. Never logs the buffer or the question.
async function maybeStore({ buffer, mime }) {
  if (!isEnabled()) return null;

  const ext = EXT_BY_MIME[mime] || 'bin';
  const key = `${crypto.randomUUID()}.${ext}`;
  const retentionMinutes = getRetentionMinutes();

  await getClient().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: buffer,
    ContentType: mime
    // No ACL: the object stays private.
  }));
  callCount++;

  // getSignedUrl needs a real S3Client's signing middleware; a fake test
  // client (a plain object with just send()) cannot produce one. That is
  // fine here: the response can fall back to no preview URL rather than
  // fail the whole upload over a cosmetic feature.
  let url = null;
  try {
    url = await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
      { expiresIn: Math.min(Math.max(retentionMinutes * 60, 1), 3600) }
    );
  } catch (err) {
    url = null;
  }

  scheduleDelete(key, retentionMinutes);

  return { key, url, expiresAt: new Date(Date.now() + retentionMinutes * 60 * 1000).toISOString() };
}

// Runs once at startup: deletes anything already in the bucket whose
// LastModified is older than the current retention window. This is what
// makes a restart, crash, or redeploy self-heal instead of leaking a photo
// forever, since the in-memory timer from scheduleDelete() does not
// survive the process that created it.
async function sweepExpiredOnStartup() {
  if (!isEnabled()) return { scanned: 0, deleted: 0 };

  const retentionMinutes = getRetentionMinutes();
  const cutoff = Date.now() - retentionMinutes * 60 * 1000;
  let continuationToken;
  let scanned = 0;
  let deleted = 0;

  do {
    const page = await getClient().send(new ListObjectsV2Command({
      Bucket: bucket(),
      ContinuationToken: continuationToken
    }));
    const contents = page.Contents || [];
    scanned += contents.length;

    for (const obj of contents) {
      const modifiedAt = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
      if (modifiedAt < cutoff) {
        await deleteWithRetry(obj.Key, 0);
        deleted++;
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return { scanned, deleted };
}

// Best-effort bucket-level lifecycle rule as a backstop independent of this
// process. Lifecycle rules only support whole-day expiry, so STORE_LIFECYCLE_DAYS
// (default 1 day) is a coarse outer bound, not a substitute for the
// retention-window deletion above. Not every S3-compatible provider or IAM
// policy allows setting this from the app; a failure here is logged by the
// caller and must never block startup.
async function ensureLifecyclePolicy() {
  if (!isEnabled()) return;

  const days = Math.max(1, Math.ceil(DEFAULT_LIFECYCLE_DAYS));
  await getClient().send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket(),
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'pic-chatter-backstop',
          Status: 'Enabled',
          Filter: {},
          Expiration: { Days: days }
        }
      ]
    }
  }));
}

// --- test control -----------------------------------------------------
function __setClientForTests(fakeClient) {
  client = fakeClient;
  callCount = 0;
}

function __getCallCount() {
  return callCount;
}

function __setRetryDelayForTests(ms) {
  retryBaseMs = ms;
}

function __resetForTests() {
  client = null;
  callCount = 0;
  retryBaseMs = Number(process.env.STORE_DELETE_RETRY_BASE_MS || 1000);
  for (const timer of pendingDeletions) clearTimeout(timer);
  pendingDeletions.clear();
  for (const timer of pendingRetries) clearTimeout(timer);
  pendingRetries.clear();
}

module.exports = {
  isEnabled,
  getRetentionMinutes,
  maybeStore,
  sweepExpiredOnStartup,
  ensureLifecyclePolicy,
  __setClientForTests,
  __getCallCount,
  __setRetryDelayForTests,
  __resetForTests
};
