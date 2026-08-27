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
  console.error("Business Finlynq authentication email worker stopped", {
    error: error instanceof Error ? error.message : "unknown worker error",
  });
  process.exitCode = 1;
});
