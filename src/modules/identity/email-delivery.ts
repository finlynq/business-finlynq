import { randomUUID } from "node:crypto";
import { decryptAuthPayload, decryptIdentityField } from "@/security/identity-secret";
import { renderAuthenticationEmail } from "./auth-email";
import {
  claimEmailDelivery,
  completeEmailDelivery,
  failEmailDelivery,
  type ClaimedEmail,
} from "./auth-store";
import { EmailDeliveryError, loadEmailDeliveryConfiguration, sendEmail } from "./email-provider";

function payloadFor(message: ClaimedEmail): Record<string, unknown> {
  if (!message.payload_ciphertext) return {};
  const plaintext = decryptAuthPayload(message.payload_ciphertext, "email-payload", message.outbox_id);
  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid authentication email payload");
  return parsed as Record<string, unknown>;
}

export async function deliverNextAuthenticationEmail(workerId = randomUUID()): Promise<boolean> {
  const configuration = loadEmailDeliveryConfiguration();
  const claimed = await claimEmailDelivery(workerId);
  if (!claimed) return false;
  try {
    const recipient = decryptIdentityField(claimed.email_ciphertext, "email", claimed.user_id);
    const template = renderAuthenticationEmail({
      templateType: claimed.template_type,
      payload: payloadFor(claimed),
      templateData: claimed.template_data,
    });
    const providerMessageId = await sendEmail({
      recipient,
      ...template,
      idempotencyKey: `business-finlynq/${claimed.outbox_id}`,
    }, configuration);
    if (!(await completeEmailDelivery(claimed.outbox_id, workerId, providerMessageId))) {
      throw new Error("Email outbox lease was lost after provider acceptance");
    }
  } catch (error) {
    const deliveryError = error instanceof EmailDeliveryError
      ? error
      : new EmailDeliveryError("delivery_processing", false);
    await failEmailDelivery(claimed.outbox_id, workerId, deliveryError.code, deliveryError.retryable);
  }
  return true;
}
