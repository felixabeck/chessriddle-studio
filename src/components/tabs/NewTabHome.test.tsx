import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import type { RecentFile } from "@/state/atoms";

test.each(shippedCatalogues())(
  "new home labels resolve without fallback in $locale",
  async ({ locale }) => {
    const instance = await catalogueI18n(locale as SupportedLocale);
    for (const key of [
      "Home.RecentFiles.UntitledGame",
      "Home.DuePractice.Title",
      "Home.DuePractice.Total",
      "Home.DuePractice.Incomplete",
      "Home.DuePractice.LoadFailed",
      "Home.DuePractice.NothingDue",
    ]) {
      expect(instance.exists(key)).toBe(true);
      expect(instance.t(key, { positions: 7, repertoires: 2 })).not.toBe(key);
      expect(instance.t(key, { positions: 7, repertoires: 2 }).trim()).not.toBe("");
    }
    expect(instance.t("Home.DuePractice.Total", { positions: 7, repertoires: 2 })).toContain("7");
    expect(instance.t("Home.DuePractice.Total", { positions: 7, repertoires: 2 })).toContain("2");
  },
);

const fixtures = vi.hoisted(() => ({
  atoms: {
    activeTab: Symbol("active-tab"),
    addRecentFile: Symbol("add-recent-file"),
    deckFamily: Symbol("deck-family"),
    recentFiles: Symbol("recent-files"),
    updateRecentFiles: Symbol("update-recent-files"),
    tabFamily: Symbol("tab-family"),
    tabs: Symbol("tabs"),
  },
  countPgnGames: vi.fn(),
  getDbGame: vi.fn(),
  addRecentFile: vi.fn(),
  createTab: vi.fn(),
  importModal: vi.fn(),
  openFile: vi.fn(),
  notify: vi.fn(),
  readGames: vi.fn(),
  recentFiles: [] as RecentFile[],
  setRecentFiles: vi.fn(),
  setTabs: vi.fn((update) => {
    if (typeof update === "function") {
      return update([{ value: "new-tab", name: "Home", type: "new" }]);
    }
  }),
  storeSet: vi.fn(),
  dueStats: { due: 0, unseen: 0 },
  deckStatus: "ready" as "loading" | "ready" | "read-failed" | "write-pending" | "write-blocked",
  decks: {} as Record<
    string,
    { status: string; positions: Array<{ due: number; unseen: number }>; error?: unknown }
  >,
}));

import NewTabHome from "./NewTabHome";

vi.mock("@/platform/tauri", () => ({
  tauri: {
    countPgnGames: fixtures.countPgnGames,
    getDbGame: fixtures.getDbGame,
    readGames: fixtures.readGames,
  },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: fixtures.notify } }));
