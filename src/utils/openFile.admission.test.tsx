import { afterEach, expect, test, vi } from "vitest";
import { act, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, Provider, useAtomValue } from "jotai";

const mocks = vi.hoisted(() => ({
  readGame: vi.fn(),
  parsePGN: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return { ...actual, tauri: { ...actual.tauri, readGame: mocks.readGame } };
});

vi.mock("@/utils/chess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/chess")>();
  return { ...actual, parsePGN: mocks.parsePGN };
});

import { activeTabAtom, tabFamily, tabsAtom } from "@/state/atoms";
import { openFile } from "./openFile";
import { defaultTree } from "./treeReducer";
import type { Tab } from "./tabs";

const file = {
  type: "file" as const,
  name: "white.pgn",
  handle: { id: { id: "white" }, kind: "fileWorkspace" as const },
  numGames: 1,
  metadata: { type: "repertoire" as const, tags: [] },
  lastModified: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessionStorage.clear();
  vi.clearAllMocks();
});

test("opening a file a restored tab already shows renders the new tab first and keeps a panel selected on it", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.parsePGN.mockImplementation(async () => defaultTree());
  mocks.readGame.mockResolvedValue({
    pgn: '[Event "Repertoire"]\n\n1. e4 *',
    stamp: "a".repeat(64),
    revision: "device:inode:revision",
    present: true,
  });

  const store = createStore();
  // The restored tab of the same repertoire, active, with its side panel on Info.
  const restored: Tab = {
    name: "white.pgn",
    value: crypto.randomUUID(),
    type: "analysis",
    gameOrigin: { kind: "file", file, gameNumber: 0 },
  };
  store.set(tabsAtom, [restored], restored.value);
  expect(store.get(activeTabAtom)).toBe(restored.value);

  // Every committed board render, in order; the first one selects Practice on the tab it
  // shows, as a user clicking the panel tab right after the board appears does.
  const boardRenders: string[] = [];
  let navigateToBoard: (() => void) | null = null;

  function BoardPage({ activeTab }: { activeTab: string | null }) {
    const selected = useRef(false);
    useLayoutEffect(() => {
      if (activeTab === null) return;
      boardRenders.push(activeTab);
      if (!selected.current) {
        selected.current = true;
        store.set(tabFamily(activeTab), "practice");
      }
    }, [activeTab]);
    return null;
  }

  // Like `TabCommandsProvider`, the active-tab subscription lives above the routes and stays
  // mounted across the navigation; the board page receives the value it read.
  function App() {
    const activeTab = useAtomValue(activeTabAtom);
    const [path, setPath] = useState("/files");
    navigateToBoard = () => setPath("/");
    return path === "/" ? <BoardPage activeTab={activeTab} /> : null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <Provider store={store}>
        <App />
      </Provider>,
    ),
  );

  let id: string | null = null;
  await act(async () => {
    id = await openFile(file, (update, active) => store.set(tabsAtom, update, active), {
      store,
    });
    // `runTabCreation`'s onSuccess navigates to the board once the creation resolves.
    navigateToBoard!();
  });

  expect(id).not.toBeNull();
  expect(store.get(activeTabAtom)).toBe(id);
  expect(store.get(tabsAtom).map((tab) => tab.value)).toEqual([restored.value, id]);
  // No board render shows the restored tab; the first one already shows the new tab.
  expect(boardRenders).toEqual([id]);
  // The panel selection made on the first board render survives on the new tab.
  expect(store.get(tabFamily(id!))).toBe("practice");
  expect(store.get(tabFamily(restored.value))).toBe("info");
});
