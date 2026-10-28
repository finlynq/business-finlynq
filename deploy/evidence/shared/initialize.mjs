import { lstat, readdir, chmod, chown } from 'node:fs/promises';
import { CHANNELS } from './gateway.mjs';

// Only pristine, dedicated volumes may be initialized. Existing ownership must
// already match: this never repairs arbitrary directories or signature stores.
const paths = CHANNELS.map(channel => ({ path: `/channels/${channel}`, uid: 10001,
  gid: 10001, mode: 0o700 }));
paths.push({ path: '/upstream', uid: 100, gid: 101, mode: 0o770 },
           { path: '/signatures', uid: 100, gid: 101, mode: 0o700 });
for (const { path, uid, gid, mode } of paths) {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('unsafe volume');
  if (value.uid === uid && value.gid === gid && (value.mode & 0o777) === mode) continue;
  if (value.uid !== 0 || (await readdir(path)).length) throw new Error('volume is not pristine');
  await chmod(path, mode);
  await chown(path, uid, gid);
}
