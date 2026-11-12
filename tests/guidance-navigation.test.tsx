import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { parseUrl } from "next/dist/shared/lib/router/utils/parse-url";
import { renderToStaticMarkup } from "react-dom/server";
import { getServerUtils } from "next/dist/server/server-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import type { GuidanceFile, GuidanceScope } from "@/modules/agent-guidance/service";

const mocks = vi.hoisted(() => ({
  requireWorkspacePrincipal: vi.fn(),
  listGuidanceForPage: vi.fn(),
  readGuidanceForPage: vi.fn(),
}));

vi.mock("@/modules/workspace/access", () => ({
  requireWorkspacePrincipal: mocks.requireWorkspacePrincipal,
}));
vi.mock("@/modules/agent-guidance/service", () => ({
  listGuidanceForPage: mocks.listGuidanceForPage,
  readGuidanceForPage: mocks.readGuidanceForPage,
}));

import GuidanceSettingsPage from "@/app/(workspace)/settings/guidance/page";

const files: GuidanceFile[] = [
  { scope: "platform", path: "accounting/workflow.md", summary: "Shared workflow",
    content: "# Shared workflow content", version: 1, updatedAt: "2026-11-11T12:00:00Z" },
  { scope: "platform", path: "index.md", summary: "Shared index",
    content: "# Shared index content", version: 1, updatedAt: "2026-11-11T12:00:00Z" },
  { scope: "client", path: "accounting/tax-follow-up.md", summary: "Client follow-up",
    content: "# Client follow-up content", version: 5, updatedAt: "2026-11-11T12:00:00Z" },
  { scope: "client", path: "index.md", summary: "Client index",
    content: "# Client index content", version: 2, updatedAt: "2026-11-11T12:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspacePrincipal.mockResolvedValue({ sessionMode: "real" });
  mocks.listGuidanceForPage.mockResolvedValue(files);
  mocks.readGuidanceForPage.mockImplementation(async (_principal, scope, path) =>
    files.find((file) => file.scope === scope && file.path === path));
});

async function rewrittenSearchParams(href: string) {
  const rules = await nextConfig.rewrites!();
  const rewrites = Array.isArray(rules) ? { afterFiles: rules } : rules;
  const utils = getServerUtils({
    page: "/settings/guidance", basePath: "", pageIsDynamic: false,
    caseSensitive: false, rewrites,
  });
  const socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    const result = utils.handleRewrites(request, parseUrl(new URL(href, "https://example.test").href));
    expect(result.rewrittenParsedUrl.pathname).toBe("/settings/guidance");
    const query = { ...result.rewrittenParsedUrl.query };
    // Next removes rewrite parameter names before passing searchParams to pages.
    utils.filterInternalQuery(query, Object.keys(result.rewriteParams));
    if (Array.isArray(query.scope) || Array.isArray(query.path)) {
      throw new Error("Fixture links must select one guidance file");
    }
    return { scope: query.scope, path: query.path };
  } finally {
    socket.destroy();
  }
}

function libraryHref(markup: string, scope: GuidanceScope, path: string) {
  const expected = `/app/settings/guidance?scope=${scope}&amp;path=${encodeURIComponent(path)}`;
  expect(markup).toContain(`href="${expected}"`);
  return expected.replaceAll("&amp;", "&");
}

describe("guidance file navigation through workspace rewrites", () => {
  it.each(files)("opens $scope:$path from its rendered library link", async (file) => {
    const initial = renderToStaticMarkup(await GuidanceSettingsPage({ searchParams: Promise.resolve({}) }));
    const href = libraryHref(initial, file.scope, file.path);
    const query = await rewrittenSearchParams(href);
    expect(query).toMatchObject({ scope: file.scope, path: file.path });
    const markup = renderToStaticMarkup(await GuidanceSettingsPage({ searchParams: Promise.resolve(query) }));
    expect(mocks.requireWorkspacePrincipal).toHaveBeenCalledWith("/app/settings/guidance");
    expect(mocks.readGuidanceForPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionMode: "real" }), file.scope, file.path,
    );
    expect(markup).toContain(`<h2 id="guidance-file-title">${file.path}</h2>`);
    expect(markup).toContain(file.content);
    expect(markup).toContain(`href="/api/organization/guidance/file?scope=${file.scope}&amp;path=${encodeURIComponent(file.path)}"`);
  });

  it("keeps the client index as the default when no file is selected", async () => {
    const query = await rewrittenSearchParams("/app/settings/guidance");
    const markup = renderToStaticMarkup(await GuidanceSettingsPage({ searchParams: Promise.resolve(query) }));
    expect(markup).toContain("# Client index content");
    expect(mocks.readGuidanceForPage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "real" }), "client", "index.md",
    );
  });

  it("does not read a file outside the authorized library", async () => {
    const query = await rewrittenSearchParams("/app/settings/guidance?scope=client&path=private%2Funknown.md");
    await GuidanceSettingsPage({ searchParams: Promise.resolve(query) });
    expect(mocks.readGuidanceForPage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "real" }), "client", "index.md",
    );
  });
});
