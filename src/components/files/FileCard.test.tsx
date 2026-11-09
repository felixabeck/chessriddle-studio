import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cancellationError } from "@/platform/tauri";
import { tabStorage } from "@/state/store/tabStorage";
import type { StampedGame } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { getDefaultStore } from "jotai";
import { tabsAtom } from "@/state/atoms";

const mocks = vi.hoisted(() => ({
  readGames: vi.fn(),
  readGame: vi.fn(),
  navigate: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  showNotification: vi.fn(),
  actualSelector: false,
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      readGames: mocks.readGames,
      readGame: mocks.readGame,
    },
  };
});

vi.mock("@/utils/chess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/chess")>();
  return {
    ...actual,
    parsePGN: async (pgn: string) => {
      const { defaultTree } = await import("@/utils/treeReducer");
      const tree = defaultTree();
      tree.headers.event = pgn.includes("Fresh second")
        ? "Fresh second"
        : pgn.includes("Fresh from disk")
          ? "Fresh from disk"
          : "Preview";
      return tree;
    },
  };
});

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.showNotification },
}));

vi.mock("@/components/files/notifyError", async () => {
  const actual = await vi.importActual<typeof import("@/components/files/notifyError")>(
    "@/components/files/notifyError",
  );
  return {
    ...actual,
    notifyUnlessCancelled: mocks.notifyUnlessCancelled.mockImplementation(
      actual.notifyUnlessCancelled,
    ),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

const t = (key: string) => key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}));

vi.mock("../databases/GamePreview", () => ({
  default: ({ pgn }: { pgn: string }) => <div data-testid="game-preview">{pgn}</div>,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 60,
    measure: () => undefined,
    getVirtualItems: () => [0, 1].map((index) => ({ index, size: 30, start: index * 30 })),
  }),
}));
vi.mock("../panels/info/GameSelector", async (original) => {
  const actual = await original<typeof import("../panels/info/GameSelector")>();
  return {
    default: (props: React.ComponentProps<typeof actual.default>) =>
      mocks.actualSelector ? (
        <actual.default {...props} />
      ) : (
        <button
          type="button"
          data-testid="game-selector"
          onClick={() => props.setPage(props.activePage + 1)}
        >
          Select next game
        </button>
      ),
  };
});

import { MantineProvider } from "@mantine/core";
import FileCard from "./FileCard";
import type { FileMetadata } from "./file";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

function renderWithMantine(ui: React.ReactNode, root: Root) {
  return act(async () => {
    root.render(<MantineProvider>{ui}</MantineProvider>);
  });
}

// jsdom has no ResizeObserver; the card measures itself to decide whether the preview has room for
// its move list. Unobserved, the width stays 0 and the preview renders without controls.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

