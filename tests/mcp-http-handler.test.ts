import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { handleMcpRequest } from "@/modules/mcp/server";

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }));
vi.mock("@/modules/mcp/oauth-store", async (original) => ({
  ...await original<typeof import("@/modules/mcp/oauth-store")>(),
  verifyAccessToken: async (token: string, resource: string) => {
    if (!["tenant-a", "tenant-b"].includes(token) || resource !== "https://business.example.test/mcp") {
      throw new Error("Invalid synthetic bearer token");
    }
    return { clientId: token, scopes: [], tokenExpiresAt: new Date(Date.now() + 60000) };
  },
}));
vi.mock("@/modules/mcp/connection-policy", async (original) => ({
  ...await original<typeof import("@/modules/mcp/connection-policy")>(),
  loadMcpAuthorizationSnapshot: mocks.snapshots,
}));
vi.mock("@/modules/mcp/tool-types", async (original) => ({
  ...await original<typeof import("@/modules/mcp/tool-types")>(),
  registerMcpTools: (server: McpServer, snapshot: { principal: { clientId: string } }) => {
    server.registerTool("synthetic_identity", { inputSchema: z.object({}) }, () => ({
      content: [{ type: "text", text: snapshot.principal.clientId }],
    }));
  },
}));

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://business.example.test");
  vi.stubEnv("BUSINESS_FINLYNQ_PUBLIC_URL", "");
  mocks.snapshots.mockReset().mockImplementation(async principal => ({ principal }));
});
afterEach(() => vi.unstubAllEnvs());

function request(token: string, method: string, params = {}) {
  return new Request("https://business.example.test/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("real MCP HTTP handler after the SDK security update", () => {
  it("keeps repeated and concurrent requests with the same RPC ID bound to their own principal", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const responses = await Promise.all(["tenant-a", "tenant-b"].map(async token => {
        const response = await handleMcpRequest(request(token, "tools/call", { name: "synthetic_identity", arguments: {} }));
        expect(response.status).toBe(200);
        return response.text();
      }));
      expect(responses[0]).toContain("tenant-a"); expect(responses[0]).not.toContain("tenant-b");
      expect(responses[1]).toContain("tenant-b"); expect(responses[1]).not.toContain("tenant-a");
    }
  });

  it("preserves supported cloud-upload body sizes and rejects oversized input before creating a server", async () => {
    const accepted = await handleMcpRequest(request("tenant-a", "ping", { _meta: { fixture: "x".repeat(5 * 1024 * 1024) } }));
    expect(accepted.status).toBe(200);
    const before = mocks.snapshots.mock.calls.length;
    const denied = await handleMcpRequest(request("tenant-a", "ping", { _meta: { fixture: "x".repeat(29 * 1024 * 1024) } }));
    expect(denied.status).toBe(413);
    expect(mocks.snapshots).toHaveBeenCalledTimes(before);
  });

  it("rejects invalid authentication before loading tenant tools", async () => {
    const response = await handleMcpRequest(request("invalid", "tools/list"));
    expect(response.status).toBe(401);
    expect(mocks.snapshots).not.toHaveBeenCalled();
  });
});
