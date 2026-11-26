import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { boardLayoutFamily } from "@/state/layoutStorage";
import {
  activeTabAtom,
  practiceRunRequestFamily,
  practiceRunSummaryFamily,
  practiceSegmentGateFamily,
  practiceSessionEndAtom,
  practiceTabFamily,
  tabFamily,
  tabsAtom,
  timedRunAtom,
  timedRunLaunchAtom,
  type TimedRunLaunch,
} from "@/state/atoms";
import type { FileMetadata } from "@/components/files/file";
import { removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { tabStorage } from "@/state/store/tabStorage";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import TimedRunOwner, { TIMED_RUN_GATE_WAIT_MS } from "./TimedRunOwner";

const harness = vi.hoisted(() => ({
  store: null as ReturnType<typeof createStore> | null,
  liveSubs: 0,
  openFile: vi.fn(),
  closeTab: vi.fn(async () => undefined),
  dirty: new Map<string, boolean>(),
  treeStatus: new Map<string, "available" | "not-read" | "unreadable" | "unavailable">(),
  notify: vi.fn(),
}));

vi.mock("@/utils/openFile", () => ({
  openFile: (...args: unknown[]) => harness.openFile(...args),
}));
vi.mock("@/state/store/tree", () => ({
  getCachedTreeStore: (tabId: string) =>
    harness.dirty.has(tabId)
      ? { getState: () => ({ dirty: harness.dirty.get(tabId) }) }
      : undefined,
}));
vi.mock("@/components/tabs/TabCommands", () => ({
  useTabCommands: () => ({
    closeTab: harness.closeTab,
    selectTab: (tabId: string) => {
      const current = harness.store;
      if (!current) return;
      if (!current.get(tabsAtom).some((tab) => tab.value === tabId)) return;
      current.set(activeTabAtom, tabId);
    },
    tabs: [],
    activeTab: null,
    showTab: vi.fn(),
    duplicateTab: vi.fn(),
    renameTab: vi.fn(),
    reorderTabs: vi.fn(),
    newTab: vi.fn(),
    pageTabs: [],
    showPageTab: vi.fn(),
    closePageTab: vi.fn(),
  }),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: harness.notify },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

function metadata(id: string): FileMetadata {
  return {
    type: "file",
    handle: { kind: "fileWorkspace", id: { id } },
    name: `${id}.pgn`,
    numGames: 1,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 0,
  };
}

function dueCandidate(fileId: string, positionKey: string, weight = 0.4) {
  return {
    file: fileWorkspaceKey(metadata(fileId).handle),
    game: 0,
    positionKey,
    kind: "due" as const,
    weight,
    dueAt: Date.now() - 1000,
    treeIndex: 0,
  };
}

function launch(partial: Partial<TimedRunLaunch> = {}): TimedRunLaunch {
  return {
    id: "run-1",
    deadline: Date.now() + 30 * 60 * 1000,
    startedAt: Date.now(),
    newTabId: "home",
    candidates: [dueCandidate("a", "a1", 0.4), dueCandidate("b", "b1", 0.2)],
    chapters: [
      { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
      { file: fileWorkspaceKey(metadata("b").handle), game: 0, metadata: metadata("b") },
    ],
    ...partial,
  };
}

function fileTab(id: string, fileId: string, game = 0) {
  return {
    value: id,
    name: fileId,
    type: "analysis" as const,
    gameOrigin: {
      kind: "file" as const,
      file: metadata(fileId),
      gameNumber: game,
    },
  };
}

function homeTab() {
  return {
    value: "home",
    name: "Home",
    type: "new" as const,
    gameOrigin: { kind: "none" as const },
  };
}

async function renderOwner() {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <TimedRunOwner />
      </Provider>,
    ),
  );
}

function admitOpenedTab(
  tabId: string,
  fileId: string,
  tabs: Array<ReturnType<typeof fileTab> | ReturnType<typeof homeTab>> = [],
) {
  const admitted = fileTab(tabId, fileId);
  store.set(tabsAtom, [admitted, ...tabs]);
  store.set(activeTabAtom, tabId);
  store.set(tabFamily(tabId), "practice");
  store.set(practiceTabFamily(tabId), "train");
  store.set(practiceSegmentGateFamily(tabId), { synced: true, status: "ready" });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function endSegment(
  tabId: string,
  reason: "queue-exhausted" | "deadline" | "stop",
  correct = 1,
) {
  const request = store.get(practiceRunRequestFamily(tabId));
  expect(request).toBeTruthy();
  await act(async () => {
    store.set(practiceSessionEndAtom, {
      runId: request!.runId,
      segmentId: request!.segmentId,
      reason,
      correct,
      incorrect: 0,
    });
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const tabId of [
    "tab-a",
    "tab-b",
    "tab-c",
    "tab-blocked",
    "existing-a",
    "tab-missing-gate",
    "tab-unreadable",
    "tab-unavailable",
    "tab-conflict",
  ]) {
    removeFileFreshness(tabId);
  }
  harness.dirty.clear();
  harness.treeStatus.clear();
  harness.liveSubs = 0;
  harness.openFile.mockReset();
  harness.closeTab.mockReset().mockResolvedValue(undefined);
  harness.notify.mockReset();
  vi.spyOn(tabStorage, "getStatus").mockImplementation((tabId: string) => {
    const kind = harness.treeStatus.get(tabId) ?? "available";
    if (kind === "unreadable") return { kind: "unreadable", rawValue: "" };
    if (kind === "unavailable") return { kind: "unavailable", error: new Error("unavailable") };
    if (kind === "not-read") return { kind: "not-read" };
    return { kind: "available" };
  });
  store = createStore();
  harness.store = store;
  const originalSub = store.sub.bind(store);
  store.sub = ((atom, listener) => {
    harness.liveSubs += 1;
    const unsub = originalSub(atom, listener);
    return () => {
      harness.liveSubs -= 1;
      unsub();
    };
  }) as typeof store.sub;
  store.set(tabsAtom, [homeTab()]);
  store.set(activeTabAtom, "home");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  harness.store = null;
  vi.restoreAllMocks();
});

test("advances to the next chapter after queue exhaustion and skips a failed open without selecting it again", async () => {
  const fileA = fileWorkspaceKey(metadata("a").handle);
  const fileB = fileWorkspaceKey(metadata("b").handle);
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (!file.name.startsWith("a")) return null;
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  expect(harness.openFile).toHaveBeenCalledTimes(1);
  expect(harness.openFile.mock.calls[0]?.[0]).toMatchObject({ name: "a.pgn" });
  // openFile selects Practice (and shows a hidden tab strip) in the run's own store.
  expect(harness.openFile.mock.calls[0]?.[2]).toMatchObject({ panel: "practice", store });
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(harness.notify.mock.calls[0]?.[0]).toMatchObject({
    message: "Board.Practice.SegmentSkipped",
  });
  expect(harness.openFile).toHaveBeenCalledTimes(2);
  expect(harness.openFile.mock.calls[1]?.[0]).toMatchObject({ name: "b.pgn" });
  const run = store.get(timedRunAtom);
  expect(run?.phase).toBe("finished");
  expect(run?.candidates.some((candidate) => candidate.file === fileB)).toBe(false);
  expect(run?.candidates.some((candidate) => candidate.file === fileA)).toBe(false);
  expect(store.get(practiceRunSummaryFamily("tab-a"))).toEqual({
    positions: 1,
    correct: 1,
    incorrect: 0,
    elapsedMs: expect.any(Number),
  });
});

test("Stop cancels the run", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await endSegment("tab-a", "stop", 0);
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
});

test("leaving the tab while a segment is waiting cancels the run", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a", [fileTab("other", "z")]);
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  expect(store.get(practiceRunRequestFamily("tab-a"))).toBeTruthy();
  await act(async () => {
    store.set(activeTabAtom, "other");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
});

test("reuses an already-open chapter tab without cancelling", async () => {
  const fileA = fileWorkspaceKey(metadata("a").handle);
  const existing = fileTab("existing-a", "a");
  store.set(tabsAtom, [homeTab(), existing, fileTab("foreign", "z")]);
  store.set(activeTabAtom, "home");
  store.set(tabFamily("existing-a"), "info");
  store.set(boardLayoutFamily("repertoire"), (prev) => ({ ...prev, tabsHidden: true }));
  store.set(practiceTabFamily("existing-a"), "build");
  store.set(practiceSegmentGateFamily("existing-a"), { synced: true, status: "ready" });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [{ file: fileA, game: 0, metadata: metadata("a") }],
      }),
    );
  });
  await flush();
  expect(harness.openFile).not.toHaveBeenCalled();
  expect(store.get(activeTabAtom)).toBe("existing-a");
  expect(store.get(tabFamily("existing-a"))).toBe("practice");
  expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(false);
  expect(store.get(practiceTabFamily("existing-a"))).toBe("train");
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  expect(store.get(practiceRunRequestFamily("existing-a"))).toBeTruthy();
});