describe("FileCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  function stampedGame(pgn: string, revision = "revision"): StampedGame {
    return { pgn, stamp: `stamp-${revision}`, revision, present: true };
  }

  const sampleFileA: FileMetadata = {
    type: "file",
    handle: { id: { id: "token-a" }, kind: "fileWorkspace" },
    name: "fileA",
    numGames: 5,
    metadata: { type: "game", tags: [] },
    lastModified: 1,
  };

  const sampleFileB: FileMetadata = {
    type: "file",
    handle: { id: { id: "token-b" }, kind: "fileWorkspace" },
    name: "fileB",
    numGames: 3,
    metadata: { type: "game", tags: [] },
    lastModified: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    getDefaultStore().set(tabsAtom, []);
    mocks.actualSelector = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  test("rapid file replacement aborts previous signal and prevents stale publication", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(val: StampedGame[]) => void> = [];

    mocks.readGames.mockImplementation(
      (_handle: unknown, _start: number, _end: number, options?: { signal?: AbortSignal }) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise<StampedGame[]>((resolve) => {
          resolvers.push(resolve);
        });
      },
    );

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);

    // Rapid switch to file B
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileB} />, root);

    expect(signals[0].aborted).toBe(true);
    expect(mocks.readGames).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);

    // Resolve stale request from file A
    await act(async () => {
      resolvers[0]([stampedGame("pgn-from-file-A", "a")]);
    });
    // Stale result should NOT be published
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();

    // Resolve request from file B
    await act(async () => {
      resolvers[1]([stampedGame("pgn-from-file-B", "b")]);
    });
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "pgn-from-file-B",
    );
  });

  test("unmount aborts in-flight readGames signal", async () => {
    let capturedSignal!: AbortSignal;
    mocks.readGames.mockImplementation(
      (_handle: unknown, _start: number, _end: number, options?: { signal?: AbortSignal }) => {
        if (options?.signal) capturedSignal = options.signal;
        return new Promise(() => {});
      },
    );

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });
    expect(capturedSignal.aborted).toBe(true);
  });

  test("cancelled readGames does not show failure notification", async () => {
    mocks.readGames.mockRejectedValue(cancellationError());

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
  });

  test.each([
    {
      failure: "ordinary error",
      error: new Error("Failed to read game B"),
      notifications: [{ color: "danger", title: "Common.Error", message: "Failed to read game B" }],
    },
    { failure: "cancellation", error: cancellationError(), notifications: [] },
  ])("clears A's preview after B's $failure", async ({ error, notifications }) => {
    mocks.readGames
      .mockResolvedValueOnce([stampedGame("pgn-from-game-A", "a")])
      .mockRejectedValueOnce(error);

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "pgn-from-game-A",
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='game-selector']")!.click();
    });

    expect(mocks.readGames).toHaveBeenCalledTimes(2);
    expect(mocks.readGames).toHaveBeenLastCalledWith(sampleFileA.handle, 1, 1, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.readGames.mock.calls[1][3].signal.aborted).toBe(false);
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
    expect(container.textContent).not.toContain("pgn-from-game-A");
    expect(mocks.showNotification.mock.calls).toEqual(
      notifications.map((notification) => [notification]),
    );

    const selector = container.querySelector<HTMLButtonElement>("[data-testid='game-selector']");
    expect(selector).not.toBeNull();
    expect(selector?.disabled).toBe(false);
    mocks.readGames.mockResolvedValueOnce([stampedGame("pgn-from-game-C", "c")]);
    await act(async () => {
      selector!.click();
    });

    expect(mocks.readGames).toHaveBeenCalledTimes(3);
    expect(mocks.readGames).toHaveBeenLastCalledWith(sampleFileA.handle, 2, 2, {
      signal: expect.any(AbortSignal),
    });
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "pgn-from-game-C",
    );
    expect(mocks.showNotification.mock.calls).toEqual(
      notifications.map((notification) => [notification]),
    );
  });

  test("renders neither the game selector nor the preview for an empty file", async () => {
    mocks.readGames.mockResolvedValueOnce([]);

    await renderWithMantine(
      <FileCard onEditMetadata={vi.fn()} selected={{ ...sampleFileA, numGames: 0 }} />,
      root,
    );

    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='game-selector']")).toBeNull();
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
  });

  test("renders the game selector while the first read is pending, then shows the preview", async () => {
    let resolveFirstRead!: (games: StampedGame[]) => void;
    mocks.readGames.mockImplementationOnce(
      () =>
        new Promise<StampedGame[]>((resolve) => {
          resolveFirstRead = resolve;
        }),
    );

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='game-selector']")).not.toBeNull();
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();

    await act(async () => {
      resolveFirstRead([stampedGame("pgn-from-game-A", "a")]);
    });

    expect(container.querySelector("[data-testid='game-selector']")).not.toBeNull();
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "pgn-from-game-A",
    );
  });

  test("keeps the game selector rendered when the first read fails", async () => {
    const error = new Error("Failed to read game A");
    mocks.readGames.mockRejectedValueOnce(error);

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(mocks.readGames).toHaveBeenCalledWith(sampleFileA.handle, 0, 0, {
      signal: expect.any(AbortSignal),
    });
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
    expect(container.querySelector("[data-testid='game-selector']")).not.toBeNull();
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith({
      color: "danger",
      title: "Common.Error",
      message: error.message,
    });
  });

  test("an omitted preview shows its label, disables Open and does not notify", async () => {
    mocks.readGames.mockResolvedValue([
      { pgn: "", stamp: "", revision: "revision", present: true, omission: "tooLarge" },
    ]);
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    expect(container.textContent).toContain("Files.GameTooLarge");
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
    expect(openButton().disabled).toBe(true);
    await act(async () => openButton().click());
    expect(mocks.readGame).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();

    mocks.readGames.mockResolvedValue([stampedGame("Readable next")]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='game-selector']")!.click(),
    );
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "Readable next",
    );
    expect(container.textContent).not.toContain("Files.GameTooLarge");
    expect(openButton().disabled).toBe(false);
  });

  test("active readGames error triggers notification and clears a readable preview", async () => {
    mocks.readGames.mockResolvedValue([stampedGame("Readable preview")]);
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe(
      "Readable preview",
    );
    const error = new Error("Failed to read game");
    mocks.readGames.mockRejectedValue(error);

    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='game-selector']")!.click(),
    );

    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", error);
    expect(container.querySelector("[data-testid='game-preview']")).toBeNull();
  });

  test("obsolete readGames failure after switch stays silent", async () => {
    let rejectA!: (err: unknown) => void;
    mocks.readGames.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    // Switch to file B before A fails
    mocks.readGames.mockResolvedValueOnce([stampedGame("pgn-b", "b")]);
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileB} />, root);

    // Now A fails late
    await act(async () => {
      rejectA(new Error("Stale disk read error"));
    });

    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe("pgn-b");
  });

  test("a relisted copy of the same file keeps the page and reads no games again", async () => {
    mocks.readGames.mockResolvedValue([stampedGame("pgn-a", "a")]);

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    expect(mocks.readGames).toHaveBeenCalledTimes(1);

    await renderWithMantine(
      <FileCard
        onEditMetadata={vi.fn()}
        selected={{ ...sampleFileA, name: "renamed", handle: { ...sampleFileA.handle } }}
      />,
      root,
    );

    expect(mocks.readGames).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("renamed");
    expect(container.querySelector("[data-testid='game-preview']")?.textContent).toBe("pgn-a");
  });

  test("renders the metadata-edit control and invokes its callback", async () => {
    mocks.readGames.mockResolvedValue([stampedGame("pgn-a", "a")]);

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);

    const onEditMetadata = vi.fn();
    await renderWithMantine(
      <FileCard selected={sampleFileA} onEditMetadata={onEditMetadata} />,
      root,
    );
    const edit = container.querySelector('[aria-label="Files.EditMetadata"]') as HTMLButtonElement;
    expect(edit).not.toBeNull();
    act(() => edit.click());
    expect(onEditMetadata).toHaveBeenCalledOnce();
    expect(openButton().textContent).toBe("Common.OpenGame");
  });

  test("Open reads and seeds fresh game text instead of the preview", async () => {
    const stamp = "f".repeat(64);
    mocks.readGames.mockResolvedValue([stampedGame('[Event "Old preview"]\n\n1. e4 *')]);
    mocks.readGame.mockResolvedValue({
      pgn: '[Event "Fresh from disk"]\n\n1. d4 *',
      stamp,
      revision: "r-fresh",
      present: true,
    });
    const seed = vi.spyOn(tabStorage, "seed");

    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    await vi.waitFor(() => expect(container.textContent).toContain("Old preview"));
    await act(async () => {
      openButton().click();
    });
    await vi.waitFor(() => expect(seed).toHaveBeenCalledOnce());

    expect(mocks.readGame).toHaveBeenCalledWith(sampleFileA.handle, 0, undefined);
    expect(seed).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sourceStamp: stamp,
        headers: expect.objectContaining({ event: "Fresh from disk" }),
      }),
    );
  });

  function openButton() {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Common.OpenGame",
    )!;
  }

  async function renderActualList() {
    mocks.actualSelector = true;
    mocks.readGames.mockImplementation(async (_handle: unknown, start: number, end: number) =>
      Array.from({ length: Math.min(end, 1) - start + 1 }, (_, index) =>
        stampedGame(`preview-${start + index}`),
      ),
    );
    await renderWithMantine(
      <FileCard onEditMetadata={vi.fn()} selected={{ ...sampleFileA, numGames: 2 }} />,
      root,
    );
  }

  test("labelled action is visible and enabled while preview loads, empty files cannot open", async () => {
    mocks.readGames.mockReturnValue(new Promise(() => {}));
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    expect(openButton().textContent).toBe("Common.OpenGame");
    expect(openButton().disabled).toBe(false);
    await renderWithMantine(
      <FileCard onEditMetadata={vi.fn()} selected={{ ...sampleFileB, numGames: 0 }} />,
      root,
    );
    expect(openButton().disabled).toBe(true);
    await act(async () => openButton().click());
    expect(mocks.readGame).not.toHaveBeenCalled();
  });

  test("non-first row double-click reads its explicit index fresh, shares one lock with the button", async () => {
    let settle!: (game: StampedGame) => void;
    mocks.readGame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const seed = vi.spyOn(tabStorage, "seed");
    await renderActualList();
    const second = container.querySelectorAll<HTMLElement>('[role="option"]')[1];
    await act(async () => {
      second.click();
      second.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      openButton().click();
    });
    expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(sampleFileA.handle, 1, undefined);
    expect(openButton().disabled).toBe(true);
    // Selection changes while the fresh read still belongs to the second game.
    await act(async () => container.querySelectorAll<HTMLElement>('[role="option"]')[0].click());
    await act(async () => settle(stampedGame('[Event "Fresh second"]\n\n1. d4 *', "second")));
    expect(seed).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ event: "Fresh second" }) }),
    );
    expect(getDefaultStore().get(tabsAtom)).toEqual([
      expect.objectContaining({
        gameOrigin: expect.objectContaining({
          kind: "file",
          gameNumber: 1,
          file: expect.objectContaining({ handle: sampleFileA.handle }),
        }),
      }),
    ]);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  });

  test("row-focused Enter opens the non-first file game without changing selection first", async () => {
    mocks.readGame.mockResolvedValue(stampedGame('[Event "Fresh second"]\n\n1. d4 *'));
    await renderActualList();
    const second = container.querySelectorAll<HTMLElement>('[role="option"]')[1];
    expect(second.tabIndex).toBe(0);
    await act(async () => {
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(sampleFileA.handle, 1, undefined);
    expect(getDefaultStore().get(tabsAtom)[0].gameOrigin).toEqual(
      expect.objectContaining({ kind: "file", gameNumber: 1 }),
    );
  });

  test("open rejection, cancellation and null admission release the lock without navigation", async () => {
    mocks.readGames.mockResolvedValue([]);
    mocks.readGame
      .mockRejectedValueOnce(new Error("fresh read failed"))
      .mockRejectedValueOnce(cancellationError());
    await renderWithMantine(<FileCard onEditMetadata={vi.fn()} selected={sampleFileA} />, root);
    await act(async () => openButton().click());
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: "fresh read failed" }),
    );
    await act(async () => openButton().click());
    expect(mocks.showNotification).toHaveBeenCalledOnce();
    mocks.readGame.mockResolvedValue(stampedGame("Fresh from disk"));
    const seed = vi.spyOn(tabStorage, "seed").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await act(async () => openButton().click());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(openButton().disabled).toBe(false);
    seed.mockRestore();
    await act(async () => openButton().click());
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });
});
