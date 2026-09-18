import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MutationFeedback } from "@/app/_components/mutation-feedback.client";

describe("workspace mutation feedback", () => {
  it("renders a dismissible assertive error without changing the safe message", () => {
    const markup = renderToStaticMarkup(
      <MutationFeedback
        kind="error"
        message="The selected account could not be saved. Refresh and retry safely."
        onDismiss={() => undefined}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('data-testid="mutation-feedback"');
    expect(markup).toContain("The selected account could not be saved. Refresh and retry safely.");
    expect(markup).toContain('aria-label="Dismiss notification"');
  });

  it("keeps the shared notification fixed inside desktop and mobile viewports", () => {
    const css = readFileSync("src/app/globals.css", "utf8");

    expect(css).toMatch(/\.mutation-notification\s*\{[^}]*position:fixed/);
    expect(css).toMatch(/\.mutation-notification\s*\{[^}]*max-height:calc\(100dvh - 32px\)/);
    expect(css).toMatch(/@media \(max-width:580px\)\s*\{\s*\.mutation-notification\{[^}]*inset-inline:10px/);
  });
});
