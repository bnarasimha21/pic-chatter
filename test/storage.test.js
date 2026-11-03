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

test('issue review fix: maybeStore forwards a passed-in abort signal to the S3 client, so a mid-upload client disconnect actually cancels the upload', async () => {
  // Without threading the signal through, the PutObjectCommand would run
  // to completion regardless of the caller aborting, so a client that
  // disconnects mid-upload would still end up with its photo written in
  // full. This fake client's send() mimics the real SDK's contract: it
  // only rejects once the passed abortSignal actually fires, proving the
  // signal reaches all the way into the call rather than merely being
  // accepted and ignored.
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = '10';
  storage.__resetForTests();

  const client = makeFakeS3Client();
  let putStarted = false;
  client.send = (command, options) => {
    client.calls.push(command);
    if (commandName(command) === 'PutObjectCommand') {
      putStarted = true;
      return new Promise((resolve, reject) => {
        const signal = options && options.abortSignal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new Error('simulated abort reaching the S3 client'));
          });
        }
        // Never resolves on its own within the test's lifetime; the only
        // way this promise settles is via the abort listener above. If the
        // signal were not forwarded, this would hang the test instead
        // (caught by the suite's own timeout), which is itself evidence of
        // the bug this test guards against.
      });
    }
    return Promise.resolve({});
  };
  storage.__setClientForTests(client);

  const controller = new AbortController();
  const storePromise = storage.maybeStore({
    buffer: Buffer.from('mid-upload disconnect'),
    mime: 'image/jpeg',
    signal: controller.signal
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(putStarted, true, 'the upload should already be in flight before the abort');
  controller.abort();

  await assert.rejects(storePromise, /abort/i, 'an aborted upload must reject rather than silently finish');

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: an aborted upload still schedules a safety-net delete for the generated key, in case the PUT actually landed before the abort was observed', async () => {
  // A PutObjectCommand's promise can reject with an abort error even after
  // S3 has already committed the object: the abort can race the response
  // on its way back, after the request body was already fully sent. If
  // nothing scheduled a delete in that case, that object would never be
  // cleaned up by anything but the day-scale lifecycle backstop. This
  // proves maybeStore schedules a delete for the key it generated even
  // though, from its own caller's point of view, the store "failed".
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_RETENTION_MINUTES = String(20 / 60000); // 20ms, for a fast test
  storage.__resetForTests();

  const controller = new AbortController();
  const client = makeFakeS3Client();
  client.send = (command, options) => {
    client.calls.push(command);
    if (commandName(command) === 'PutObjectCommand') {
      // Simulate the object already having landed, then the abort
      // arriving right as the response would otherwise have been parsed.
      controller.abort();
      const signal = options && options.abortSignal;
      return Promise.reject(Object.assign(new Error('simulated late abort after the PUT actually landed'), {
        name: 'AbortError',
        aborted: signal && signal.aborted
      }));
    }
    return Promise.resolve({});
  };
  storage.__setClientForTests(client);

  await assert.rejects(
    storage.maybeStore({ buffer: Buffer.from('late abort'), mime: 'image/jpeg', signal: controller.signal }),
    /abort/i
  );

  await new Promise((resolve) => setTimeout(resolve, 150));

  const deleteCommands = client.calls.filter((c) => commandName(c) === 'DeleteObjectCommand');
  assert.equal(deleteCommands.length, 1, 'a safety-net delete must still be scheduled for the key the PUT attempted to write');

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
  assert.equal(result.rescheduled, 1, 'the still-fresh object must get a new deletion timer, not just be left alone');

  const deleteCommands = client.calls.filter((c) => commandName(c) === 'DeleteObjectCommand');
  assert.equal(deleteCommands.length, 1);
  assert.equal(deleteCommands[0].input.Key, expiredKey);

  const listCommand = client.calls.find((c) => commandName(c) === 'ListObjectsV2Command');
  assert.equal(listCommand.input.Prefix, 'pic-chatter/', 'the sweep must list only this app\'s own key prefix, not the whole bucket');

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
});

test('issue review fix: sweepExpiredOnStartup reschedules a fresh deletion timer for an object still within its retention window, so it still gets deleted after a restart', async () => {
  // This is the bug from the second adversarial review: the pre-fix sweep
  // only ever deleted objects that were ALREADY expired at startup. An
  // object stored a moment before a restart, still well within its
  // retention window, got no new timer at all (the in-process timer from
  // the original maybeStore() call died with the old process) and so was
  // never deleted by anything short of the coarse, whole-day lifecycle
  // backstop (or never, if that backstop isn't configured). This proves
  // the sweep now schedules a real deletion for the remaining time left in
  // the window, not just for objects already past it.
  process.env.STORE_IMAGES = 'true';
  // 20ms retention so both "within the window" and "the rescheduled timer
  // actually firing" can be observed inside a fast test, the same trick
  // used by the other timer tests in this file.
  process.env.STORE_RETENTION_MINUTES = String(20 / 60000);
  storage.__resetForTests();

  const now = Date.now();
  const freshKey = 'just-stored-before-restart.jpg';
  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'ListObjectsV2Command') {
      return {
        // LastModified is "now": fully within the 20ms retention window at
        // the moment the sweep runs, so this must NOT be deleted
        // immediately, but DOES need a new timer scheduled for it.
        Contents: [{ Key: freshKey, LastModified: new Date(now) }],
        IsTruncated: false
      };
    }
    return {};
  };
  storage.__setClientForTests(client);

  const result = await storage.sweepExpiredOnStartup();

  assert.equal(result.deleted, 0, 'an in-window object must not be deleted immediately by the sweep itself');
  assert.equal(result.rescheduled, 1);
  assert.equal(
    client.calls.some((c) => commandName(c) === 'DeleteObjectCommand'),
    false,
    'no delete should have fired yet, only been scheduled'
  );

  // Wait past the rescheduled deadline: the new timer the sweep created
  // must actually fire and delete the object, proving this isn't just a
  // bookkeeping counter with no real timer behind it.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const deleteCommands = client.calls.filter((c) => commandName(c) === 'DeleteObjectCommand');
  assert.equal(deleteCommands.length, 1, 'the rescheduled timer must actually fire and delete the object');
  assert.equal(deleteCommands[0].input.Key, freshKey);

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

  assert.deepEqual(result, { scanned: 0, deleted: 0, rescheduled: 0 });
  assert.equal(client.calls.length, 0, 'storage disabled must never touch the bucket');
});

