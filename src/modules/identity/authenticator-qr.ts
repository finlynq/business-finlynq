import "server-only";
import QRCode from "qrcode";

export async function authenticatorQrCodeDataUrl(enrollmentUri: string): Promise<string> {
  const parsed = new URL(enrollmentUri);
  if (parsed.protocol !== "otpauth:") {
    throw new Error("Invalid authenticator enrollment URI");
  }
  return QRCode.toDataURL(enrollmentUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
    color: { dark: "#13243BFF", light: "#FFFFFFFF" },
  });
}
