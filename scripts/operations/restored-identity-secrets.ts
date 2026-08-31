import { decryptIdentityField } from "../../src/security/identity-secret";

const IDENTITY_ENVELOPE_PREFIX = "idv1:";
const SYNTHETIC_DEMO_IDENTITY = /^public-demo(?:-sandbox-[1-9][0-9]*)?$/;

export type RestoredIdentityCiphertextRow = Readonly<{
  id: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  is_demo: boolean;
}>;

export type RestoredIdentityVerification = Readonly<{
  encryptedIdentities: number;
  syntheticDemoIdentities: number;
}>;

function assertIdentityPlaintext(value: string): void {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Decrypted identity text is empty or contains control characters");
  }
}

/**
 * Verifies every restored user row without selecting by envelope prefix. The
 * original synthetic demo users are explicitly classified as non-secret
 * markers; every other row must use the supported authenticated envelope.
 */
export function verifyRestoredIdentityCiphertexts(
  rows: readonly RestoredIdentityCiphertextRow[],
  identitySecret: Buffer,
): RestoredIdentityVerification {
  let encryptedIdentities = 0;
  let syntheticDemoIdentities = 0;

  for (const row of rows) {
    if (!row.email_ciphertext.startsWith(IDENTITY_ENVELOPE_PREFIX)) {
      if (
        row.is_demo
        && row.display_name_ciphertext === null
        && SYNTHETIC_DEMO_IDENTITY.test(row.email_ciphertext)
      ) {
        syntheticDemoIdentities += 1;
        continue;
      }
      throw new Error("Restore contains an unsupported identity ciphertext envelope");
    }

    assertIdentityPlaintext(
      decryptIdentityField(row.email_ciphertext, "email", row.id, identitySecret),
    );
    if (row.display_name_ciphertext !== null) {
      if (!row.display_name_ciphertext.startsWith(IDENTITY_ENVELOPE_PREFIX)) {
        throw new Error("Restore contains an unsupported identity display-name envelope");
      }
      assertIdentityPlaintext(
        decryptIdentityField(row.display_name_ciphertext, "display-name", row.id, identitySecret),
      );
    }
    encryptedIdentities += 1;
  }

  return { encryptedIdentities, syntheticDemoIdentities };
}
