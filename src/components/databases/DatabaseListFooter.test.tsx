import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { DatabaseListFooter, type DatabaseListFooterProps } from "./DatabaseListFooter";

const i18nState = vi.hoisted(() => ({ language: "en-US" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { resolvedLanguage: i18nState.language, language: i18nState.language },
  }),
}));

installMatchMediaStub();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18nState.language = "en-US";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function renderFooter(overrides: Partial<DatabaseListFooterProps> = {}) {
  const props: DatabaseListFooterProps = {
    mode: "paged",
    page: 1,
    recordsPerPage: 25,
    shownCount: 25,
    totalRecords: 60,
    onPageChange: vi.fn(),
    onRecordsPerPageChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <DatabaseListFooter {...props} />
      </MantineProvider>,
    );
  });
  return props;
}

test("stays mounted with zero rows and offers 10, 25, 50 and All in the menu", async () => {
  const onRecordsPerPageChange = vi.fn();
  await renderFooter({ shownCount: 0, totalRecords: 0, onRecordsPerPageChange });
  expect(host.textContent).toContain("Common.RecordsPerPage");
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.textContent).toBe("25");

  await act(async () => trigger.click());
  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["10", "25", "50", "Common.All"]);
  expect(items[1].disabled).toBe(true);
  expect(items[1].classList.contains("mantine-datatable-page-size-selector-active")).toBe(true);

  await act(async () => items[3].click());
  expect(onRecordsPerPageChange).toHaveBeenCalledExactlyOnceWith("all");
});

test("renders count line, bound notice only when set, and Retry for failures in All mode", async () => {
  const onRetry = vi.fn();
  await renderFooter({
    mode: "all",
    shownCount: 100,
    totalRecords: 250,
    boundReachedWithMore: false,
    error: new Error("chunk failed"),
    onRetry,
  });
  expect(host.textContent).toContain('Databases.List.ShowingOf:{"shown":"100","total":"250"}');
  expect(host.textContent).not.toContain("Databases.List.BoundReached");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Databases.LoadError.Title");

  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Common.Retry",
  )!;
  await act(async () => retry.click());
  expect(onRetry).toHaveBeenCalledOnce();

  await renderFooter({
    mode: "all",
    shownCount: 10_000,
    totalRecords: 12_442_675,
    boundReachedWithMore: true,
    error: undefined,
  });
  expect(host.textContent).toContain(
    'Databases.List.ShowingOf:{"shown":"10,000","total":"12,442,675"}',
  );
  expect(host.textContent).toContain('Databases.List.BoundReached:{"max":"10,000"}');
});

test("renders ShowingCount in All mode when totalRecords is null and rows are shown", async () => {
  await renderFooter({
    mode: "all",
    shownCount: 1_234,
    totalRecords: null,
    error: undefined,
  });
  expect(host.textContent).toContain('Databases.List.ShowingCount:{"shown":"1,234"}');
  expect(host.textContent).not.toContain("Databases.List.ShowingOf");
});

test("formats paged range and All-mode counts with the active i18n locale", async () => {
  await renderFooter({
    mode: "paged",
    page: 41,
    recordsPerPage: 25,
    shownCount: 25,
    totalRecords: 12_442_675,
  });
  expect(host.textContent).toContain("1,001 - 1,025 / 12,442,675");

  i18nState.language = "de-DE";
  await renderFooter({
    mode: "paged",
    page: 41,
    recordsPerPage: 25,
    shownCount: 25,
    totalRecords: 12_442_675,
  });
  expect(host.textContent).toContain("1.001 - 1.025 / 12.442.675");

  await renderFooter({
    mode: "all",
    shownCount: 10_000,
    totalRecords: 12_442_675,
    boundReachedWithMore: true,
  });
  expect(host.textContent).toContain(
    'Databases.List.ShowingOf:{"shown":"10.000","total":"12.442.675"}',
  );
  expect(host.textContent).toContain('Databases.List.BoundReached:{"max":"10.000"}');
});
