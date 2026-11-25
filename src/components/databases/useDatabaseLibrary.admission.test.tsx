import { act, useState, type ElementType, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider as JotaiProvider, createStore } from "jotai";
import { tabsAtom } from "@/state/atoms";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import { deserializeStorageValue } from "@/state/store/debouncedStorage";
import type { DatabaseList, SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseLibraryDetail } from "./DatabaseLibraryDetail";
import { DatabaseLibraryRow } from "./DatabaseLibraryRow";
import { useDatabaseLibrary } from "./useDatabaseLibrary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  report: vi.fn(),
  data: undefined as DatabaseList | undefined,
  mutate: vi.fn(),
  owner: { run: vi.fn(), supersede: vi.fn() },
}));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.report }));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({ data: mocks.data, owner: mocks.owner, mutate: mocks.mutate }),
  revalidateDatabaseList: vi.fn(),
  refreshDatabaseList: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({
    children,
    onClick,
    to,
    params,
  }: {
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
    to: string;
    params?: { databaseId: string };
  }) => (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        // TanStack composeHandlers ignores return values and honors preventDefault.
        if (!event.defaultPrevented) mocks.navigate({ to, params });
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("@mantine/core", () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Box: box,
    Badge: box,
    Divider: () => null,
    Group: box,
    Loader: () => null,
    Rating: () => null,
    Stack: box,
    Text: box,
    Tooltip: box,
    Checkbox: () => null,
    Textarea: () => null,
    TextInput: () => null,
    Button: ({
      component: Component = "button",
      children,
      onClick,
      to,
      params,
    }: {
      component?: ElementType;
      children: ReactNode;
      onClick?: (event: MouseEvent) => void;
      to?: string;
      params?: { databaseId: string };
    }) => (
      <Component onClick={onClick} to={to} params={params}>
        {children}
      </Component>
    ),
  };
});
vi.mock("@/components/common/ConfirmModal", () => ({ default: () => null }));
vi.mock("@/components/common/GenericCard", () => ({
  default: ({
    Header,
    onDoubleClick,
    footer,
  }: {
    Header: ReactNode;
    onDoubleClick: () => void;
    footer?: ReactNode;
  }) => (
    <div>
      <button data-card onDoubleClick={onDoubleClick}>
        {Header}
      </button>
      {footer}
    </div>
  ),
}));
// The catalog credit verifies the signed catalog natively; it has its own tests.
vi.mock("./DatabaseCredit", () => ({ InstalledDatabaseCredit: () => null }));
vi.mock("./AddDatabase", () => ({ default: () => null }));
vi.mock("./PlayerSearchInput", () => ({ PlayerSearchInput: () => null }));

const database: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "next" }, kind: "database" },
  filename: "next.db3",
  title: "Next database",
  description: "",
  player_count: 1,
  event_count: 1,
  game_count: 1,
  storage_size: "0",
  indexed: false,
};

function Harness() {
  const [selected, setSelected] = useState<string | null>("next");
  const library = useDatabaseLibrary(selected, setSelected);
  return (
    <>
      <button data-open onClick={() => library.openDatabase(database)}>
        Open
      </button>
      <DatabaseLibraryRow library={library} item={database} />
      <DatabaseLibraryDetail library={library} />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

test("New game in database detail creates an analysis draft for the selected database", async () => {
  const workspace = createStore();
  await act(async () =>
    root.render(
      <JotaiProvider store={workspace}>
        <Harness />
      </JotaiProvider>,
    ),
  );
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Databases.NewGame",
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(
    workspace
      .get(tabsAtom)
      .some(
        (tab) =>
          tab.type === "analysis" &&
          tab.gameOrigin.kind === "databaseDraft" &&
          tab.gameOrigin.database.id.id === database.file.id.id,
      ),
  ).toBe(true);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
});
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  activeDatabaseViewStore.setState(activeDatabaseViewStore.getInitialState(), true);
  mocks.data = {
    databases: [database],
    unread: [],
    workspaceFilenames: [],
    root: { id: { id: "root" }, kind: "databaseRoot" },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  sessionStorage.clear();
});

test.each(["openDatabase", "Explore", "Open button", "double-click"])(
  "%s refuses navigation with the real store and opens after retry",
  async (gesture) => {
    await act(async () =>
      root.render(
        <JotaiProvider>
          <Harness />
        </JotaiProvider>,
      ),
    );
    await act(async () => {
      activeDatabaseViewStore.getState().setDatabase({
        ...database,
        file: { id: { id: "previous" }, kind: "database" },
      });
    });
    const before = activeDatabaseViewStore.getState();
    const seeded = JSON.stringify({ state: before, version: 0 });
    sessionStorage.setItem("database-view", seeded);
    const nativeSetItem = Storage.prototype.setItem;
    const refused = vi.fn(() => {
      expect(activeDatabaseViewStore.getState()).toBe(before);
      expect(sessionStorage.getItem("database-view")).toBe(seeded);
      throw new DOMException("quota", "QuotaExceededError");
    });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (this === sessionStorage && key === "database-view") return refused();
        return nativeSetItem.call(this, key, value);
      });
    const open = () => {
      if (gesture === "Explore") host.querySelector<HTMLAnchorElement>("a")!.click();
      else if (gesture === "double-click")
        host
          .querySelector("[data-card]")!
          .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      else if (gesture === "Open button")
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === "Databases.OpenDatabase")!
          .click();
      else host.querySelector<HTMLButtonElement>("[data-open]")!.click();
    };
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await act(async () => open());
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(activeDatabaseViewStore.getState()).toBe(before);
        expect(sessionStorage.getItem("database-view")).toBe(seeded);
        expect(refused).toHaveBeenCalledTimes(attempt);
        expect(mocks.report).toHaveBeenCalledTimes(attempt);
      }
    } finally {
      setItem.mockRestore();
    }
    mocks.navigate.mockImplementation(() => {
      expect(activeDatabaseViewStore.getState().database).toEqual(database);
      expect(
        deserializeStorageValue<{ state: { database: SuccessDatabaseInfo } }>(
          sessionStorage.getItem("database-view")!,
        )?.state.database,
      ).toEqual(database);
    });
    await act(async () => open());
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/databases/$databaseId",
      params: { databaseId: "next" },
    });
    expect(mocks.report).toHaveBeenCalledTimes(2);
  },
);
