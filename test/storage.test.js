'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SPACES_ENDPOINT = 'fake.example.com';
process.env.SPACES_BUCKET = 'fake-bucket';
process.env.SPACES_KEY = 'fake-key';
process.env.SPACES_SECRET = 'fake-secret';

const storage = require('../lib/storage');

function makeFakeS3Client() {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return {};
    }
  };
}

function commandName(cmd) {
  return cmd.constructor.name;
}

test('issue 2: storage is off by default and makes no S3 call', async () => {
  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
  const client = makeFakeS3Client();
  storage.__setClientForTests(client);

  const result = await storage.maybeStore({ buffer: Buffer.from('hello'), mime: 'image/jpeg' });

  assert.equal(result, null);
  assert.equal(storage.__getCallCount(), 0);
  assert.equal(client.calls.length, 0);
});

test('issue 2: two uploads with the same logical file produce two different, private keys', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();
  const client = makeFakeS3Client();
  storage.__setClientForTests(client);

  const a = await storage.maybeStore({ buffer: Buffer.from('capture.jpg contents A'), mime: 'image/jpeg' });
  const b = await storage.maybeStore({ buffer: Buffer.from('capture.jpg contents B'), mime: 'image/jpeg' });

  assert.notEqual(a.key, b.key);
  assert.equal(storage.__getCallCount(), 2);

  const putCommands = client.calls.filter((c) => c.constructor.name === 'PutObjectCommand');
  assert.equal(putCommands.length, 2);
  for (const cmd of putCommands) {
    assert.equal(cmd.input.ACL, undefined, 'no ACL should be set; the object stays private');
  }

  delete process.env.STORE_IMAGES;
});

test('issue 2: storage schedules a real deletion after the retention window', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = String(20 / 60000); // 20ms, for a fast test
  storage.__resetForTests();
  const client = makeFakeS3Client();
  storage.__setClientForTests(client);

  const stored = await storage.maybeStore({ buffer: Buffer.from('to be deleted'), mime: 'image/jpeg' });
  assert.ok(stored.key);

  const deleteCalledBefore = client.calls.some((c) => c.constructor.name === 'DeleteObjectCommand');
  assert.equal(deleteCalledBefore, false, 'deletion should not have fired yet');

  await new Promise((resolve) => setTimeout(resolve, 150));

  const deleteCommands = client.calls.filter((c) => c.constructor.name === 'DeleteObjectCommand');
  assert.equal(deleteCommands.length, 1);
  assert.equal(deleteCommands[0].input.Key, stored.key);

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: sweepExpiredOnStartup deletes anything already past the retention window', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();

  const now = Date.now();
  const expiredKey = 'expired-object.jpg';
  const freshKey = 'fresh-object.jpg';
  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'ListObjectsV2Command') {
      return {
        Contents: [
          { Key: expiredKey, LastModified: new Date(now - 20 * 60 * 1000) }, // 20 min old, past 10 min window
          { Key: freshKey, LastModified: new Date(now - 1 * 60 * 1000) } // 1 min old, inside window
        ],
        IsTruncated: false
      };
    }
    return {};
  };
  storage.__setClientForTests(client);

  const result = await storage.sweepExpiredOnStartup();

  assert.equal(result.scanned, 2);
  assert.equal(result.deleted, 1);

  const deleteCommands = client.calls.filter((c) => commandName(c) === 'DeleteObjectCommand');
  assert.equal(deleteCommands.length, 1);
  assert.equal(deleteCommands[0].input.Key, expiredKey);

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: sweepExpiredOnStartup pages through ListObjectsV2 truncation', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();

  const now = Date.now();
  const expiredKeyPage1 = 'page1-expired.jpg';
  const expiredKeyPage2 = 'page2-expired.jpg';
  let pageCalls = 0;
  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'ListObjectsV2Command') {
      pageCalls++;
      if (pageCalls === 1) {
        return {
          Contents: [{ Key: expiredKeyPage1, LastModified: new Date(now - 30 * 60 * 1000) }],
          IsTruncated: true,
          NextContinuationToken: 'token-2'
        };
      }
      assert.equal(command.input.ContinuationToken, 'token-2', 'the continuation token from page 1 must be passed to page 2');
      return {
        Contents: [{ Key: expiredKeyPage2, LastModified: new Date(now - 30 * 60 * 1000) }],
        IsTruncated: false
      };
    }
    return {};
  };
  storage.__setClientForTests(client);

  const result = await storage.sweepExpiredOnStartup();

  assert.equal(result.scanned, 2);
  assert.equal(result.deleted, 2);
  assert.equal(pageCalls, 2);

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: sweepExpiredOnStartup is a no-op when storage is disabled', async () => {
  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
  const client = makeFakeS3Client();
  storage.__setClientForTests(client);

  const result = await storage.sweepExpiredOnStartup();

  assert.deepEqual(result, { scanned: 0, deleted: 0 });
  assert.equal(client.calls.length, 0, 'storage disabled must never touch the bucket');
});

