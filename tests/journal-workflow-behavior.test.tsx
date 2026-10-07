import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalWorkflowAction, JournalWorkflowEligibility } from "@/modules/ledger/journal-workflow-eligibility";

const harness = vi.hoisted(() => ({ states: [] as unknown[], index: 0, refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.index++;
    if (index >= harness.states.length) harness.states[index] = typeof initial === "function" ? initial() : initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = typeof value === "function" ? value(harness.states[index]) : value; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }));
import { JournalWorkflowControls } from "@/app/_components/journal-workflow-controls.client";

const journalId = "30000000-0000-4000-8000-000000000001";
const allowed = { allowed: true, reasonCode: null, reason: null };
const workflow: JournalWorkflowEligibility = { status: "SUBMITTED", contentHash: "a".repeat(64), approvalVersion: 3,
  actorIsCreator: true, independentApprovalRequired: true, manualPostingMode: "REVIEW_REQUIRED",
  actions: { submit: allowed, approve: allowed, post: allowed, withdraw: allowed, reject: allowed } };
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render(action: JournalWorkflowAction, current = workflow) {
  harness.index = 0;
  const controls = JournalWorkflowControls({ journalId, journalNumber: "Submitted", workflow: current });
  const child = elements(controls).find((element) => element.props.action === action)!;
  return (child.type as (props: Record<string, unknown>) => ReactNode)(child.props);
}
function change(node: ReactNode, type: string, value: Record<string, unknown>) {
  const target = elements(node).find((element) => element.type === type)!;
  (target.props.onChange as (event: unknown) => void)({ target: value });
}
function prepare(action: JournalWorkflowAction, current = workflow) {
  change(render(action, current), "textarea", { value: "Reviewed supporting accounting evidence." });
  change(render(action, current), "input", { checked: true });
  return render(action, current);
}
function submit(node: ReactNode) {
  const form = elements(node).find((element) => element.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
}
function message(node: ReactNode) {
  return elements(node).find((element) => typeof element.props.message === "string")?.props.message;
}
beforeEach(() => {
  harness.states = []; harness.index = 0; vi.clearAllMocks();
  vi.stubGlobal("fetch", harness.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("journal workflow interaction", () => {
  it("requires confirmation and sends the exact frozen version for approval before refreshing actions", async () => {
    harness.fetch.mockResolvedValue(new Response(JSON.stringify({ status: "APPROVED", idempotentReplay: false }), { status: 200 }));
    submit(render("approve"));
    expect(harness.fetch).not.toHaveBeenCalled();
    submit(prepare("approve"));
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
    const [url, options] = harness.fetch.mock.calls[0];
    expect(url).toBe(`/api/ledger/journals/${journalId}/approve`);
    expect(JSON.parse(options.body)).toEqual({ expectedContentHash: workflow.contentHash,
      expectedApprovalVersion: 3, reason: "Reviewed supporting accounting evidence." });
    expect(message(render("approve"))).toContain("Journal approved");
    submit(render("approve"));
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it("reuses the withdrawal request key after an uncertain response and refreshes a later current state", async () => {
    harness.fetch.mockRejectedValueOnce(new Error("connection interrupted"));
    submit(prepare("withdraw"));
    await vi.waitFor(() => expect(message(render("withdraw"))).toContain("The result is unknown"));
    const first = JSON.parse(harness.fetch.mock.calls[0][1].body);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "SUBMITTED", approvalVersion: 4, idempotentReplay: true }), { status: 200 }));
    submit(render("withdraw"));
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
    expect(JSON.parse(harness.fetch.mock.calls[1][1].body)).toEqual(first);
    expect(message(render("withdraw"))).toContain("already recorded");
  });

  it("posts an approved journal with its version and displays the assigned permanent number", async () => {
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "POSTED", journalNumber: 52 }), { status: 200 }));
    const approved = { ...workflow, status: "APPROVED" };
    submit(prepare("post", approved));
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
    expect(JSON.parse(harness.fetch.mock.calls[0][1].body)).toMatchObject({ expectedApprovalVersion: 3, expectedContentHash: workflow.contentHash });
    expect(message(render("post", approved))).toBe("Journal 52 was posted.");
  });

  it("refreshes a stale submission while keeping a safe server explanation", async () => {
    harness.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "STALE_VERSION", error: "Refresh and review the current version." }), { status: 409 }));
    submit(prepare("approve"));
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalledOnce());
    expect(message(render("approve"))).toBe("Refresh and review the current version.");
  });
});
