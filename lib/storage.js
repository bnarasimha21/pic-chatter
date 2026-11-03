'use strict';

const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetBucketLifecycleConfigurationCommand,
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
const DEFAULT_RETENTION_MINUTES = 10;
const DEFAULT_LIFECYCLE_DAYS = 1;
const MAX_DELETE_ATTEMPTS = 3;
const LIFECYCLE_RULE_ID = 'pic-chatter-backstop';

// All of this app's objects live under one key prefix. This is what keeps
// the sweep and the lifecycle rule scoped to objects this app actually
// wrote: without a prefix, a bucket that is shared with anything else
// would have sweepExpiredOnStartup() and the lifecycle rule below delete or
// expire objects this app never created, just because they happened to be
// older than the retention window.
const KEY_PREFIX = 'pic-chatter/';

let client = null;
let callCount = 0;
let retryBaseMs = Number(process.env.STORE_DELETE_RETRY_BASE_MS || 1000);
const pendingDeletions = new Set();
const pendingRetries = new Set();

function isEnabled() {
  return process.env.STORE_IMAGES === 'true';
}

function getRetentionMinutes() {
  const parsed = Number(process.env.STORE_RETENTION_MINUTES);
  // An unset or non-numeric value must fall back to the default rather
  // than silently becoming NaN: a NaN cutoff downstream (sweepExpiredOnStartup)
  // compares false against every real timestamp, so it would silently
  // delete nothing instead of using a sane default window.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_MINUTES;
}

function getLifecycleDays() {
  const parsed = Number(process.env.STORE_LIFECYCLE_DAYS);
  // Read fresh on every call, like getRetentionMinutes, rather than a
  // module-load-time constant: a constant read once at require() time
  // means a test (or an operator) setting this env var afterwards in the
  // same process has no effect, and a test asserting against it would
  // pass by coincidence against the hardcoded default rather than by
  // actually exercising the configured value.
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_LIFECYCLE_DAYS;
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
// Returns true only once the delete has actually succeeded (immediately,
// or on a later retry attempt made from this same call chain). A caller
// that wants to know "did this succeed right now" should treat anything
// other than `true` as "not yet, possibly still retrying in the
// background" rather than as a confirmed deletion.
async function deleteWithRetry(key, attempt = 0) {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    if (attempt + 1 < MAX_DELETE_ATTEMPTS) {
      const delayMs = retryBaseMs * 2 ** attempt;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRetries.delete(timer);
          resolve();
        }, delayMs);
        timer.unref();
        pendingRetries.add(timer);
      });
      return deleteWithRetry(key, attempt + 1);
    }
    // Deletion failures must not crash the process; log size-free, no
    // image data, consistent with the no-sensitive-logging rule below.
    console.warn(`Deletion failed for a stored image after ${MAX_DELETE_ATTEMPTS} attempts (key length ${key.length}):`, err.message);
    return false;
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
// `signal`, when provided, is threaded straight into the S3 client's
// send() call (the AWS SDK v3 forwards it all the way to the underlying
// HTTP request). Without this, a client that disconnects mid-upload still
// has its photo written to the bucket in full: the caller's own
// `!signal.aborted` check before calling this function only catches a
// disconnect that happened before the call started, not one that happens
// while this PUT is still in flight.
async function maybeStore({ buffer, mime, signal }) {
  if (!isEnabled()) return null;

  const ext = EXT_BY_MIME[mime] || 'bin';
  const key = `${KEY_PREFIX}${crypto.randomUUID()}.${ext}`;
  const retentionMinutes = getRetentionMinutes();

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: buffer,
        ContentType: mime
        // No ACL: the object stays private.
      }),
      signal ? { abortSignal: signal } : undefined
    );
  } catch (err) {
    // An aborted send() can still reject after the bytes were already
    // fully written: the abort can land in the gap between "request body
    // fully sent" and "response received", which is after S3 has already
    // committed the object. Without this, that narrow race would leave an
    // orphaned object with no deletion ever scheduled for it, since the
    // caller's own try/catch around maybeStore only logs the failure and
    // never learns this key. scheduleDelete() on a key that in fact was
    // never written is harmless: S3's DeleteObject is idempotent and
    // succeeds on a key that does not exist.
    if (signal && signal.aborted) {
      scheduleDelete(key, retentionMinutes);
    }
    throw err;
  }
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
    // Scoped to this app's own key prefix (see KEY_PREFIX above): without
    // this, a bucket shared with anything else would have every object
    // older than the retention window deleted, not just this app's own.
    const page = await getClient().send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: KEY_PREFIX,
      ContinuationToken: continuationToken
    }));
    const contents = page.Contents || [];
    scanned += contents.length;

    for (const obj of contents) {
      const modifiedAt = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
      if (modifiedAt < cutoff) {
        // Only count it once the delete has actually succeeded. A delete
        // that is still retrying in the background is not yet a deletion,
        // and reporting it as one here would overstate what this sweep
        // actually accomplished before returning.
        const succeeded = await deleteWithRetry(obj.Key, 0);
        if (succeeded) deleted++;
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

  const days = Math.max(1, Math.ceil(getLifecycleDays()));

  // Read whatever lifecycle rules already exist on the bucket first, and
  // keep them. Overwriting unconditionally (the pre-fix behaviour) would
  // silently delete every other rule on a bucket that is shared with
  // anything else, which is a far worse outcome than this rule simply
  // never getting set. A bucket with no lifecycle configuration at all
  // rejects the Get call with NoSuchLifecycleConfiguration, which just
  // means there is nothing to preserve - that is the only error this
  // treats as "no existing rules". Anything else (AccessDenied, a
  // throttling error, a transient 5xx, a network blip) must not be
  // treated the same way: silently swallowing it would re-enter the exact
  // overwrite bug this fix exists to close, just triggered by a
  // permissions gap or an outage instead of by a genuinely empty bucket.
  let existingRules = [];
  try {
    const current = await getClient().send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket() }));
    existingRules = current.Rules || [];
  } catch (err) {
    const code = err.Code || err.name || (err.$metadata && err.$metadata.httpStatusCode === 404 ? 'NoSuchLifecycleConfiguration' : undefined);
    if (code !== 'NoSuchLifecycleConfiguration') throw err;
    existingRules = [];
  }

  const otherRules = existingRules.filter((rule) => rule.ID !== LIFECYCLE_RULE_ID);
  const ownRule = {
    ID: LIFECYCLE_RULE_ID,
    Status: 'Enabled',
    // Scoped to this app's own key prefix, same as the startup sweep
    // above, so this never expires objects this app did not write.
    Filter: { Prefix: KEY_PREFIX },
    Expiration: { Days: days }
  };

  await getClient().send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket(),
    LifecycleConfiguration: {
      Rules: [...otherRules, ownRule]
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
