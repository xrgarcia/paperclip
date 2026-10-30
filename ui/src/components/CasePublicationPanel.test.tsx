// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CasePublicationPanel } from "./CasePublicationPanel";

const mockCasesApi = vi.hoisted(() => ({
  listPublished: vi.fn(),
  publishDocument: vi.fn(),
  withdrawDocument: vi.fn(),
}));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}

const REV = "df44502a-b0f4-4fcb-bcba-8cf023307b03";
const documents = [{ key: "agent-runtime", latestRevisionId: REV, latestRevisionNumber: 1 }];

describe("CasePublicationPanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    for (const fn of Object.values(mockCasesApi)) fn.mockReset();
    mockCasesApi.listPublished.mockResolvedValue({ companyId: "co", generatedAt: "", documents: [] });
  });
  afterEach(() => container.remove());

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CasePublicationPanel caseIdentifier="SLA-C1" companyId="co" documents={documents} />
        </QueryClientProvider>,
      );
    });
    await flush();
    return root;
  }

  function button(text: string) {
    return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  }

  async function type(value: string) {
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  }

  async function click(text: string) {
    act(() => button(text)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
  }

  it("renders both controls and the draft state", async () => {
    const root = await render();
    expect(button("Publish this revision")).toBeTruthy();
    expect(button("Withdraw")).toBeTruthy();
    expect(container.querySelector('[data-testid="publication-state-agent-runtime"]')?.textContent).toBe("Draft");
    act(() => root.unmount());
  });

  it("shows the published revision number from the published-documents read", async () => {
    mockCasesApi.listPublished.mockResolvedValue({
      companyId: "co",
      generatedAt: "",
      documents: [{ documentId: "d", caseId: "c", caseIdentifier: "SLA-C1", key: "agent-runtime", title: null, revisionId: REV, revisionNumber: 3, publishedAt: "" }],
    });
    const root = await render();
    expect(container.textContent).toContain("Published (rev 3)");
    act(() => root.unmount());
  });

  it("publish asks for a summary, then sends baseRevisionId and changeSummary", async () => {
    mockCasesApi.publishDocument.mockResolvedValue({ state: "published", key: "agent-runtime", revisionId: REV, revisionNumber: 1 });
    const root = await render();
    await click("Publish this revision");
    expect(button("Confirm publish")!.disabled).toBe(true);
    await type("  First slice  ");
    await click("Confirm publish");
    expect(mockCasesApi.publishDocument).toHaveBeenCalledWith("SLA-C1", "agent-runtime", {
      baseRevisionId: REV,
      changeSummary: "First slice",
    });
    act(() => root.unmount());
  });

  it("withdraw sends only changeSummary and shows Withdrawn", async () => {
    mockCasesApi.withdrawDocument.mockResolvedValue({ state: "withdrawn", key: "agent-runtime", revisionId: REV, revisionNumber: 1 });
    const root = await render();
    await click("Withdraw");
    await type("Superseded");
    await click("Confirm withdraw");
    expect(mockCasesApi.withdrawDocument).toHaveBeenCalledWith("SLA-C1", "agent-runtime", { changeSummary: "Superseded" });
    expect(container.querySelector('[data-testid="publication-state-agent-runtime"]')?.textContent).toBe("Withdrawn");
    act(() => root.unmount());
  });

  it("shows the gate's 403 message", async () => {
    mockCasesApi.publishDocument.mockRejectedValue(new ApiError("Only listed editors can change this case", 403, null));
    const root = await render();
    await click("Publish this revision");
    await type("Try");
    await click("Confirm publish");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Only listed editors can change this case");
    act(() => root.unmount());
  });
});
