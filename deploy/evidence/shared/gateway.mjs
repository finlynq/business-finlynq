import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const STREAM_LIMIT = 21 * 1024 * 1024;
export const CHANNELS = ['business-prod', 'business-stage', 'business-dev', 'consult-dev', 'consult-dev2', 'consult-stage'];

// Separate socket volumes grant access without connecting application networks.
// Clients may stream bytes or inspect VERSION, never execute other ClamD commands.
export async function startGateway({ root = '/channels', upstream = '/upstream/clamd.sock',
                                     timeoutMs = 45_000, channels = CHANNELS } = {}) {
  const active = { production: 0, nonproduction: 0 };
  const sockets = new Set();
  const servers = [];
  const write = (socket, bytes) => new Promise((resolve, reject) => {
    socket.write(bytes, error => error ? reject(error) : resolve());
  });
  const end = (socket, response) => socket.end(response, () => socket.destroy());

  async function handle(client, channel) {
    const pool = channel === 'business-prod' ? 'production' : 'nonproduction';
    const limit = pool === 'production' ? 2 : 1;
    if (active[pool] >= limit) {
      end(client, 'stream: capacity unavailable ERROR\0');
      return;
    }
    active[pool]++;
    sockets.add(client);
    let engine;
    const timer = setTimeout(() => { client.destroy(); engine?.destroy(); }, timeoutMs);
    const clientClosed = () => engine?.destroy();
    client.once('close', clientClosed);
    try {
      const iterator = client[Symbol.asyncIterator]();
      let pending = Buffer.alloc(0);
      async function read(size) {
        const parts = [];
        let left = size;
        while (left) {
          if (!pending.length) {
            const value = await iterator.next();
            if (value.done) throw new Error('incomplete input');
            pending = value.value;
          }
          const count = Math.min(left, pending.length);
          parts.push(pending.subarray(0, count));
          pending = pending.subarray(count);
          left -= count;
        }
        return Buffer.concat(parts, size);
      }
      const command = [];
      while (command.length < 12) {
        const byte = (await read(1))[0];
        command.push(byte);
        if (byte === 0) break;
      }
      const name = Buffer.from(command).toString('latin1');
      if (name !== 'zVERSION\0' && name !== 'zINSTREAM\0') throw new Error('unsupported command');
      engine = net.createConnection({ path: upstream });
      engine.on('error', () => {});
      sockets.add(engine);
      await new Promise((resolve, reject) => {
        engine.once('connect', resolve);
        engine.once('error', reject);
        engine.once('close', () => reject(new Error('engine closed')));
      });
      await write(engine, Buffer.from(name));
      if (name === 'zINSTREAM\0') {
        let total = 0;
        while (true) {
          const header = await read(4);
          const count = header.readUInt32BE();
          if (count > 64 * 1024 || total + count > STREAM_LIMIT) throw new Error('stream limit');
          if (!count) {
            if (!total || pending.length) throw new Error('invalid stream ending');
            await write(engine, header);
            break;
          }
          total += count;
          const bytes = await read(count);
          await write(engine, header);
          await write(engine, bytes);
        }
      } else if (pending.length) throw new Error('trailing command');
      let response = Buffer.alloc(0);
      for await (const part of engine) {
        response = Buffer.concat([response, part]);
        if (response.length > 2048) throw new Error('response limit');
        const terminator = response.indexOf(0);
        if (terminator < 0) continue;
        if (terminator !== response.length - 1 || !/^[\x20-\x7e]+\x00$/.test(response.toString('latin1'))) {
          throw new Error('invalid response');
        }
        // Errors and limit responses remain errors. Applications require an
        // exact clean verdict and validate the loaded signature timestamp.
        await write(client, response);
        end(client);
        return;
      }
      throw new Error('incomplete response');
    } catch {
      if (!client.destroyed) end(client, 'stream: scan unavailable ERROR\0');
    } finally {
      clearTimeout(timer);
      client.removeListener('close', clientClosed);
      engine?.destroy();
      sockets.delete(engine);
      sockets.delete(client);
      active[pool]--;
    }
  }

  try {
    for (const channel of channels) {
      if (!CHANNELS.includes(channel)) throw new Error('invalid channel');
      const path = `${root}/${channel}/clamd.sock`;
      const previous = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (previous) {
        if (!previous.isSocket()) throw new Error('unsafe socket path');
        await unlink(path);
      }
      const server = net.createServer(client => {
        client.on('error', () => {});
        void handle(client, channel);
      });
      servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
      // Legacy Consult staging keeps UID 1001 and receives only supplemental
      // group 10001 plus its own read-only channel mount. No data chown is needed.
      await chmod(path, channel === 'consult-stage' ? 0o660 : 0o600);
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  return { active, async close() {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const gateway = await startGateway();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
    await gateway.close();
    process.exit(0);
  });
}
