import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthenticatorEnrollmentSetup } from "@/app/_components/authenticator-enrollment.client";

describe("authenticator enrollment presentation", () => {
  it("shows a scannable QR image, copyable manual key, and native app link", () => {
    const markup = renderToStaticMarkup(<AuthenticatorEnrollmentSetup enrollment={{
      secret: "JBSWY3DPEHPK3PXP",
      enrollmentUri: "otpauth://totp/Business%20Finlynq%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXP",
      qrCodeDataUrl: "data:image/png;base64,qr-image",
    }} />);

    expect(markup).toContain('src="data:image/png;base64,qr-image"');
    expect(markup).toContain("QR code for authenticator setup");
    expect(markup).toContain("JBSWY3DPEHPK3PXP");
    expect(markup).toContain("Copy key");
    expect(markup).toContain('href="otpauth://totp/');
  });
});