vi.mock("@/state/atoms", () => ({
  activeTabAtom: fixtures.atoms.activeTab,
  addRecentFileAtom: fixtures.atoms.addRecentFile,
  deckAtomFamily: ({ file }: { file: string }) => ({ file }),
  recentFilesAtom: fixtures.atoms.recentFiles,
  updateRecentFilesAtom: fixtures.atoms.updateRecentFiles,
  isDatabaseRecent: (file: RecentFile) => "kind" in file,
  recentFileKey: (file: RecentFile) =>
    "kind" in file
      ? JSON.stringify([file.database.id.id, file.linked?.signature ?? file.gameId])
      : file.handle.id.id,
  tabFamily: () => fixtures.atoms.tabFamily,
  tabsAtom: fixtures.atoms.tabs,
}));
vi.mock("jotai", () => ({
  atom: (read: unknown) => ({ read }),
  useAtom: (atom: symbol | { read?: (get: (key: { file: string }) => unknown) => unknown }) => {
    if (typeof atom === "object" && atom.read) {
      return [
        atom.read(
          ({ file }) => fixtures.decks[file] ?? { positions: [], status: fixtures.deckStatus },
        ),
        vi.fn(),
      ];
    }
    if (atom === fixtures.atoms.recentFiles) {
      return [fixtures.recentFiles, fixtures.setRecentFiles];
    }
    if (atom === fixtures.atoms.tabs) {
      return [[{ value: "new-tab", name: "Home", type: "new" }], fixtures.setTabs];
    }
    if (atom === fixtures.atoms.deckFamily) {
      return [{ positions: [], status: fixtures.deckStatus }, vi.fn()];
    }
    return [[], vi.fn()];
  },
  useSetAtom: (atom: symbol) =>
    atom === fixtures.atoms.updateRecentFiles ? fixtures.setRecentFiles : fixtures.addRecentFile,
  useStore: () => ({ set: fixtures.storeSet }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/utils/pathCapabilities", () => ({
  fileWorkspaceKey: (handle: { id: { id: string } }) => handle.id.id,
}));
vi.mock("@/components/files/opening", () => ({
  getStats: (positions: Array<{ due: number; unseen: number }>) =>
    positions[0] ?? fixtures.dueStats,
}));
vi.mock("@/utils/tabs", () => ({ createTab: fixtures.createTab }));
vi.mock("@/utils/files", () => ({ openFile: fixtures.openFile }));
vi.mock("./CreateRepertoireModal", () => ({ default: () => null }));
vi.mock("./ImportModal", () => ({
  default: (props: { ownerId: string }) => {
    fixtures.importModal(props);
    return null;
  },
}));
vi.mock("../icons/Chessboard", () => ({ default: () => null }));
vi.mock("@/components/files/FileIcon", () => ({ FileIcon: () => null }));
vi.mock("lucide-react", () => ({
  ChessKnight: () => null,
  Clock: () => null,
  FileInput: () => null,
  Puzzle: () => null,
  Target: () => null,
  Crosshair: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en-US" },
    t: (key: string, values?: unknown) => (values ? key + JSON.stringify(values) : key),
  }),
}));
vi.mock("@mantine/core", async () => {
  const element = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  );
  return {
    useMatches: (await import("@/tests/matchMedia")).baseResponsiveValue,
    Badge: element,
    Box: element,
    Button: element,
    Card: element,
    Group: element,
    ScrollArea: element,
    SimpleGrid: element,
    Stack: element,
    Text: element,
    Tooltip: element,
    UnstyledButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test.each(["count", "open"] as const)(
  "removes a missing recent on %s failure and still notifies",
  async (stage) => {
    await act(async () => root.render(<NewTabHome id="new-tab" />));
    const failure = {
      tag: "backend-error",
      category: "missing-resource",
      message: "The file was moved to the trash",
    };
    if (stage === "count") fixtures.countPgnGames.mockRejectedValueOnce(failure);
    else fixtures.openFile.mockRejectedValueOnce(failure);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-recent-file]")!.click(),
    );
    const update = fixtures.setRecentFiles.mock.calls.at(-1)![0];
    const newer = {
      ...fixtures.recentFiles[0],
      handle: { id: { id: "newer" }, kind: "fileWorkspace" },
    };
    expect(update([...fixtures.recentFiles, newer])).toEqual([newer]);
    expect(fixtures.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: failure.message }),
    );
  },
);

test("displays stored Unknown with a localized untitled label and date, keeping named rows", async () => {
  fixtures.recentFiles.push({
    ...fixtures.recentFiles[0],
    name: "Unknown",
    lastOpened: Date.UTC(2026, 9, 23),
    handle: { id: { id: "unknown" }, kind: "fileWorkspace" },
  });
  await act(async () => root.render(<NewTabHome id="new-tab" />));
  const rows = container.querySelectorAll("[data-recent-file]");
  expect(rows[0].textContent).toContain("stale");
  expect(rows[1].textContent).toContain("Home.RecentFiles.UntitledGame · Oct 23, 2026");
  expect(rows[1].textContent).not.toContain("Unknown");
  await act(async () => (rows[1] as HTMLButtonElement).click());
  expect(fixtures.openFile).toHaveBeenCalledWith(expect.anything(), fixtures.setTabs, {
    tabName: "Unknown",
    ownerId: "new-tab",
    store: expect.anything(),
  });
});

