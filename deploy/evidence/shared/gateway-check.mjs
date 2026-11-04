import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { once } from 'node:events';
import { CHANNELS, startGateway } from './gateway.mjs';

const frame = bytes => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([Buffer.from('zINSTREAM\0'), size, bytes, Buffer.alloc(4)]);
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(`${tmpdir()}/scanner-gateway-`);
  for (const channel of CHANNELS) await mkdir(`${root}/${channel}`);
  const upstream = `${root}/engine.sock`;
  const engineSockets = new Set();
  const state = { requests: [], response: 'stream: OK\0', partial: false };
  const engine = net.createServer(socket => {
    engineSockets.add(socket);
    socket.on('close', () => engineSockets.delete(socket));
    socket.on('error', () => {});
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.toString() === 'zVERSION\0') {
        state.requests.push('VERSION');
        socket.end('ClamAV 1.4.3/12345/Wed Oct 28 00:00:00 2026\0');
      } else if (input.length >= 14 && input.subarray(0, 10).toString() === 'zINSTREAM\0') {
        const size = input.readUInt32BE(10);
        if (input.length === 18 + size && input.readUInt32BE(input.length - 4) === 0) {
          state.requests.push('INSTREAM');
          const reply = input.includes(Buffer.from('EICAR-STANDARD')) ? 'stream: Eicar-Test-Signature FOUND\0' : state.response;
          socket.end(state.partial ? reply.slice(0, -1) : reply);
        }
      }
    });
  });
  await new Promise(resolve => engine.listen(upstream, resolve));
  const gateway = await startGateway({ root, upstream, ...options });
  t.after(async () => {
    await gateway.close();
    for (const socket of engineSockets) socket.destroy();
    await new Promise(resolve => engine.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function connect(channel) {
    const socket = net.createConnection(`${root}/${channel}/clamd.sock`);
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  }
  async function request(channel, bytes) {
    const socket = await connect(channel);
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    const done = new Promise(resolve => socket.once('close', resolve));
    socket.write(bytes);
    await done;
    return Buffer.concat(chunks).toString();
  }
  return { root, gateway, state, connect, request };
}

test('all private channels stream exact verdicts and retain per-application socket permissions', async t => {
  const f = await fixture(t);
  for (const channel of CHANNELS) {
    assert.equal(await f.request(channel, frame(Buffer.from('Veltrix synthetic fixture'))), 'stream: OK\0');
    assert.equal((await stat(`${f.root}/${channel}/clamd.sock`)).mode & 0o777, channel === 'consult-stage' ? 0o660 : 0o600);
  }
  assert.match(await f.request('consult-dev', frame(Buffer.from('EICAR-STANDARD'))), / FOUND\0$/);
});

test('one non-production connection cannot consume either reserved production slot', async t => {
  const f = await fixture(t);
  const held = await f.connect('consult-dev');
  held.write('z');
  assert.doesNotMatch(await f.request('consult-stage', Buffer.from('zVERSION\0')), /^ClamAV /);
  assert.match(await f.request('business-prod', Buffer.from('zVERSION\0')), /^ClamAV /);
  const first = await f.connect('business-prod'); first.write('z');
  const second = await f.connect('business-prod'); second.write('z');
  assert.doesNotMatch(await f.request('business-prod', Buffer.from('zVERSION\0')), /^ClamAV /);
  assert.deepEqual(f.gateway.active, { production: 2, nonproduction: 1 });
  first.destroy(); second.destroy(); held.destroy();
});

test('commands, oversized chunks, trailing bytes and truncated streams fail closed', async t => {
  const f = await fixture(t, { timeoutMs: 60 });
  for (const input of [Buffer.from('zSHUTDOWN\0'), Buffer.from('zSCAN /etc/passwd\0'),
    Buffer.concat([Buffer.from('zINSTREAM\0'), Buffer.from([0, 1, 0, 1])]),
    Buffer.concat([frame(Buffer.from('Veltrix')), Buffer.from('extra')]), Buffer.from('zINSTREAM\0')]) {
    assert.notEqual(await f.request('business-dev', input), 'stream: OK\0');
  }
  assert.equal(f.state.requests.filter(name => name === 'INSTREAM').length, 0);
});

test('invalid and incomplete upstream replies never become a clean result', async t => {
  const f = await fixture(t);
  for (const response of ['stream: OK\0tail', 'x'.repeat(2049), 'stream: OK\n\0']) {
    f.state.response = response;
    assert.match(await f.request('business-stage', frame(Buffer.from('Veltrix'))), /ERROR\0$/);
  }
  f.state.response = 'stream: OK\0'; f.state.partial = true;
  assert.match(await f.request('business-stage', frame(Buffer.from('Veltrix'))), /ERROR\0$/);
});