test("a two-segment run closes the previous clean run-opened tab and keeps dirty or foreign tabs", async () => {
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (file.name.startsWith("a")) {
      admitOpenedTab("tab-a", "a", [fileTab("foreign", "z")]);
      return "tab-a";
    }
    admitOpenedTab("tab-b", "b", [fileTab("tab-a", "a"), fileTab("foreign", "z")]);
    return "tab-b";
  });
  await renderOwner();
  const baseline = harness.liveSubs;
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  const duringFirst = harness.liveSubs;
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.closeTab).toHaveBeenCalledWith("tab-a");
  expect(harness.closeTab).not.toHaveBeenCalledWith("foreign");
  expect(harness.liveSubs).toBeLessThanOrEqual(duringFirst);
  await endSegment("tab-b", "queue-exhausted", 1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
  expect(store.get(practiceRunSummaryFamily("tab-b"))).toMatchObject({
    positions: 2,
    correct: 2,
  });
  expect(harness.liveSubs).toBe(baseline);

  harness.closeTab.mockClear();
  harness.dirty.set("tab-a", true);
  store.set(timedRunAtom, null);
  store.set(timedRunLaunchAtom, null);
  store.set(practiceSessionEndAtom, null);
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (file.name.startsWith("a")) {
      admitOpenedTab("tab-a", "a");
      return "tab-a";
    }
    admitOpenedTab("tab-b", "b", [fileTab("tab-a", "a")]);
    return "tab-b";
  });
  await act(async () => {
    store.set(timedRunLaunchAtom, launch({ id: "run-dirty" }));
  });
  await flush();
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.closeTab).not.toHaveBeenCalled();
});