test("orders due repertoires by due plus unseen and recency, totals them, and reuses recent-open", async () => {
  fixtures.recentFiles = [
    "older",
    "highest",
    "newer",
    "hydrating",
    "failed",
    "blocked",
    "done",
  ].map((name, i) => ({
    name,
    type: "repertoire",
    handle: { id: { id: name }, kind: "fileWorkspace" },
    lastOpened: i,
  }));
  fixtures.decks = {
    older: { status: "ready", positions: [{ due: 2, unseen: 1 }] },
    highest: { status: "write-pending", positions: [{ due: 3, unseen: 2 }] },
    newer: { status: "ready", positions: [{ due: 1, unseen: 2 }] },
    hydrating: { status: "loading", positions: [] },
    failed: { status: "read-failed", positions: [] },
    blocked: {
      status: "write-blocked",
      positions: [{ due: 9, unseen: 1 }],
      error: new Error("write failed"),
    },
    done: { status: "ready", positions: [] },
  };
  await act(async () => root.render(<NewTabHome id="new-tab" />));
  const panel = container.querySelector("[data-home-due]")!;
  const rows = [...panel.querySelectorAll("[data-due-file]")];
  expect(rows.map((row) => row.textContent?.split("Board.")[0])).toEqual([
    "highest5 ",
    "newer3 ",
    "older3 ",
    "blockedHome.DuePractice.LoadFailed",
    "failedHome.DuePractice.LoadFailed",
  ]);
  expect(panel.textContent).toContain('Home.DuePractice.Total{"positions":11,"repertoires":3}');
  expect(panel.textContent).toContain("Home.DuePractice.Incomplete");
  expect(panel.textContent).not.toContain("Home.DuePractice.NothingDue");
  expect(panel.textContent).not.toContain("hydrating");
  await act(async () => rows[0].querySelector<HTMLElement>(":scope > :last-child")!.click());
  expect(fixtures.openFile).toHaveBeenCalledWith(
    expect.objectContaining({ name: "highest", metadata: { type: "repertoire", tags: [] } }),
    fixtures.setTabs,
    { tabName: "highest", ownerId: "new-tab", store: expect.anything(), panel: "practice" },
  );
});

test.each(["ready", "loading", "read-failed", "write-blocked"] as const)(
  "shows nothing due only for fully loaded decks: %s",
  async (status) => {
    fixtures.deckStatus = status;
    (fixtures.recentFiles[0] as Extract<RecentFile, { handle: unknown }>).type = "repertoire";
    await act(async () => root.render(<NewTabHome id="new-tab" />));
    const panel = container.querySelector("[data-home-due]")!;
    expect(panel.textContent?.includes("Home.DuePractice.NothingDue")).toBe(status === "ready");
    expect(panel.textContent?.includes("Home.DuePractice.LoadFailed")).toBe(
      status === "read-failed" || status === "write-blocked",
    );
    expect(panel.textContent?.includes("Common.Loading")).toBe(status === "loading");
    expect(panel.textContent?.includes("Home.DuePractice.Total")).toBe(
      status === "read-failed" || status === "write-blocked",
    );
    expect(panel.textContent?.includes("Home.DuePractice.Incomplete")).toBe(
      status === "read-failed" || status === "write-blocked",
    );
  },
);

let container: HTMLDivElement;
let root: Root;

