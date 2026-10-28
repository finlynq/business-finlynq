export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startInboundRetryWorker } = await import("@/modules/email/retry-worker");
    startInboundRetryWorker();
  }
}
