import "server-only";

import { createConnection } from "node:net";
import { MAX_EVIDENCE_BYTES } from "@/modules/subledger/evidence-model";

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
    const deadline = setTimeout(() => finish(new Error("Evidence scanner timed out")), 15_000);
    socket.on("error", () => finish(new Error("Evidence scanning is unavailable")));
    socket.on("end", () => finish(new Error("Evidence scanner response was incomplete")));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2048) return finish(new Error("Evidence scanner response was invalid"));
      const terminator = output.indexOf("\0");
      if (terminator >= 0) finish(undefined, output.slice(0, terminator));
    });
    socket.on("connect", () => {
      socket.write(`z${command}\0`);
      if (bytes) {
        // Bound both the accepted file and each protocol chunk.
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}

export async function scanEvidence(bytes: Buffer): Promise<{ version: string; scannedAt: string }> {
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) throw new Error("Invalid evidence size");
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
