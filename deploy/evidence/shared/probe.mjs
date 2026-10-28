// Synthetic runtime acceptance. Run inside the isolated test gateway; production
// use requires the separately approved operational verification window.
import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const block = Buffer.alloc(64 * 1024, 65);

async function request(channel, size, content) {
  const start = performance.now();
  const client = net.createConnection(`/channels/${channel}/clamd.sock`);
  const response = new Promise((resolve, reject) => {
    const parts = [];
    client.on('error', reject);
    client.on('data', part => parts.push(part));
    client.on('end', () => resolve(Buffer.concat(parts).toString('ascii')));
    client.on('close', () => resolve(Buffer.concat(parts).toString('ascii')));
  });
  // A refusal can arrive while writing. Attach a handler immediately so a busy
  // channel does not create an unhandled rejection before the writer stops.
  response.catch(() => {});
  const timer = setTimeout(() => client.destroy(new Error('scan deadline')), size > 8 * 1024 ** 2 ? 45_000 : 15_000);
  const write = bytes => new Promise((resolve, reject) => client.write(bytes, error => error ? reject(error) : resolve()));
  try {
    await write(Buffer.from('zINSTREAM\0'));
    for (let sent = 0; sent < size;) {
      const part = content ?? block.subarray(0, Math.min(block.length, size - sent));
      const header = Buffer.alloc(4); header.writeUInt32BE(part.length);
      await write(header); await write(part); sent += part.length;
    }
    await write(Buffer.alloc(4));
    return { reply: await response, milliseconds: performance.now() - start };
  } finally { clearTimeout(timer); client.destroy(); }
}

const results = [];
if (process.argv.includes('--load') || process.argv.includes('--production-load')) {
  const production = async () => {
    for (let i = 0; i < 32; i++) {
      const result = await request('business-prod', 2 * 1024 ** 2);
      assert.equal(result.reply, 'stream: OK\0'); results.push(result.milliseconds);
    }
  };
  const consult = async () => {
    for (let i = 0; i < 16; i++) assert.equal((await request('consult-dev', 21 * 1024 ** 2)).reply, 'stream: OK\0');
  };
  await Promise.all([production(), production(), ...(process.argv.includes('--load') ? [consult()] : [])]);
  results.sort((a, b) => a - b);
  console.log(JSON.stringify({ productionScans: results.length, maxMs: results.at(-1), p95Ms: results[Math.floor(results.length * .95)] }));
} else {
  for (const channel of ['business-prod', 'business-stage', 'business-dev', 'consult-dev', 'consult-dev2', 'consult-stage']) {
    assert.equal((await request(channel, 64 * 1024)).reply, 'stream: OK\0');
    assert.match((await request(channel, eicar.length, eicar)).reply, / FOUND\0$/);
  }
  assert.equal((await request('business-prod', 21 * 1024 ** 2)).reply, 'stream: OK\0');
  const oversized = await request('business-dev', 21 * 1024 ** 2 + 1).catch(() => ({ reply: '' }));
  assert.notEqual(oversized.reply, 'stream: OK\0');
  console.log('Six channels: clean/EICAR passed; 21 MiB accepted; oversized input refused.');
}
