import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18n } from "i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { catalogueI18n } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DatabaseCredit as Credit } from "@/utils/db";
import { DatabaseCredit, formatCreditRelease, InstalledDatabaseCredit } from "./DatabaseCredit";

const mocks = vi.hoisted(() => ({
  catalog: undefined as
    | Array<{ title: string; credit?: import("@/utils/db").DatabaseCredit }>
    | undefined,
  useDefaultDatabases: vi.fn(),
}));

vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return {
    ...actual,
    useDefaultDatabases: (opened: boolean) => {
      mocks.useDefaultDatabases(opened);
      return { defaultDatabases: mocks.catalog, error: undefined, isLoading: false };
    },
  };
});

const lumbra: Credit = {
  author: "Michael Jansen",
  website: "https://lumbrasgigabase.com",
  license: {
    name: "CC BY-NC-SA 4.0",
    url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  },
  release: "2025-06",
  convertedBy: "En Croissant",
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.catalog = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(i18n: I18n, node: React.ReactNode) {
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider env="test">{node}</MantineProvider>
      </I18nextProvider>,
    );
  });
}

function links() {
  return [...host.querySelectorAll("a")].map((anchor) => [
    anchor.textContent,
    anchor.getAttribute("href"),
    anchor.getAttribute("target"),
  ]);
}

test("formats the release month in the reader's language", () => {
  expect(formatCreditRelease("2025-06", "en-GB")).toBe("June 2025");
  expect(formatCreditRelease("2025-06", "de-DE")).toBe("Juni 2025");
  // UTC keeps the first of the month from sliding into May west of Greenwich.
  expect(formatCreditRelease("2025-01", "en-US")).toBe("January 2025");
});

test("names author, website, licence and the converted release with working links", async () => {
  await render(await catalogueI18n("en-GB"), <DatabaseCredit credit={lumbra} />);

  expect(host.textContent).toContain("By Michael Jansen · lumbrasgigabase.com");
  expect(host.textContent).toContain("Licence: CC BY-NC-SA 4.0");
  expect(host.textContent).toContain("June 2025 release, converted by the En Croissant project");
  expect(links()).toEqual([
    ["lumbrasgigabase.com", "https://lumbrasgigabase.com", "_blank"],
    ["CC BY-NC-SA 4.0", "https://creativecommons.org/licenses/by-nc-sa/4.0/", "_blank"],
  ]);
});

test("translates the credit with the shipped catalogue", async () => {
  await render(await catalogueI18n("de-DE"), <DatabaseCredit credit={lumbra} />);

  expect(host.textContent).toContain("Von Michael Jansen");
  expect(host.textContent).toContain("Lizenz: CC BY-NC-SA 4.0");
  expect(host.textContent).toContain("Ausgabe Juni 2025, konvertiert vom Projekt En Croissant");
});

test("leaves out release and converter lines the catalog does not state", async () => {
  const i18n = await catalogueI18n("en-US");
  await render(i18n, <DatabaseCredit credit={{ ...lumbra, release: undefined }} />);
  expect(host.textContent).toContain("Converted by the En Croissant project");
  expect(host.textContent).not.toContain("release");

  await render(i18n, <DatabaseCredit credit={{ ...lumbra, convertedBy: undefined }} />);
  expect(host.textContent).toContain("June 2025 release");
  expect(host.textContent).not.toContain("converted");

  await render(
    i18n,
    <DatabaseCredit credit={{ ...lumbra, release: undefined, convertedBy: undefined }} />,
  );
  expect(host.textContent).toContain("License: CC BY-NC-SA 4.0");
  expect(host.querySelectorAll("p")).toHaveLength(2);
});

test("an installed catalog download keeps its credit in the Library", async () => {
  mocks.catalog = [{ title: "Lumbra's Gigabase", credit: lumbra }, { title: "MillionBase" }];
  const i18n = await catalogueI18n("en-GB");

  await render(i18n, <InstalledDatabaseCredit database={{ filename: "Lumbra's Gigabase.db3" }} />);
  expect(host.textContent).toContain("Source");
  expect(host.querySelector('[data-testid="database-credit"]')?.textContent).toContain(
    "By Michael Jansen",
  );

  // A catalog entry without a credit, an imported database and a collection show nothing;
  // only a collection skips reading the catalog at all.
  for (const [database, readsCatalog] of [
    [{ filename: "MillionBase.db3" }, true],
    [{ filename: "0d6c0c8e-2f7b-4a35-9b5e-8f8d2b8b0c11.db3" }, true],
    [
      {
        filename: "Lumbra's Gigabase.db3",
        collection: {} as import("@/bindings").CollectionDescriptor,
      },
      false,
    ],
  ] as const) {
    mocks.useDefaultDatabases.mockClear();
    await render(i18n, <InstalledDatabaseCredit database={database} />);
    expect(host.querySelector('[data-testid="database-credit"]')).toBeNull();
    expect(host.textContent).not.toContain("Source");
    expect(mocks.useDefaultDatabases).toHaveBeenLastCalledWith(readsCatalog);
  }
});