test('issue review fix: ensureLifecyclePolicy sets a whole-day backstop rule scoped to this app\'s key prefix, and is a no-op when storage is disabled', async () => {
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
  assert.equal(rule.Filter.Prefix, 'pic-chatter/', 'the rule must be scoped to this app\'s own key prefix, not the whole bucket');

  delete process.env.STORE_IMAGES;
  delete process.env.STORE_LIFECYCLE_DAYS;
  storage.__resetForTests();

  const client2 = makeFakeS3Client();
  storage.__setClientForTests(client2);
  await storage.ensureLifecyclePolicy();
  assert.equal(client2.calls.length, 0, 'storage disabled must never touch the bucket');
});

test('issue review fix: ensureLifecyclePolicy merges with pre-existing rules instead of clobbering them', async () => {
  process.env.STORE_IMAGES = 'true';
  process.env.STORE_LIFECYCLE_DAYS = '1';
  storage.__resetForTests();

  const client = makeFakeS3Client();
  client.send = async (command) => {
    client.calls.push(command);
    if (commandName(command) === 'GetBucketLifecycleConfigurationCommand') {
      return {
        Rules: [
          { ID: 'someone-elses-rule', Status: 'Enabled', Filter: { Prefix: 'other-app/' }, Expiration: { Days: 30 } },
          // An older copy of this app's own rule, which must be replaced
          // by the fresh one below, not duplicated.
          { ID: 'pic-chatter-backstop', Status: 'Enabled', Filter: { Prefix: 'pic-chatter/' }, Expiration: { Days: 999 } }
        ]
      };
    }
    return {};
  };
  storage.__setClientForTests(client);

  await storage.ensureLifecyclePolicy();

  const putCommand = client.calls.find((c) => commandName(c) === 'PutBucketLifecycleConfigurationCommand');
  const rules = putCommand.input.LifecycleConfiguration.Rules;
  assert.equal(rules.length, 2, 'the unrelated rule must be preserved alongside this app\'s own rule');
  const otherRule = rules.find((r) => r.ID === 'someone-elses-rule');
  assert.ok(otherRule, 'a rule this app did not write must survive the merge untouched');
  assert.equal(otherRule.Expiration.Days, 30);
  const ownRules = rules.filter((r) => r.ID === 'pic-chatter-backstop');
  assert.equal(ownRules.length, 1, 'the stale copy of this app\'s own rule must be replaced, not duplicated');
  assert.equal(ownRules[0].Expiration.Days, 1, 'the fresh rule, not the stale 999-day one, must be the one that survives');

  delete process.env.STORE_IMAGES;
  delete process.env.STORE_LIFECYCLE_DAYS;
  storage.__resetForTests();
});

test('issue review fix: ensureLifecyclePolicy treats a missing lifecycle configuration as "no rules to preserve", but does not swallow a real error the same way', async () => {
  process.env.STORE_IMAGES = 'true';
  storage.__resetForTests();

  // A bucket with no lifecycle configuration at all: the real failure mode
  // this fallback exists for.
  const noConfigClient = makeFakeS3Client();
  noConfigClient.send = async (command) => {
    noConfigClient.calls.push(command);
    if (commandName(command) === 'GetBucketLifecycleConfigurationCommand') {
      const err = new Error('The lifecycle configuration does not exist');
      err.name = 'NoSuchLifecycleConfiguration';
      throw err;
    }
    return {};
  };
  storage.__setClientForTests(noConfigClient);
  await storage.ensureLifecyclePolicy();
  const putCommand = noConfigClient.calls.find((c) => commandName(c) === 'PutBucketLifecycleConfigurationCommand');
  assert.ok(putCommand, 'a missing lifecycle configuration must still let the app set its own rule');
  assert.equal(putCommand.input.LifecycleConfiguration.Rules.length, 1);

  // A real failure (e.g. AccessDenied, a throttling error, a transient
  // 5xx): swallowing this the same way as "no config exists" is exactly
  // the bug this test guards against, since it would then PUT a
  // single-rule configuration over whatever rules actually exist but
  // could not be read, silently destroying them.
  storage.__resetForTests();
  const deniedClient = makeFakeS3Client();
  deniedClient.send = async (command) => {
    deniedClient.calls.push(command);
    if (commandName(command) === 'GetBucketLifecycleConfigurationCommand') {
      const err = new Error('Access Denied');
      err.name = 'AccessDenied';
      throw err;
    }
    return {};
  };
  storage.__setClientForTests(deniedClient);
  await assert.rejects(storage.ensureLifecyclePolicy(), /Access Denied/);
  const putAfterDenied = deniedClient.calls.find((c) => commandName(c) === 'PutBucketLifecycleConfigurationCommand');
  assert.equal(putAfterDenied, undefined, 'a real Get failure must never result in overwriting the bucket\'s lifecycle rules blind');

  delete process.env.STORE_IMAGES;
  storage.__resetForTests();
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
