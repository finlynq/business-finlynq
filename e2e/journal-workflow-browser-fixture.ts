import { build } from "esbuild";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { JournalWorkflowEligibility } from "../src/modules/ledger/journal-workflow-eligibility";

export type WorkflowBrowserState = { journalId: string; journalNumber: string; workflow: JournalWorkflowEligibility };
let browserHtml: Promise<string> | undefined;

/** The real component in Chromium with a simulated transport boundary; no application test route or database bypass. */
async function bundleBrowserFixture(): Promise<string> {
  const root = resolve(__dirname, "..");
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    outfile: "journal-workflow-browser-fixture.js", loader: { ".css": "local-css" },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import { useEffect, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { JournalWorkflowControls } from "@/app/_components/journal-workflow-controls.client";
      function Fixture() {
        const [state, setState] = useState(null);
        useEffect(() => {
          const refresh = () => fetch("/__e2e__/journal-workflow/state").then(response => response.json()).then(setState);
          window.addEventListener("workflow-refresh", refresh);
          refresh();
          return () => window.removeEventListener("workflow-refresh", refresh);
        }, []);
        if (!state) return <p>Loading synthetic workflow</p>;
        return <main><h1>Journal {state.journalNumber}</h1>
          <p>Depreciation · SYNTHETIC-E2E · Browser transport boundary fixture</p>
          <p aria-label="Journal status">{state.workflow.status}</p>
          <JournalWorkflowControls {...state} />
        </main>;
      }
      createRoot(document.getElementById("root")).render(<Fixture />);
    ` },
    plugins: [{ name: "workflow-navigation-boundary", setup(bundler) {
      bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "workflow-boundary" }));
      bundler.onLoad({ filter: /.*/, namespace: "workflow-boundary" }, () => ({
        contents: 'export function useRouter() { return { refresh() { window.dispatchEvent(new Event("workflow-refresh")); } }; }', loader: "js",
      }));
    } }],
  });
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{--muted:#536170}body{font-family:Arial,sans-serif;padding:24px}button,input,textarea{font:inherit}textarea{min-height:70px}${css}</style></head><body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}

export async function installJournalWorkflowBrowserFixture(page: Page, initial: WorkflowBrowserState) {
  let current = initial;
  const html = await (browserHtml ??= bundleBrowserFixture());
  await page.route("**/__e2e__/journal-workflow/state", (route) => route.fulfill({ json: current }));
  await page.route("**/__e2e__/journal-workflow", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("/__e2e__/journal-workflow");
  return { setState(next: WorkflowBrowserState) { current = next; } };
}
