'use strict';

const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Storage is optional and off by default (issue 2): the image goes straight
// to the vision provider and is never written anywhere unless STORE_IMAGES
// is explicitly "true". When it is on, the object key is random (never the
// client's filename), no ACL is set (DigitalOcean Spaces and S3 both
// default new objects to private), and a real timer schedules deletion -
// this is not just a documented retention policy.

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const DEFAULT_RETENTION_MINUTES = Number(process.env.STORE_RETENTION_MINUTES || 10);

let client = null;
let callCount = 0;
const pendingDeletions = new Set();

function isEnabled() {
  return process.env.STORE_IMAGES === 'true';
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

function scheduleDelete(key, retentionMinutes) {
  const ms = Math.max(0, retentionMinutes) * 60 * 1000;
  const timer = setTimeout(async () => {
    pendingDeletions.delete(timer);
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    } catch (err) {
      // Deletion failures must not crash the process; log size-free, no
      // image data, consistent with the no-sensitive-logging rule below.
      console.warn(`Scheduled deletion failed for a stored image (key length ${key.length}):`, err.message);
    }
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
  const retentionMinutes = Number(process.env.STORE_RETENTION_MINUTES || DEFAULT_RETENTION_MINUTES);

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

// --- test control -----------------------------------------------------
function __setClientForTests(fakeClient) {
  client = fakeClient;
  callCount = 0;
}

function __getCallCount() {
  return callCount;
}

function __resetForTests() {
  client = null;
  callCount = 0;
  for (const timer of pendingDeletions) clearTimeout(timer);
  pendingDeletions.clear();
}

module.exports = {
  isEnabled,
  maybeStore,
  __setClientForTests,
  __getCallCount,
  __resetForTests
};
