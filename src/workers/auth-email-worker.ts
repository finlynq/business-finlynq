import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { deliverNextAuthenticationEmail } from "@/modules/identity/email-delivery";
import { loadEmailDeliveryConfiguration } from "@/modules/identity/email-provider";
import { heartbeatEmailDeliveryWorker } from "@/modules/identity/auth-store";

const workerId = randomUUID();
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function main(): Promise<void> {
  loadEmailDeliveryConfiguration();
  while (!stopping) {
    await heartbeatEmailDeliveryWorker(workerId);
    const delivered = await deliverNextAuthenticationEmail(workerId);
    if (!delivered) await delay(2_000);
  }
}

main().catch((error) => {
  const errorType = error instanceof TypeError
    ? "TypeError"
    : error instanceof RangeError
      ? "RangeError"
      : error instanceof SyntaxError
        ? "SyntaxError"
        : error instanceof Error
          ? "Error"
          : "Unknown";
  console.error(JSON.stringify({
    event: "job.failure",
    job: "authentication-email-delivery",
    errorType,
  }));
  process.exitCode = 1;
});
