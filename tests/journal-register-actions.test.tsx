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
  selectedEntityId: "30000000-0000-4000-8000-000000000020",
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
vi.mock("@/modules/workspace/entity-context", () => ({
  currentWorkspaceEntityContext: vi.fn(async () => ({
    options: [],
    selectedEntity: { id: mocks.selectedEntityId },
  })),
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
  debitFunctional: "100.00",
  creditFunctional: "100.00",
  sourceNumber: null,
  accountKeys: [{
    canonicalKey: "CA01.6100.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
    displayKey: "CA01.6100.MKT.0000",
    displaySegments: [
      { key: "entity", displayName: "Entity", code: "CA01" },
      { key: "account", displayName: "Account", code: "6100" },
      { key: "department", displayName: "Cost center", code: "MKT" },
      { key: "intercompany", displayName: "Intercompany", code: "0000" },
    ],
  }],
  accountPostings: [{
    canonicalKey: "CA01.6100.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
    displayKey: "CA01.6100.MKT.0000",
    displaySegments: [
      { key: "entity", displayName: "Entity", code: "CA01" },
      { key: "account", displayName: "Account", code: "6100" },
      { key: "department", displayName: "Cost center", code: "MKT" },
      { key: "intercompany", displayName: "Intercompany", code: "0000" },
    ],
    debitFunctional: "100.00",
    creditFunctional: "0.00",
    endingBalanceFunctional: "475.00",
    endingSide: "DEBIT" as const,
  }, {
    canonicalKey: "CA01.2000.0000.MKT.0000.0000.0000.0000.0000.0000.0000.0000.0000",
    displayKey: "CA01.2000.MKT.0000",
    displaySegments: [
      { key: "entity", displayName: "Entity", code: "CA01" },
      { key: "account", displayName: "Account", code: "2000" },
      { key: "department", displayName: "Cost center", code: "MKT" },
      { key: "intercompany", displayName: "Intercompany", code: "0000" },
    ],
    debitFunctional: "0.00",
    creditFunctional: "100.00",
    endingBalanceFunctional: "250.00",
    endingSide: "CREDIT" as const,
  }],
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
    expect(mocks.loadWorkspace).toHaveBeenCalledWith(
      mocks.principal,
      "",
      mocks.selectedEntityId,
      1,
    );
    const tree = elements(page);
    const actionElements = tree.filter((element) => element.type === JournalRegisterAction);
    const actions = actionElements.map((element) => (
      element.props as JournalRegisterActionProps
    ).action.kind);
    const hrefs = tree.flatMap((element) => {
      const href = (element.props as { href?: unknown }).href;
      return typeof href === "string" ? [href] : [];
    });
    const journalEvidenceLinks = tree.filter((element) => {
      const href = (element.props as { href?: unknown }).href;
      return typeof href === "string" && href.startsWith("/app/journals/") &&
        textContent(element) === "View journal entry";
    });

    expect(actions).toEqual(["post", "reverse"]);
    expect(hrefs).toContain("/app/receivables/invoices?q=INV-1001");
    expect(hrefs).toContain("/app/payables/bills?q=BILL-1001");
    expect(hrefs).toContain("/app/journals/30000000-0000-4000-8000-000000000002");
    expect(journalEvidenceLinks).toHaveLength(5);
    expect(textContent(page)).toContain("Journal debit");
    expect(textContent(page)).toContain("Journal credit");
    expect(textContent(page)).toMatch(/Ending balance\s+·\s+debit/);
    expect(textContent(page)).toMatch(/Ending balance\s+·\s+credit/);
    expect(textContent(page)).toContain("CAD 475.00");
    expect(textContent(page)).toContain("CAD 250.00");
    expect(textContent(page)).toContain("CA01.6100.MKT.0000");
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

  it("remounts post state with reversal defaults while preserving an existing reversal state boundary", async () => {
    const journalId = "30000000-0000-4000-8000-000000000099";
    const workspace = {
      demoOnly: true,
      readiness: "READY",
      canDraft: true,
      canPost: true,
      canReverse: true,
      reversalPeriods: [reversalPeriod],
    };
    mocks.loadWorkspace.mockResolvedValueOnce({
      ...workspace,
      journals: [{
        ...baseJournal,
        id: journalId,
        number: "Draft",
        description: "Transitioning manual journal",
        typeKey: "ledger.manual",
        ownerModule: "ledger",
        status: "DRAFT",
        expectedContentHash: "b".repeat(64),
        canPost: true,
        canReverse: false,
      }],
    });

    const postPage = await JournalsPage({ searchParams: Promise.resolve({}) });
    const postAction = elements(postPage).find((element) => element.type === JournalRegisterAction);
    expect(postAction?.key).toBe(`${journalId}:post`);

    const postedJournal = {
      ...baseJournal,
      id: journalId,
      number: "42",
      description: "Transitioning manual journal",
      typeKey: "ledger.manual",
      ownerModule: "ledger",
      status: "POSTED",
      expectedContentHash: null,
      canPost: false,
      canReverse: true,
    };
    mocks.loadWorkspace.mockResolvedValueOnce({
      ...workspace,
      reversalPeriods: [{ ...reversalPeriod }],
      journals: [postedJournal],
    });

    const reversePage = await JournalsPage({ searchParams: Promise.resolve({}) });
    const reverseAction = elements(reversePage).find((element) => element.type === JournalRegisterAction);
    expect(reverseAction?.key).toBe(`${journalId}:reverse`);
    expect(reverseAction?.key).not.toBe(postAction?.key);

    const reverseMarkup = renderToStaticMarkup(reverseAction);
    expect(reverseMarkup).toContain(`value="${reversalPeriod.id}" selected=""`);
    expect(reverseMarkup).toContain(`value="${reversalPeriod.defaultAccountingDate}"`);

    mocks.loadWorkspace.mockResolvedValueOnce({
      ...workspace,
      reversalPeriods: [{ ...reversalPeriod }],
      journals: [{ ...postedJournal }],
    });
    const refreshedReversePage = await JournalsPage({ searchParams: Promise.resolve({}) });
    const refreshedReverseAction = elements(refreshedReversePage)
      .find((element) => element.type === JournalRegisterAction);
    expect(refreshedReverseAction?.key).toBe(reverseAction?.key);
  });
});
