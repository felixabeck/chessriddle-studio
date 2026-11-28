import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { tabsAtom } from "@/state/atoms";
import type { IndexedRepertoireChapter, IndexedRepertoireFile } from "@/state/repertoireIndex";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { RepertoireColorNotice, uncoloredRepertoires } from "./RepertoireColorNotice";

const mocks = vi.hoisted(() => ({
  writeGamesOrientation: vi.fn(async (): Promise<void> => undefined),
  firstBlockedFileGame: vi.fn((): number | null => null),
}));

vi.mock("@/utils/fileGameWrite", () => ({
  writeGamesOrientation: mocks.writeGamesOrientation,
  firstBlockedFileGame: mocks.firstBlockedFileGame,
}));

installMatchMediaStub();
installResizeObserverStub();

function file(name: string): FileMetadata {
  return {
    type: "file",
    handle: { id: { id: name }, kind: "fileWorkspace" },
    name,
    numGames: 3,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
  };
}

function chapter(index: number, orientation?: "white" | "black"): IndexedRepertoireChapter {
  return {
    chapter: index,
    headers: { white: "", black: "", event: "", ...(orientation ? { orientation } : {}) },
    nodes: [],
  };
}

function indexed(name: string, chapters: IndexedRepertoireChapter[]): IndexedRepertoireFile {
  return { workspaceKey: `key:${name}`, file: file(name), chapters, partial: false };
}

describe("uncoloredRepertoires", () => {
  test("names files with uncolored chapters, suggesting the color the others share", () => {
    const result = uncoloredRepertoires([
      indexed("Black.pgn", [chapter(0, "black"), chapter(1), chapter(2)]),
      indexed("Plain.pgn", [chapter(0), chapter(1)]),
      indexed("Mixed.pgn", [chapter(0, "black"), chapter(1, "white"), chapter(2)]),
      indexed("Done.pgn", [chapter(0, "black")]),
    ]);
    expect(result.map((r) => [r.file.name, r.games, r.suggested])).toEqual([
      ["Black.pgn", [1, 2], "black"],
      ["Plain.pgn", [0, 1], "white"],
      ["Mixed.pgn", [2], "white"],
    ]);
  });

  test("leaves out a file whose colored chapters are all White", () => {
    expect(uncoloredRepertoires([indexed("White.pgn", [chapter(0, "white"), chapter(1)])])).toEqual(
      [],
    );
  });
});

describe("RepertoireColorNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const onColored = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    store.set(tabsAtom, []);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (files: IndexedRepertoireFile[]) => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MantineProvider>
            <RepertoireColorNotice
              repertoires={uncoloredRepertoires(files)}
              onColored={onColored}
            />
          </MantineProvider>
        </Provider>,
      );
    });
  };

  const openDialogFor = async (index: number) => {
    const button = container.querySelectorAll<HTMLButtonElement>(
      "[data-repertoire-color-file] button",
    )[index];
    await act(async () => button.click());
  };

  const save = async () => {
    const button = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>("[data-repertoire-color-save]");
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => button.click());
  };

  test("renders nothing when every repertoire has its color", async () => {
    await render([indexed("Done.pgn", [chapter(0, "black")])]);
    expect(container.querySelector("[data-repertoire-color-notice]")).toBeNull();
  });

  test("writes the suggested color to the uncolored chapters only and reports success", async () => {
    await render([indexed("Black.pgn", [chapter(0, "black"), chapter(1), chapter(2)])]);
    expect(container.querySelector("[data-repertoire-color-file]")?.textContent).toContain(
      "Repertoire.Color.MissingInFile",
    );

    await openDialogFor(0);
    await save();

    expect(mocks.firstBlockedFileGame).toHaveBeenCalledWith([], file("Black.pgn").handle, [1, 2]);
    expect(mocks.writeGamesOrientation).toHaveBeenCalledWith(
      file("Black.pgn").handle,
      [1, 2],
      "black",
    );
    expect(onColored).toHaveBeenCalledTimes(1);
  });

  test("a failed write stays in the dialog and reads the files again when it closes", async () => {
    mocks.writeGamesOrientation.mockRejectedValueOnce({
      category: "unexpected",
      message: "disk full",
    });
    await render([indexed("Black.pgn", [chapter(0, "black"), chapter(1)])]);

    await openDialogFor(0);
    await save();

    await vi.waitFor(() =>
      expect(document.querySelector("[data-repertoire-color-error]")?.textContent).toBe(
        "Files.OperationFailed",
      ),
    );
    expect(onColored).not.toHaveBeenCalled();

    const close = document.querySelector<HTMLButtonElement>(".mantine-Modal-close")!;
    await act(async () => close.click());
    // Chapters written before the failure already carry the color.
    expect(onColored).toHaveBeenCalledTimes(1);
  });

  test("the chosen color replaces the suggestion", async () => {
    await render([indexed("Plain.pgn", [chapter(0), chapter(1)])]);

    await openDialogFor(0);
    const black = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('input[value="black"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => black.click());
    await save();

    expect(mocks.writeGamesOrientation).toHaveBeenCalledWith(
      file("Plain.pgn").handle,
      [0, 1],
      "black",
    );
  });

  test.each([
    [
      { category: "unexpected", backendCategory: "stale-game", message: "" },
      "Files.LineSection.Stale",
    ],
    [
      { category: "unexpected", backendCategory: "durability", message: "" },
      /could not be fully confirmed/,
    ],
  ])("a %o failure explains itself", async (failure, message: string | RegExp) => {
    mocks.writeGamesOrientation.mockRejectedValueOnce(failure);
    await render([indexed("Black.pgn", [chapter(0, "black"), chapter(1)])]);

    await openDialogFor(0);
    await save();

    await vi.waitFor(() =>
      expect(document.querySelector("[data-repertoire-color-error]")?.textContent).toMatch(message),
    );
  });

  test("a cancelled write shows no error and does not count as written", async () => {
    mocks.writeGamesOrientation.mockRejectedValueOnce({ category: "cancelled", message: "" });
    await render([indexed("Black.pgn", [chapter(0, "black"), chapter(1)])]);

    await openDialogFor(0);
    await save();

    expect(document.querySelector("[data-repertoire-color-error]")).toBeNull();
    const close = document.querySelector<HTMLButtonElement>(".mantine-Modal-close")!;
    await act(async () => close.click());
    expect(onColored).not.toHaveBeenCalled();
  });

  test("a chapter open with unsaved work blocks the write", async () => {
    mocks.firstBlockedFileGame.mockReturnValueOnce(1);
    await render([indexed("Black.pgn", [chapter(0, "black"), chapter(1)])]);

    await openDialogFor(0);
    await save();

    expect(mocks.writeGamesOrientation).not.toHaveBeenCalled();
    expect(onColored).not.toHaveBeenCalled();
    expect(document.querySelector("[data-repertoire-color-error]")?.textContent).toBe(
      "Files.LineSection.UnsavedTab",
    );
  });
});
