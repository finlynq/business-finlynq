import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  principal: {
    sessionId: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    organizationId: "20000000-0000-4000-8000-000000000003",
    membershipId: "20000000-0000-4000-8000-000000000004",
    organizationName: "Demo tenant",
    roleLabel: "Accountant",
    displayName: "Demo Accountant",
    initials: "DA",
    sessionMode: "demo" as const,
    authMethod: "DEMO_LINK" as const,
    expiresAt: new Date("2026-08-27T20:00:00Z"),
    mfaVerifiedAt: null,
    stepUpExpiresAt: null,
  },
  loadWorkspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/modules/identity/session", () => ({
  currentPrincipal: vi.fn(async () => mocks.principal),
}));
vi.mock("@/modules/ledger/tenant-workspace", () => ({
  loadTenantJournalWorkspace: mocks.loadWorkspace,
}));

import JournalsPage from "@/app/(workspace)/journals/page";
import {
  JournalRegisterAction,
  type JournalRegisterActionProps,
} from "@/app/_components/journal-register-action.client";

const reversalPeriod = {
  id: "40000000-0000-4000-8000-000000000001",
  ledgerId: "30000000-0000-4000-8000-000000000010",
  entityCode: "CA01",
  label: "August 2026",
  startsOn: "2026-08-01",
  endsOn: "2026-08-31",
  state: "OPEN" as const,
  defaultAccountingDate: "2026-08-27",
};

const baseJournal = {
  ledgerId: reversalPeriod.ledgerId,
  accountingDate: "2026-08-27",
  entityCode: "CA01",
  currency: "CAD",
  typeLabel: "Manual journal",
  correctionRoute: "/journals",
  amount: "100.00",
  sourceNumber: null,
  reversalOfNumber: null,
  reversedByNumber: null,
};

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (!isValidElement(node)) return "";
  return textContent((node as ReactElement<{ children?: ReactNode }>).props.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadWorkspace.mockResolvedValue({
    demoOnly: true,
    readiness: "READY",
    canDraft: true,
    canPost: true,
    canReverse: true,
    reversalPeriods: [reversalPeriod],
    journals: [
      {
        ...baseJournal,
        id: "30000000-0000-4000-8000-000000000001",
        number: "Draft",
        description: "Manual draft",
        typeKey: "ledger.manual",
        ownerModule: "ledger",
        status: "DRAFT",
        expectedContentHash: "a".repeat(64),
        canPost: true,
        canReverse: false,
      },
      {
        ...baseJournal,
        id: "30000000-0000-4000-8000-000000000002",
        number: "41",
        description: "Posted manual journal",
        typeKey: "ledger.manual",
        ownerModule: "ledger",
        status: "POSTED",
        expectedContentHash: null,
        canPost: false,
        canReverse: true,
      },
      {
        ...baseJournal,
        id: "30000000-0000-4000-8000-000000000003",
        number: "40",
        description: "Posted invoice INV-1001",
        typeKey: "receivables.sales-invoice",
        typeLabel: "Sales invoice",
        ownerModule: "receivables",
        correctionRoute: "/app/receivables/invoices",
        status: "POSTED",
        sourceNumber: "INV-1001",
        expectedContentHash: null,
        canPost: false,
        canReverse: false,
      },
      {
        ...baseJournal,
        id: "30000000-0000-4000-8000-000000000004",
        number: "39",
        description: "Posted bill BILL-1001",
        typeKey: "payables.supplier-bill",
        typeLabel: "Supplier bill",
        ownerModule: "payables",
        correctionRoute: "/app/payables/bills",
        status: "POSTED",
        sourceNumber: "BILL-1001",
        expectedContentHash: null,
        canPost: false,
        canReverse: false,
      },
      {
        ...baseJournal,
        id: "30000000-0000-4000-8000-000000000005",
        number: "38",
        description: "Already reversed journal",
        typeKey: "ledger.manual",
        ownerModule: "ledger",
        status: "POSTED",
        expectedContentHash: null,
        reversedByNumber: "42",
        canPost: false,
        canReverse: false,
      },
    ],
  });
});

describe("journal register actions", () => {
  it("renders only DTO-authorized manual actions and routes AR/AP ownership back to source", async () => {
    const page = await JournalsPage({ searchParams: Promise.resolve({}) });
    const tree = elements(page);
    const actionElements = tree.filter((element) => element.type === JournalRegisterAction);
    const actions = actionElements.map((element) => (
      element.props as JournalRegisterActionProps
    ).action.kind);
    const hrefs = tree.flatMap((element) => {
      const href = (element.props as { href?: unknown }).href;
      return typeof href === "string" ? [href] : [];
    });

    expect(actions).toEqual(["post", "reverse"]);
    expect(hrefs).toContain("/app/receivables/invoices?q=INV-1001");
    expect(hrefs).toContain("/app/payables/bills?q=BILL-1001");
    expect(textContent(page)).toContain("reversed by 42");
    expect(textContent(page).toLowerCase()).not.toContain("delete");
  });

  it("renders explicit irreversible confirmation for posting and reversal fields", () => {
    const postMarkup = renderToStaticMarkup(
      <JournalRegisterAction
        journalId="30000000-0000-4000-8000-000000000001"
        journalNumber="Draft"
        journalDescription="Manual draft"
        action={{ kind: "post", expectedContentHash: "a".repeat(64) }}
      />,
    );
    const reverseMarkup = renderToStaticMarkup(
      <JournalRegisterAction
        journalId="30000000-0000-4000-8000-000000000002"
        journalNumber="41"
        journalDescription="Posted manual journal"
        action={{ kind: "reverse", periods: [reversalPeriod] }}
      />,
    );

    expect(postMarkup).toContain("Confirm posting");
    expect(postMarkup).toContain("no delete or in-place edit");
    expect(postMarkup).toContain("disabled");
    expect(reverseMarkup).toContain("Reversal period");
    expect(reverseMarkup).toContain("Accounting date");
    expect(reverseMarkup).toContain("Audit reason");
    expect(reverseMarkup).toContain("Post full reversal");
    expect(reverseMarkup.toLowerCase()).not.toContain(">delete<");
  });
});