test("treats an error-bearing terminal deck as failed even with retained positions", async () => {
  (fixtures.recentFiles[0] as Extract<RecentFile, { handle: unknown }>).type = "repertoire";
  fixtures.decks.stale = {
    status: "ready",
    positions: [{ due: 9, unseen: 1 }],
    error: new Error("deck failed"),
  };
  await act(async () => root.render(<NewTabHome id="new-tab" />));
  const panel = container.querySelector("[data-home-due]")!;
  expect(panel.querySelectorAll("[data-due-file]")).toHaveLength(1);
  expect(panel.textContent).toContain("Home.DuePractice.LoadFailed");
  expect(panel.textContent).toContain('Home.DuePractice.Total{"positions":0,"repertoires":0}');
  expect(panel.textContent).toContain("Home.DuePractice.Incomplete");
  expect(panel.textContent).not.toContain("Common.Loading");
  expect(panel.textContent).not.toContain("Board.Practice.Due");
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.recentFiles = [
    {
      name: "stale.pgn",
      handle: { id: { id: "stale" }, kind: "fileWorkspace" },
      type: "game",
      lastOpened: 1,
    },
  ];
  fixtures.countPgnGames.mockResolvedValue(1);
  fixtures.createTab.mockResolvedValue("tab-id");
  fixtures.openFile.mockImplementation(async () => {
    fixtures.storeSet("recent-open");
    return "tab-id";
  });
  fixtures.readGames.mockResolvedValue([
    { pgn: "*", stamp: "new-tab-stamp", revision: "new-tab-revision", present: true },
  ]);
  fixtures.dueStats = { due: 0, unseen: 0 };
  fixtures.deckStatus = "ready";
  fixtures.decks = {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("does not let an obsolete recent-file check overwrite newer atom state", async () => {
  let rejectStaleCheck: ((reason?: unknown) => void) | undefined;
  fixtures.countPgnGames.mockImplementation((handle: { id: { id: string } }) => {
    if (handle.id.id === "stale") {
      return new Promise((_, reject) => {
        rejectStaleCheck = reject;
      });
    }
    return Promise.resolve(1);
  });

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });

  fixtures.recentFiles = [
    {
      name: "current.pgn",
      handle: { id: { id: "current" }, kind: "fileWorkspace" },
      type: "game",
      lastOpened: 2,
    },
  ];
  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  await act(async () => rejectStaleCheck?.(new Error("file disappeared")));

  expect(fixtures.setRecentFiles).not.toHaveBeenCalled();
});

test("notifies when opening a recent file is denied without creating a tab", async () => {
  fixtures.openFile.mockRejectedValueOnce(new Error("permission denied"));

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("stale"),
  )!;
  await act(async () => {
    recentFile.click();
    await Promise.resolve();
  });

  expect(fixtures.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(fixtures.setRecentFiles).not.toHaveBeenCalled();
});

test("notifies when counting games for a recent file is denied without creating a tab", async () => {
  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  fixtures.countPgnGames.mockRejectedValueOnce(new Error("permission denied"));
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("stale"),
  )!;
  await act(async () => {
    recentFile.click();
    await Promise.resolve();
  });

  expect(fixtures.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
  expect(fixtures.openFile).not.toHaveBeenCalled();
  expect(fixtures.setRecentFiles).not.toHaveBeenCalled();
});

test("keeps recent-file cancellation silent without creating a tab", async () => {
  fixtures.openFile.mockRejectedValueOnce(new Error("Cancellation"));

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("stale"),
  )!;
  await act(async () => {
    recentFile.click();
    await Promise.resolve();
  });

  expect(fixtures.notify).not.toHaveBeenCalled();
  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(fixtures.setRecentFiles).not.toHaveBeenCalled();
});

test("hides due practice counts when a repertoire is fully practiced", async () => {
  fixtures.dueStats = { due: 0, unseen: 0 };
  fixtures.recentFiles = [
    {
      name: "white",
      handle: { id: { id: "white" }, kind: "fileWorkspace" },
      type: "repertoire",
      lastOpened: 3,
    },
  ];

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  expect(container.textContent).toContain("white");
  expect(container.textContent).not.toContain("Board.Practice.Due");
});

test.each(["loading", "read-failed", "write-blocked"] as const)(
  "does not show a due badge while the practice deck is %s",
  async (status) => {
    fixtures.deckStatus = status;
    fixtures.dueStats = { due: 2, unseen: 1 };
    fixtures.recentFiles = [
      {
        name: "white",
        handle: { id: { id: "white" }, kind: "fileWorkspace" },
        type: "repertoire",
        lastOpened: 3,
      },
    ];

    await act(async () => {
      root.render(<NewTabHome id="new-tab" />);
    });
    expect(container.textContent).not.toContain("Board.Practice.Due");
  },
);

test("opens a recent repertoire with its New Tab owner and no Practice intent", async () => {
  fixtures.recentFiles = [
    {
      name: "white.pgn",
      handle: { id: { id: "white" }, kind: "fileWorkspace" },
      type: "repertoire",
      lastOpened: 3,
    },
  ];

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("white"),
  )!;
  await act(async () => {
    recentFile.click();
  });
  await vi.waitFor(() => {
    expect(fixtures.openFile).toHaveBeenCalledOnce();
    expect(fixtures.storeSet).toHaveBeenCalled();
  });
  expect(fixtures.openFile).toHaveBeenCalledWith(expect.anything(), fixtures.setTabs, {
    tabName: "white.pgn",
    ownerId: "new-tab",
    store: expect.anything(),
  });
});

test("does not acknowledge recent or practice metadata when tab admission is refused", async () => {
  fixtures.recentFiles = [
    {
      name: "white.pgn",
      handle: { id: { id: "white" }, kind: "fileWorkspace" },
      type: "repertoire",
      lastOpened: 3,
    },
  ];
  fixtures.openFile.mockResolvedValueOnce(null);

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("white"),
  )!;
  await act(async () => {
    recentFile.click();
  });

  await vi.waitFor(() => expect(fixtures.openFile).toHaveBeenCalledOnce());
  expect(fixtures.storeSet).not.toHaveBeenCalled();
});

