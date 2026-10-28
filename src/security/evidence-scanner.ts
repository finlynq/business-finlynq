import "server-only";

import { createConnection } from "node:net";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";
import { MAX_CLOUD_DOCUMENT_BYTES } from "@/modules/document-storage/limits";

// Only operator-controlled endpoints are used. No user-supplied URLs or paths.
async function clamCommand(command: "VERSION" | "INSTREAM", bytes?: Buffer): Promise<string> {
  const host = process.env.EVIDENCE_SCANNER_HOST?.trim();
  const port = Number(process.env.EVIDENCE_SCANNER_PORT ?? "3310");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Evidence scanning is unavailable");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let output = "";
    let finished = false;
    const finish = (error?: Error, result?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const deadline = setTimeout(() => finish(new Error("Evidence scanner timed out")), bytes && bytes.length > 8 * 1024 * 1024 ? 45_000 : 15_000);
    socket.on("error", () => finish(new Error("Evidence scanning is unavailable")));
    socket.on("end", () => finish(new Error("Evidence scanner response was incomplete")));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2048) return finish(new Error("Evidence scanner response was invalid"));
      const terminator = output.indexOf("\0");
      if (terminator >= 0) {
        if (terminator !== output.length - 1 || !/^[\x20-\x7e]+\0$/.test(output)) {
          return finish(new Error("Evidence scanner response was invalid"));
        }
        finish(undefined, output.slice(0, terminator));
      }
    });
    socket.on("connect", () => {
      const write = (chunk: Buffer | string) => new Promise<void>((accept, deny) => {
        socket.write(chunk, error => error ? deny(error) : accept());
      });
      void (async () => {
        await write(`z${command}\0`);
        if (bytes) {
          // Preserve bounded chunks and honor backpressure from the shared gateway.
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const chunk = bytes.subarray(offset, offset + 64 * 1024);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            await write(size);
            await write(chunk);
          }
          await write(Buffer.alloc(4));
        }
      })().catch(() => finish(new Error("Evidence scanning is unavailable")));
    });
  });
}

export async function scanEvidence(bytes: Buffer, maximumBytes = MAX_EVIDENCE_BYTES): Promise<{ version: string; scannedAt: string }> {
  if (maximumBytes > MAX_CLOUD_DOCUMENT_BYTES || bytes.length < 1 || bytes.length > maximumBytes) throw new Error("Invalid evidence size");
  const version = await clamCommand("VERSION");
  // VERSION includes the signature database's timestamp. Refuse stale engines,
  // even if freshclam failed after the daemon started.
  const match = /^ClamAV [^/]+\/\d+\/(.+)$/.exec(version);
  const updatedAt = match ? Date.parse(match[1] + " UTC") : NaN;
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 7 * 86400_000 || updatedAt > Date.now() + 86400_000) {
    throw new Error("Evidence scanner signatures are unavailable or stale");
  }
  const result = await clamCommand("INSTREAM", bytes);
  if (result !== "stream: OK") {
    throw new Error(result.endsWith(" FOUND")
      ? "Evidence rejected by malware scanning"
      : "Evidence could not be completely scanned");
  }
  return { version, scannedAt: new Date().toISOString() };
}
