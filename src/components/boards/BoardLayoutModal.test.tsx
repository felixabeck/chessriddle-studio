import { MantineProvider } from "@mantine/core";
import { createStore, Provider as JotaiProvider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { enginesAtom } from "@/state/atoms";
import { defaultBoardArrangement, type BoardArrangement } from "@/state/boardArrangement";
import { defaultKindLayouts, LAYOUT_PRESETS, type BoardLayoutKind } from "@/state/layoutPresets";
import {
  ANALYSIS_BOARD_LAYOUTS_KEY,
  BOARD_LAYOUTS_VERSION,
  boardLayoutFamily,
  boardLayoutsAtom,
  LAYOUT_NAME_MAX_LENGTH,
  MAX_SAVED_LAYOUTS,
  type SavedBoardLayout,
} from "@/state/layoutStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import BoardLayoutModal from "./BoardLayoutModal";

installResizeObserverStub();

const errorMocks = vi.hoisted(() => ({
  warnSafely: vi.fn(),
}));

vi.mock("@/platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/errors")>()),
  warnSafely: errorMocks.warnSafely,
}));

vi.mock("@/state/storageError", () => ({
  storageErrorCause: (cause: unknown) =>
    cause instanceof DOMException && cause.name === "QuotaExceededError"
      ? "Common.StorageQuotaExceeded"
      : "Common.StorageRejected",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock("@/components/common/AppModal", () => ({
  default: ({
    opened,
    title,
    children,
  }: {
    opened: boolean;
    title?: string;
    children?: ReactNode;
  }) =>
    opened ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function makeSaved(id: string, name: string, tabsHidden = false): SavedBoardLayout {
  return {
    id,
    name,
    arrangement: defaultBoardArrangement(),
    tabsHidden,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("BoardLayoutModal", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    installMatchMediaStub();
    localStorage.clear();
    errorMocks.warnSafely.mockReset();
    store = createStore();
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [],
    });
    store.set(enginesAtom, []);
    onClose = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function renderModal(mode: "save" | "manage", kind: BoardLayoutKind = "game") {
    await act(async () => {
      root.render(
        <MantineProvider>
          <JotaiProvider store={store}>
            <BoardLayoutModal opened mode={mode} kind={kind} onClose={onClose} />
          </JotaiProvider>
        </MantineProvider>,
      );
    });
  }

  const buttonByText = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent?.trim() === text,
    ) ?? null;

  const row = (id: string) => host.querySelector<HTMLElement>(`[data-layout-id="${id}"]`);

  test("save mode prompts before replacing a case-insensitive duplicate and preserves its id", async () => {
    const customArrangement: BoardArrangement = {
      direction: "row",
      first: "bottomRight",
      second: { direction: "column", first: "left", second: "topRight" },
    };
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: {
        ...defaultKindLayouts(),
        game: { arrangement: customArrangement, tabsHidden: true },
      },
      saved: [makeSaved("saved-1", "My Setup", false)],
    });

    await renderModal("save", "game");
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(input, "my setup");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });

    // Replace prompt shown; not saved or closed yet.
    expect(host.textContent).toContain('Board.Layout.ReplacePrompt:{"name":"My Setup"}');
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved[0].tabsHidden).toBe(false);

    // Confirm replace.
    await act(async () => {
      buttonByText("Board.Layout.Replace")!.click();
    });

    expect(onClose).toHaveBeenCalledOnce();
    const saved = store.get(boardLayoutsAtom).saved;
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("saved-1");
    expect(saved[0].name).toBe("my setup");
    expect(saved[0].tabsHidden).toBe(true);
    expect(saved[0].arrangement).toEqual(customArrangement);
  });

  test("at 20 saved layouts, saving a new name shows the limit error while replacing an existing name still works", async () => {
    const twenty = Array.from({ length: MAX_SAVED_LAYOUTS }, (_, i) =>
      makeSaved(`saved-${i + 1}`, `Layout ${i + 1}`),
    );
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: {
        ...defaultKindLayouts(),
        repertoire: { arrangement: defaultBoardArrangement(), tabsHidden: true },
      },
      saved: twenty,
    });

    await renderModal("save", "repertoire");
    const input = host.querySelector<HTMLInputElement>("input")!;

    // Trying a new name shows the limit message and saves nothing.
    await act(async () => {
      setInputValue(input, "Brand New");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      `Board.Layout.Error.LimitReached:{"max":${MAX_SAVED_LAYOUTS}}`,
    );
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(MAX_SAVED_LAYOUTS);
    expect(onClose).not.toHaveBeenCalled();

    // Replacing an existing name is still allowed at the cap.
    await act(async () => {
      setInputValue(input, "layout 1");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.textContent).toContain('Board.Layout.ReplacePrompt:{"name":"Layout 1"}');

    await act(async () => {
      buttonByText("Board.Layout.Replace")!.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    const saved = store.get(boardLayoutsAtom).saved;
    expect(saved).toHaveLength(MAX_SAVED_LAYOUTS);
    expect(saved[0].id).toBe("saved-1");
    expect(saved[0].name).toBe("layout 1");
    expect(saved[0].tabsHidden).toBe(true);
  });

  test("manage mode lists presets read-only first, then saved layouts with apply, rename and delete", async () => {
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [makeSaved("saved-1", "Opening Prep"), makeSaved("saved-2", "Blitz Study")],
    });

    await renderModal("manage", "game");

    const rows = [...host.querySelectorAll<HTMLElement>("[data-layout-id]")];
    expect(rows.map((el) => el.dataset.layoutId)).toEqual([
      ...LAYOUT_PRESETS.map((p) => p.id),
      "saved-1",
      "saved-2",
    ]);

    // Presets have Apply, never Rename or Delete.
    for (const preset of LAYOUT_PRESETS) {
      const presetRow = row(preset.id)!;
      expect(presetRow.querySelector('[aria-label="Files.Rename"]')).toBeNull();
      expect(presetRow.querySelector('[aria-label="Common.Delete"]')).toBeNull();
      expect(presetRow.textContent).toContain("Board.Layout.Apply");
    }

    // Saved rows have Rename and Delete.
    expect(row("saved-1")!.querySelector('[aria-label="Files.Rename"]')).not.toBeNull();
    expect(row("saved-1")!.querySelector('[aria-label="Common.Delete"]')).not.toBeNull();
  });

  test("rename allows casing-only rename and rejects case-insensitive collision with another entry", async () => {
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [makeSaved("saved-1", "Study"), makeSaved("saved-2", "Endgame")],
    });

    await renderModal("manage", "game");

    // Duplicate rename is rejected with an inline error.
    await act(async () => {
      row("saved-1")!.querySelector<HTMLButtonElement>('[aria-label="Files.Rename"]')!.click();
    });
    const renameInput = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(renameInput, "endgame");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Board.Layout.Error.DuplicateName",
    );
    expect(store.get(boardLayoutsAtom).saved[0].name).toBe("Study");

    // Casing-only rename of the same entry succeeds.
    await act(async () => {
      setInputValue(renameInput, "STUDY");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(store.get(boardLayoutsAtom).saved[0].name).toBe("STUDY");
  });

  test("delete asks for confirmation inside the dialog without window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [makeSaved("saved-1", "Disposable")],
    });

    await renderModal("manage", "game");
    await act(async () => {
      row("saved-1")!.querySelector<HTMLButtonElement>('[aria-label="Common.Delete"]')!.click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Board.Layout.DeletePrompt:{"name":"Disposable"}');
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(1);

    // Cancel keeps the entry.
    await act(async () => {
      buttonByText("Common.Cancel")!.click();
    });
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(1);

    // Confirm deletes the entry.
    await act(async () => {
      row("saved-1")!.querySelector<HTMLButtonElement>('[aria-label="Common.Delete"]')!.click();
    });
    await act(async () => {
      buttonByText("Common.Delete")!.click();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(0);
  });

  test("storage write failure shows an inline error, leaves the list unchanged, and keeps the dialog open", async () => {
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [makeSaved("saved-1", "Keep Me")],
    });

    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === ANALYSIS_BOARD_LAYOUTS_KEY) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    // Save failure keeps dialog open and list unchanged.
    await renderModal("save", "game");
    const saveInput = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(saveInput, "Will Fail");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Board.Layout.Error.Storage Common.StorageQuotaExceeded",
    );
    expect(errorMocks.warnSafely).toHaveBeenCalledWith(
      expect.stringContaining("Common.StorageQuotaExceeded"),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved.map((s) => s.name)).toEqual(["Keep Me"]);

    // Delete failure keeps dialog open and list unchanged.
    await renderModal("manage", "game");
    await act(async () => {
      row("saved-1")!.querySelector<HTMLButtonElement>('[aria-label="Common.Delete"]')!.click();
    });
    await act(async () => {
      buttonByText("Common.Delete")!.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Board.Layout.Error.Storage Common.StorageQuotaExceeded",
    );
    expect(errorMocks.warnSafely).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved.map((s) => s.name)).toEqual(["Keep Me"]);
  });

  test("saving a brand-new name adds it to saved layouts and closes the dialog", async () => {
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: {
        ...defaultKindLayouts(),
        game: { arrangement: defaultBoardArrangement(), tabsHidden: true },
      },
      saved: [],
    });

    await renderModal("save", "game");
    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(input, "  Endgame Focus  ");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });

    expect(onClose).toHaveBeenCalledOnce();
    const saved = store.get(boardLayoutsAtom).saved;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Endgame Focus");
    expect(saved[0].tabsHidden).toBe(true);
  });

  test("switching from Manage to Save mode opens the save form and saves a layout", async () => {
    await renderModal("manage", "game");
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Board.Layout.ManageTitle",
    );

    await act(async () => {
      buttonByText("Board.Layout.SaveAs")!.click();
    });
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Board.Layout.SaveTitle",
    );

    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      setInputValue(input, "From Manage");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(store.get(boardLayoutsAtom).saved.map((s) => s.name)).toEqual(["From Manage"]);
  });

  test("empty name and overly long name show inline errors without closing or mutating", async () => {
    await renderModal("save", "game");
    const input = host.querySelector<HTMLInputElement>("input")!;

    await act(async () => {
      setInputValue(input, "   ");
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Board.Layout.Error.EmptyName",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(0);

    await act(async () => {
      setInputValue(input, "x".repeat(LAYOUT_NAME_MAX_LENGTH + 1));
    });
    await act(async () => {
      buttonByText("Common.Save")!.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      `Board.Layout.Error.NameTooLong:{"max":${LAYOUT_NAME_MAX_LENGTH}}`,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(boardLayoutsAtom).saved).toHaveLength(0);
  });

  test("Apply copies the selected layout into the captured kind and closes", async () => {
    store.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [makeSaved("saved-1", "Hidden Tabs", true)],
    });

    await renderModal("manage", "repertoire");
    const applyBtn = [...row("saved-1")!.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent?.trim() === "Board.Layout.Apply",
    )!;
    await act(async () => {
      applyBtn.click();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(store.get(boardLayoutFamily("repertoire")).tabsHidden).toBe(true);
    expect(store.get(boardLayoutFamily("game")).tabsHidden).toBe(false);
  });
});
