import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { databaseHandleKey, NAME_SEARCH_DEBOUNCE_MS, type SuccessDatabaseInfo } from "@/utils/db";
import { useDatabaseLibrary } from "./useDatabaseLibrary";

const mocks = vi.hoisted(() => ({
  getPlayers: vi.fn(),
  getPlayer: vi.fn(),
  mergePlayers: vi.fn(),
  data: undefined as unknown,
  mutate: vi.fn(),
  owner: { run: vi.fn(), supersede: vi.fn() },
}));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({ data: mocks.data, mutate: mocks.mutate, owner: mocks.owner }),
  revalidateDatabaseList: vi.fn(),
}));
vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return { ...actual, tauri: { ...actual.tauri, ...mocks } };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/databases/fixture">{children}</a>,
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("./AddDatabase", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const database: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database" }, kind: "database" },
  filename: "games.db3",
  title: "Games",
  description: "",
  indexed: false,
  game_count: 3,
  player_count: 2,
  event_count: 1,
  storage_size: "0",
};
const players = [
  { id: 1, name: "Ada", elo: 2000, game_count: 1 },
  { id: 2, name: "Bea", elo: 2100, game_count: 1 },
];
let root: Root;
let host: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function Library() {
  const [selected, setSelected] = useState<string | null>(databaseHandleKey(database.file));
  return useDatabaseLibrary(selected, setSelected).detail;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.data = { databases: [database], unread: [] };
  mocks.getPlayers.mockResolvedValue({ data: players, count: 2 });
  mocks.getPlayer.mockImplementation(async (_file, id) =>
    players.find((player) => player.id === id),
  );
  mocks.mergePlayers.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.useRealTimers();
});

async function enterName(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(NAME_SEARCH_DEBOUNCE_MS));
}

async function selectPlayer(input: HTMLInputElement, name: string) {
  await enterName(input, name.slice(0, 1));
  const suggestion = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === name,
  );
  expect(suggestion).toBeDefined();
  await act(async () => suggestion!.click());
}

test("Merge requires two committed players and editing either selection disables it again", async () => {
  await act(async () =>
    root.render(
      <Provider store={createStore()}>
        <MantineProvider>
          <Library />
        </MantineProvider>
      </Provider>,
    ),
  );
  const inputs = host.querySelectorAll<HTMLInputElement>(".mantine-Autocomplete-input");
  const merge = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Databases.Settings.Merge",
  )!;
  expect(inputs).toHaveLength(2);
  expect(merge.disabled).toBe(true);
  await selectPlayer(inputs[0], "Ada");
  expect(merge.disabled).toBe(true);
  await selectPlayer(inputs[1], "Bea");
  expect(merge.disabled).toBe(false);

  for (const [input, name] of [
    [inputs[0], "Ada"],
    [inputs[1], "Bea"],
  ] as const) {
    await enterName(input, "Uncommitted name");
    expect(input.value).toBe("Uncommitted name");
    expect(merge.disabled).toBe(true);
    await act(async () => merge.click());
    expect(mocks.mergePlayers).not.toHaveBeenCalled();
    await selectPlayer(input, name);
    expect(merge.disabled).toBe(false);
  }
  await act(async () => merge.click());
  expect(mocks.mergePlayers).toHaveBeenCalledExactlyOnceWith(database.file, 1, 2);
  expect(merge.disabled).toBe(true);
  expect([...inputs].map((input) => input.value)).toEqual(["", ""]);
});
