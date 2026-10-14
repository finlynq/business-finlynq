import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: React.ComponentProps<"a"> & { prefetch?: boolean }) => {
    void prefetch;
    return <a {...props} data-client-link="true" />;
  },
}));

import { RouteTabs } from "@/app/_components/route-tabs";

const tabs = [
  { key: "prepare", label: "Prepare return", href: "/app/tax" },
  { key: "history", label: "Filing history", href: "/app/tax?view=history" },
];

describe("tax workspace navigation", () => {
  it("uses document navigation for tax views while preserving ordinary client navigation elsewhere", () => {
    const tax = renderToStaticMarkup(<RouteTabs label="Tax views" active="history" tabs={tabs} documentNavigation />);
    const ordinary = renderToStaticMarkup(<RouteTabs label="Other views" active="history" tabs={tabs} />);
    expect(tax).toContain('href="/app/tax?view=history" aria-current="page"');
    expect(tax).not.toContain("data-client-link");
    expect(ordinary).toContain('data-client-link="true"');
  });
});