test("a run-opened tab reused by a later segment is still closed later", async () => {
  const fileA = fileWorkspaceKey(metadata("a").handle);
  const fileB = fileWorkspaceKey(metadata("b").handle);
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (file.name.startsWith("a")) {
      admitOpenedTab("tab-a", "a");
      return "tab-a";
    }
    admitOpenedTab("tab-b", "b", [fileTab("tab-a", "a")]);
    return "tab-b";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        deadline: Date.now() + 15_000,
        candidates: [
          { ...dueCandidate("a", "a1", 0.9), treeIndex: 0 },
          { ...dueCandidate("a", "a2", 0.8), treeIndex: 1 },
          { ...dueCandidate("b", "b1", 0.1), treeIndex: 0 },
        ],
        chapters: [
          { file: fileA, game: 0, metadata: metadata("a") },
          { file: fileB, game: 0, metadata: metadata("b") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.openFile).toHaveBeenCalledTimes(1);
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(1);
  expect(store.get(practiceRunRequestFamily("tab-a"))).toBeTruthy();
  expect(harness.closeTab).not.toHaveBeenCalled();
  expect(store.get(timedRunAtom)?.openedTabIds).toContain("tab-a");
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(2);
  expect(harness.closeTab).toHaveBeenCalledWith("tab-a");
});

test("cancel while opening aborts the open and creates no tab", async () => {
  store.set(tabsAtom, [homeTab(), fileTab("other", "z")]);
  store.set(activeTabAtom, "home");
  harness.openFile.mockImplementation(
    (_file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        const signal = options?.signal;
        if (!signal) return;
        if (signal.aborted) {
          resolve(null);
          return;
        }
        signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
  );
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.openFile).toHaveBeenCalled();
  await act(async () => {
    store.set(activeTabAtom, "other");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(store.get(tabsAtom).map((tab) => tab.value)).toEqual(["home", "other"]);
  expect(harness.openFile.mock.calls[0]?.[2]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
});

test("closing the run tab cancels the run", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await act(async () => {
    store.set(tabsAtom, [homeTab()]);
    store.set(activeTabAtom, "home");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
});

test("leaving Practice or Train cancels the run", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await act(async () => {
    store.set(tabFamily("tab-a"), "info");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");

  store.set(timedRunAtom, null);
  store.set(practiceSessionEndAtom, null);
  await act(async () => {
    store.set(timedRunLaunchAtom, launch({ id: "run-subtab" }));
  });
  await flush();
  await act(async () => {
    store.set(practiceTabFamily("tab-a"), "build");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
});

test("a read-failed or write-blocked gate skips the chapter once", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    store.set(practiceSegmentGateFamily("tab-a"), { synced: true, status: "read-failed" });
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
  expect(store.get(practiceRunRequestFamily("tab-a"))).toBeNull();

  harness.notify.mockClear();
  store.set(timedRunAtom, null);
  store.set(timedRunLaunchAtom, null);
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-blocked", "a");
    store.set(practiceSegmentGateFamily("tab-blocked"), {
      synced: true,
      status: "write-blocked",
    });
    return "tab-blocked";
  });
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        id: "run-write-blocked",
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
});

test("an unavailable file-freshness surface skips the chapter", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    store.set(practiceSegmentGateFamily("tab-a"), null);
    setFileFreshness("tab-a", "unavailable");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
});

test("a missing gate bound skips the chapter", async () => {
  vi.useFakeTimers();
  try {
    harness.openFile.mockImplementation(async () => {
      store.set(tabsAtom, [fileTab("tab-missing-gate", "a")]);
      store.set(activeTabAtom, "tab-missing-gate");
      store.set(tabFamily("tab-missing-gate"), "practice");
      store.set(practiceTabFamily("tab-missing-gate"), "train");
      return "tab-missing-gate";
    });
    await renderOwner();
    await act(async () => {
      store.set(
        timedRunLaunchAtom,
        launch({
          candidates: [dueCandidate("a", "a1")],
          chapters: [
            { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
          ],
        }),
      );
    });
    await flush();
    expect(store.get(timedRunAtom)?.phase).toBe("running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TIMED_RUN_GATE_WAIT_MS);
    });
    await flush();
    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(store.get(timedRunAtom)?.phase).toBe("finished");
  } finally {
    vi.useRealTimers();
  }
});

test("a stale driver of run 1 cannot cancel or overwrite run 2", async () => {
  let releaseFirst: ((value: string | null) => void) | undefined;
  harness.openFile.mockImplementation(
    async (file: FileMetadata, _setTabs, options?: { signal?: AbortSignal }) => {
      if (file.name.startsWith("a")) {
        return await new Promise<string | null>((resolve) => {
          releaseFirst = resolve;
          options?.signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
      }
      admitOpenedTab("tab-b", "b");
      return "tab-b";
    },
  );
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        id: "run-1",
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        id: "run-2",
        candidates: [dueCandidate("b", "b1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("b").handle), game: 0, metadata: metadata("b") },
        ],
      }),
    );
  });
  await flush();
  expect(store.get(timedRunAtom)?.id).toBe("run-2");
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  await act(async () => {
    releaseFirst?.(null);
  });
  await flush();
  expect(store.get(timedRunAtom)?.id).toBe("run-2");
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  expect(store.get(practiceRunRequestFamily("tab-b"))).toBeTruthy();
});

test("a stale session end for another run is ignored", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await act(async () => {
    store.set(practiceSessionEndAtom, {
      runId: "other-run",
      segmentId: "other-seg",
      reason: "stop",
      correct: 9,
      incorrect: 9,
    });
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  expect(store.get(practiceRunSummaryFamily("tab-a"))).toBeNull();
});

test("a skip after answers still puts the summary on the last segment tab", async () => {
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (!file.name.startsWith("a")) return null;
    admitOpenedTab("tab-a", "a");
    return "tab-a";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
  expect(store.get(practiceRunSummaryFamily("tab-a"))).toMatchObject({
    positions: 1,
    correct: 1,
  });
});

test("cancel while opening after answers still puts the summary on the last segment tab", async () => {
  store.set(tabsAtom, [homeTab(), fileTab("other", "z")]);
  store.set(activeTabAtom, "home");
  harness.openFile.mockImplementation(
    async (file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) => {
      if (file.name.startsWith("a")) {
        admitOpenedTab("tab-a", "a", [fileTab("other", "z")]);
        return "tab-a";
      }
      return await new Promise<string | null>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
    },
  );
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(2);
  await act(async () => {
    store.set(activeTabAtom, "other");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(store.get(practiceRunSummaryFamily("tab-a"))).toMatchObject({
    positions: 1,
    correct: 1,
  });
});

function hangUntilAbort(signal?: AbortSignal) {
  return new Promise<string | null>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

function openFileOwnerId(call: unknown[] | undefined) {
  return (call?.[2] as { ownerId?: string } | undefined)?.ownerId;
}

test("opening the next chapter does not cancel while a reused chapter tab is still active", async () => {
  const existing = fileTab("existing-a", "a");
  store.set(tabsAtom, [homeTab(), existing]);
  store.set(activeTabAtom, "home");
  store.set(tabFamily("existing-a"), "info");
  store.set(practiceTabFamily("existing-a"), "build");
  store.set(practiceSegmentGateFamily("existing-a"), { synced: true, status: "ready" });
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    admitOpenedTab("tab-b", "b", [existing]);
    expect(file.name).toBe("b.pgn");
    return "tab-b";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  expect(harness.openFile).not.toHaveBeenCalled();
  expect(store.get(activeTabAtom)).toBe("existing-a");
  expect(store.get(timedRunAtom)?.openedTabIds).toEqual([]);
  await endSegment("existing-a", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  expect(store.get(practiceRunRequestFamily("tab-b"))).toBeTruthy();
  expect(harness.closeTab).not.toHaveBeenCalled();
});

test("first openFile replaces New Tab with ownerId and a later open appends without it", async () => {
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (file.name.startsWith("a")) {
      admitOpenedTab("tab-a", "a");
      return "tab-a";
    }
    admitOpenedTab("tab-b", "b", [fileTab("tab-a", "a")]);
    return "tab-b";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  expect(openFileOwnerId(harness.openFile.mock.calls[0])).toBe("home");
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  expect(store.get(activeTabAtom)).toBe("tab-a");
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(openFileOwnerId(harness.openFile.mock.calls[1])).toBeUndefined();
  expect(store.get(timedRunAtom)?.phase).toBe("running");
});

test("activating an unrelated present tab during openFile cancels and aborts the child", async () => {
  store.set(tabsAtom, [homeTab(), fileTab("other", "z")]);
  store.set(activeTabAtom, "home");
  harness.openFile.mockImplementation(
    (_file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) =>
      hangUntilAbort(options?.signal),
  );
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  await act(async () => {
    store.set(activeTabAtom, "other");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(harness.openFile.mock.calls[0]?.[2]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
});

test("closing the origin tab during open leaves via the remaining neighbor", async () => {
  store.set(tabsAtom, [homeTab(), fileTab("other", "z")]);
  store.set(activeTabAtom, "home");
  harness.openFile.mockImplementation(
    (_file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) =>
      hangUntilAbort(options?.signal),
  );
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  await act(async () => {
    store.set(tabsAtom, [fileTab("other", "z")]);
    store.set(activeTabAtom, "other");
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(store.get(tabsAtom).map((tab) => tab.value)).toEqual(["other"]);
});

test("closing the only New Tab during first load cancels and does not replace", async () => {
  store.set(tabsAtom, [homeTab()]);
  store.set(activeTabAtom, "home");
  harness.openFile.mockImplementation(
    (_file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) =>
      hangUntilAbort(options?.signal),
  );
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.openFile).toHaveBeenCalled();
  await act(async () => {
    store.set(tabsAtom, []);
    store.set(activeTabAtom, null);
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(store.get(tabsAtom)).toEqual([]);
  expect(store.get(activeTabAtom)).toBeNull();
  expect(harness.openFile.mock.calls[0]?.[2]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
});

test.each([
  {
    name: "Practice panel",
    leave: () => store.set(tabFamily("tab-a"), "info"),
  },
  {
    name: "Train sub-tab",
    leave: () => store.set(practiceTabFamily("tab-a"), "build"),
  },
] as const)("leaving $name on the origin tab during a later load cancels", async ({ leave }) => {
  harness.openFile.mockImplementation(
    async (file: FileMetadata, _setTabs: unknown, options?: { signal?: AbortSignal }) => {
      if (file.name.startsWith("a")) {
        admitOpenedTab("tab-a", "a");
        return "tab-a";
      }
      return hangUntilAbort(options?.signal);
    },
  );
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await endSegment("tab-a", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(2);
  expect(store.get(timedRunAtom)?.phase).toBe("running");
  await act(async () => {
    leave();
  });
  await flush();
  expect(store.get(timedRunAtom)?.phase).toBe("cancelled");
  expect(harness.openFile.mock.calls[1]?.[2]).toMatchObject({
    signal: expect.objectContaining({ aborted: true }),
  });
});

test.each(["not-read", "unreadable", "unavailable"] as const)(
  "closePreviousIfOwned skips a %s previous tab and the run stays on the destination",
  async (status) => {
    harness.openFile.mockImplementation(async (file: FileMetadata) => {
      if (file.name.startsWith("a")) {
        admitOpenedTab("tab-a", "a");
        return "tab-a";
      }
      harness.treeStatus.set("tab-a", status);
      admitOpenedTab("tab-b", "b", [fileTab("tab-a", "a")]);
      return "tab-b";
    });
    await renderOwner();
    await act(async () => {
      store.set(timedRunLaunchAtom, launch());
    });
    await flush();
    await endSegment("tab-a", "queue-exhausted", 1);
    expect(harness.closeTab).not.toHaveBeenCalled();
    expect(store.get(timedRunAtom)?.phase).toBe("running");
    expect(store.get(activeTabAtom)).toBe("tab-b");
    expect(store.get(practiceRunRequestFamily("tab-b"))).toBeTruthy();
  },
);

test("closePreviousIfOwned never closes a tab the run did not open", async () => {
  const existing = fileTab("existing-a", "a");
  store.set(tabsAtom, [homeTab(), existing]);
  store.set(activeTabAtom, "home");
  store.set(tabFamily("existing-a"), "practice");
  store.set(practiceTabFamily("existing-a"), "train");
  store.set(practiceSegmentGateFamily("existing-a"), { synced: true, status: "ready" });
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-b", "b", [existing]);
    return "tab-b";
  });
  await renderOwner();
  await act(async () => {
    store.set(timedRunLaunchAtom, launch());
  });
  await flush();
  await endSegment("existing-a", "queue-exhausted", 1);
  expect(harness.closeTab).not.toHaveBeenCalled();
  expect(store.get(practiceRunRequestFamily("tab-b"))).toBeTruthy();
});

test("a failed first open still passes ownerId newTabId to the next openFile", async () => {
  const fileC = fileWorkspaceKey(metadata("c").handle);
  harness.openFile.mockImplementation(async (file: FileMetadata) => {
    if (file.name.startsWith("a")) return null;
    if (file.name.startsWith("b")) {
      admitOpenedTab("tab-b", "b", [homeTab(), fileTab("other", "z")]);
      return "tab-b";
    }
    admitOpenedTab("tab-c", "c", [homeTab(), fileTab("other", "z"), fileTab("tab-b", "b")]);
    return "tab-c";
  });
  store.set(tabsAtom, [homeTab(), fileTab("other", "z")]);
  store.set(activeTabAtom, "home");
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [
          dueCandidate("a", "a1", 0.4),
          dueCandidate("b", "b1", 0.2),
          dueCandidate("c", "c1", 0.1),
        ],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
          { file: fileWorkspaceKey(metadata("b").handle), game: 0, metadata: metadata("b") },
          { file: fileC, game: 0, metadata: metadata("c") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.openFile).toHaveBeenCalledTimes(2);
  expect(openFileOwnerId(harness.openFile.mock.calls[0])).toBe("home");
  expect(openFileOwnerId(harness.openFile.mock.calls[1])).toBe("home");
  expect(store.get(practiceRunRequestFamily("tab-b"))).toBeTruthy();
  await endSegment("tab-b", "queue-exhausted", 1);
  expect(harness.openFile).toHaveBeenCalledTimes(3);
  expect(openFileOwnerId(harness.openFile.mock.calls[2])).toBeUndefined();
});

test("an unreadable tree surface skips the chapter", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-unreadable", "a");
    store.set(practiceSegmentGateFamily("tab-unreadable"), null);
    harness.treeStatus.set("tab-unreadable", "unreadable");
    return "tab-unreadable";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
});

test("an unavailable tree surface skips the chapter", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-unavailable", "a");
    store.set(practiceSegmentGateFamily("tab-unavailable"), null);
    harness.treeStatus.set("tab-unavailable", "unavailable");
    return "tab-unavailable";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
});

test("a freshness conflict surface skips the chapter", async () => {
  harness.openFile.mockImplementation(async () => {
    admitOpenedTab("tab-conflict", "a");
    store.set(practiceSegmentGateFamily("tab-conflict"), null);
    setFileFreshness("tab-conflict", "conflict");
    return "tab-conflict";
  });
  await renderOwner();
  await act(async () => {
    store.set(
      timedRunLaunchAtom,
      launch({
        candidates: [dueCandidate("a", "a1")],
        chapters: [
          { file: fileWorkspaceKey(metadata("a").handle), game: 0, metadata: metadata("a") },
        ],
      }),
    );
  });
  await flush();
  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunAtom)?.phase).toBe("finished");
});