test('issue review fix: ensureLifecyclePolicy sets a whole-day backstop rule, and is a no-op when storage is disabled', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_LIFECYCLE_DAYS = '1';
  storage.__resetForTests();
  const client = makeFakeS3Client();
  storage.__setClientForTests(client);

  await storage.ensureLifecyclePolicy();

  const lifecycleCommands = client.calls.filter((c) => commandName(c) === 'PutBucketLifecycleConfigurationCommand');
  assert.equal(lifecycleCommands.length, 1);
  const rule = lifecycleCommands[0].input.LifecycleConfiguration.Rules[0];
  assert.equal(rule.Status, 'Enabled');
  assert.equal(rule.Expiration.Days, 1);

  delete process.env.STORE_IMAGES;
  delete process.env.STORE_LIFECYCLE_DAYS;
  storage.__resetForTests();

  const client2 = makeFakeS3Client();
  storage.__setClientForTests(client2);
  await storage.ensureLifecyclePolicy();
  assert.equal(client2.calls.length, 0, 'storage disabled must never touch the bucket');
});

test('issue review fix: a failed delete is retried with backoff instead of being logged once and dropped', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();
  storage.__setRetryDelayForTests(10); // keep the test fast

  const key = 'flaky-delete.jpg';
  let deleteAttempts = 0;
  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'ListObjectsV2Command') {
      return {
        Contents: [{ Key: key, LastModified: new Date(Date.now() - 20 * 60 * 1000) }],
        IsTruncated: false
      };
    }
    if (commandName(command) === 'DeleteObjectCommand') {
      deleteAttempts++;
      if (deleteAttempts < 3) {
        throw new Error('simulated transient delete failure');
      }
      return {};
    }
    return {};
  };
  storage.__setClientForTests(client);

  await storage.sweepExpiredOnStartup();
  // Give the two retry timers (10ms, 20ms backoff) time to fire.
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(deleteAttempts, 3, 'should retry until it succeeds, up to the max attempt count');

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: a delete that keeps failing past the max attempts is dropped without crashing', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();
  storage.__setRetryDelayForTests(10);

  const key = 'always-fails-delete.jpg';
  let deleteAttempts = 0;
  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'ListObjectsV2Command') {
      return {
        Contents: [{ Key: key, LastModified: new Date(Date.now() - 20 * 60 * 1000) }],
        IsTruncated: false
      };
    }
    if (commandName(command) === 'DeleteObjectCommand') {
      deleteAttempts++;
      throw new Error('simulated permanent delete failure');
    }
    return {};
  };
  storage.__setClientForTests(client);

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await storage.sweepExpiredOnStartup();
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(deleteAttempts, 3, 'must stop retrying after the max attempt count, not loop forever');
  assert.ok(warnings.some((w) => w.includes('Deletion failed')), 'a permanently failed delete must be logged, not silently dropped');

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});