test("shows due practice counts on recent repertoire files", async () => {
  fixtures.dueStats = { due: 2, unseen: 1 };
  fixtures.recentFiles = [
    {
      name: "white.pgn",
      handle: { id: { id: "white" }, kind: "fileWorkspace" },
      type: "repertoire",
      lastOpened: 3,
    },
  ];

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  expect(container.textContent).toContain("Board.Practice.Due");
});

test("home cards start play, analysis, puzzles, import, and repertoire", async () => {
  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  for (const label of [
    "Home.Card.PlayChess.Button",
    "Home.Card.AnalysisBoard.Button",
    "Home.Card.NewRepertoire.Button",
    "Home.Card.ImportGame.Button",
    "Home.Card.Puzzle.Button",
  ]) {
    const card = [...container.querySelectorAll("*")].find(
      (element) => element.textContent === label,
    );
    expect(card).toBeTruthy();
    await act(async () => {
      (card as HTMLElement).click();
    });
  }
  const playUpdate = fixtures.setTabs.mock.calls[0][0] as (
    prev: Array<{ value: string; name: string; type: string }>,
  ) => Array<{ value: string; name: string; type: string }>;
  const playInput = [{ value: "new-tab", name: "Home", type: "new" }];
  expect(playUpdate(playInput)[0].type).toBe("play");
  expect(playInput).toEqual([{ value: "new-tab", name: "Home", type: "new" }]);
  expect(playUpdate([])).toEqual([]);
  const analysisUpdate = fixtures.setTabs.mock.calls[1][0] as (
    prev: Array<{ value: string; name: string; type: string }>,
  ) => Array<{ value: string; name: string; type: string }>;
  const analysisInput = [{ value: "new-tab", name: "Home", type: "new" }];
  expect(analysisUpdate(analysisInput)[0].type).toBe("analysis");
  expect(analysisInput).toEqual([{ value: "new-tab", name: "Home", type: "new" }]);
  expect(analysisUpdate([])).toEqual([]);
  const puzzleUpdate = fixtures.setTabs.mock.calls[2][0] as (
    prev: Array<{ value: string; name: string; type: string }>,
  ) => Array<{ value: string; name: string; type: string }>;
  const puzzleInput = [{ value: "new-tab", name: "Home", type: "new" }];
  expect(puzzleUpdate(puzzleInput)[0].type).toBe("puzzles");
  expect(puzzleInput).toEqual([{ value: "new-tab", name: "Home", type: "new" }]);
  expect(puzzleUpdate([])).toEqual([]);
});

test("passes its own tab id to ImportModal as the owner", async () => {
  await act(async () => {
    root.render(<NewTabHome id="owning-tab" />);
  });

  expect(fixtures.importModal).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: "owning-tab" }),
  );
});

test("shows an empty recent-files state", async () => {
  fixtures.recentFiles = [];

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  expect(container.textContent).toContain("Home.RecentFiles.NoRecentFiles");
  const panel = container.querySelector("[data-home-due]")!;
  expect(panel.textContent).toContain("Home.DuePractice.NothingDue");
  expect(panel.textContent).not.toContain("Home.DuePractice.Total");
});

test("keeps a recent file after a transient count failure", async () => {
  fixtures.countPgnGames.mockRejectedValueOnce(new Error("permission denied"));

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fixtures.setRecentFiles).not.toHaveBeenCalled();
});

test("drops a recent file that is gone", async () => {
  fixtures.countPgnGames.mockRejectedValueOnce(new Error("file not found"));

  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fixtures.setRecentFiles.mock.calls.at(-1)![0](fixtures.recentFiles)).toEqual([]);
});

test("opens a recent file with an empty pgn as a blank analysis tab", async () => {
  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("stale"),
  )!;
  await act(async () => {
    recentFile.click();
    await Promise.resolve();
  });
  expect(fixtures.openFile).toHaveBeenCalledWith(
    expect.objectContaining({ name: "stale.pgn", numGames: 1 }),
    fixtures.setTabs,
    { tabName: "stale.pgn", ownerId: "new-tab", store: expect.anything() },
  );
});

test("opens a recent file into a new analysis tab", async () => {
  await act(async () => {
    root.render(<NewTabHome id="new-tab" />);
  });
  const recentFile = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("stale"),
  )!;
  await act(async () => {
    recentFile.click();
    await Promise.resolve();
  });

  expect(fixtures.openFile).toHaveBeenCalledOnce();
  expect(fixtures.notify).not.toHaveBeenCalled();
});
