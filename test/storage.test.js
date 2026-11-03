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
