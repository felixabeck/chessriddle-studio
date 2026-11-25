import type {
  FileWorkspaceHandle,
  LibrarySyncError,
  LibrarySyncFile,
  LibrarySyncFileStatus,
  LibrarySyncSnapshot,
  LibrarySyncState,
} from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import beBY from "@/translation/be-BY.json";
import deDE from "@/translation/de-DE.json";
import enGB from "@/translation/en-GB.json";
import enUS from "@/translation/en-US.json";
import esES from "@/translation/es-ES.json";
import frFR from "@/translation/fr-FR.json";
import itIT from "@/translation/it-IT.json";
import koKR from "@/translation/ko-KR.json";
import nbNO from "@/translation/nb-NO.json";
import plPL from "@/translation/pl-PL.json";
import ptPT from "@/translation/pt-PT.json";
import ruRU from "@/translation/ru-RU.json";
import trTR from "@/translation/tr-TR.json";
import ukUA from "@/translation/uk-UA.json";
import zhCN from "@/translation/zh-CN.json";
import zhTW from "@/translation/zh-TW.json";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySyncControl } from "./LibrarySyncControl";
import { LibrarySyncDialog } from "./LibrarySyncDialog";
import type { UseLibrarySyncResult } from "./useLibrarySync";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const hookMock = vi.hoisted(() => ({
  useLibrarySync: vi.fn(),
}));

vi.mock("./useLibrarySync", () => ({
  useLibrarySync: hookMock.useLibrarySync,
}));

const workspace: FileWorkspaceHandle = { id: { id: "ws-1" }, kind: "fileWorkspace" };
const otherWorkspace: FileWorkspaceHandle = { id: { id: "ws-2" }, kind: "fileWorkspace" };

function fileHandle(id: string): FileWorkspaceHandle {
  return { id: { id }, kind: "fileWorkspace" };
}

function makeFile(
  id: string,
  name: string,
  status: LibrarySyncFileStatus,
  selected = true,
  folderLabel = "",
): LibrarySyncFile {
  return {
    handle: fileHandle(id),
    name,
    folderLabel,
    selected,
    status,
  };
}

function makeSnapshot(
  state: LibrarySyncState,
  files: LibrarySyncFile[] = [],
  {
    available = true,
    active = state.status !== "off",
    ws = workspace,
  }: { available?: boolean; active?: boolean; ws?: FileWorkspaceHandle } = {},
): LibrarySyncSnapshot {
  return {
    workspace: ws,
    revision: 1,
    available,
    active,
    state,
    files,
  };
}

function makeHookResult(overrides: Partial<UseLibrarySyncResult> = {}): UseLibrarySyncResult {
  return {
    snapshot: makeSnapshot({ status: "off" }),
    busy: false,
    error: null,
    turnOn: vi.fn(async () => {}),
    turnOff: vi.fn(async () => {}),
    setFileSelected: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    ...overrides,
  };
}

const i18nInstance = i18next.createInstance();

beforeAll(async () => {
  await i18nInstance.use(initReactI18next).init({
    lng: "en-US",
    fallbackLng: "en-US",
    resources: {
      "en-US": { translation: enUS.translation },
    },
    interpolation: { escapeValue: false },
  });
});

let host: HTMLDivElement;
let root: Root;

async function renderControl(ws: FileWorkspaceHandle | null = workspace) {
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18nInstance}>
        <MantineProvider>
          <div data-sync-host>
            <LibrarySyncControl workspace={ws} />
          </div>
        </MantineProvider>
      </I18nextProvider>,
    );
  });
}

async function clickElement(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((btn) => btn.textContent?.includes(text));
}

describe("LibrarySync translations", () => {
  it("pins the exact Sync with ChessRiddle button label across all required languages", () => {
    const expected: Record<string, string> = {
      "en-US": "Sync with ChessRiddle",
      "en-GB": "Sync with ChessRiddle",
      "de-DE": "Mit ChessRiddle synchronisieren",
      "es-ES": "Sincronizar con ChessRiddle",
      "fr-FR": "Synchroniser avec ChessRiddle",
      "it-IT": "Sincronizza con ChessRiddle",
      "ko-KR": "ChessRiddle과 동기화",
      "pl-PL": "Synchronizuj z ChessRiddle",
      "pt-PT": "Sincronizar com o ChessRiddle",
      "ru-RU": "Синхронизировать с ChessRiddle",
      "tr-TR": "ChessRiddle ile senkronize et",
      "zh-CN": "与 ChessRiddle 同步",
    };
    const catalogs: Record<string, Record<string, string>> = {
      "en-US": enUS.translation,
      "en-GB": enGB.translation,
      "de-DE": deDE.translation,
      "es-ES": esES.translation,
      "fr-FR": frFR.translation,
      "it-IT": itIT.translation,
      "ko-KR": koKR.translation,
      "pl-PL": plPL.translation,
      "pt-PT": ptPT.translation,
      "ru-RU": ruRU.translation,
      "tr-TR": trTR.translation,
      "zh-CN": zhCN.translation,
    };
    for (const [locale, label] of Object.entries(expected)) {
      expect(catalogs[locale]["Library.Sync.Action"]).toBe(label);
    }

    for (const catalog of [beBY, nbNO, ukUA, zhTW]) {
      expect(catalog.translation["Library.Sync.Action"].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("LibrarySyncControl", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders nothing when workspace is null, snapshot is null, or available is false", async () => {
    const syncHost = () => host.querySelector("[data-sync-host]")!;

    hookMock.useLibrarySync.mockReturnValue(makeHookResult({ snapshot: null }));
    await renderControl(workspace);
    expect(syncHost().innerHTML).toBe("");

    hookMock.useLibrarySync.mockReturnValue(
      makeHookResult({ snapshot: makeSnapshot({ status: "off" }, [], { available: false }) }),
    );
    await renderControl(workspace);
    expect(syncHost().innerHTML).toBe("");

    hookMock.useLibrarySync.mockReturnValue(makeHookResult());
    await renderControl(null);
    expect(syncHost().innerHTML).toBe("");
  });

  it.each<[LibrarySyncState, string]>([
    [{ status: "off" }, "Off"],
    [{ status: "otherFolder" }, "Other folder"],
    [{ status: "syncing", done: 2, total: 5 }, "2 of 5"],
    [{ status: "synced" }, "Synced"],
    [{ status: "attention", count: 1 }, "1 file not synced"],
    [{ status: "attention", count: 3 }, "3 files not synced"],
    [{ status: "removing", done: 1, total: 4 }, "Removing 1 of 4"],
    [{ status: "offline" }, "Offline"],
    [{ status: "serverBusy" }, "Server busy"],
    [{ status: "serverError" }, "Sync error"],
    [{ status: "signInNeeded" }, "Sign in again"],
    [{ status: "unavailable" }, "Not available yet"],
    [{ status: "folderUnavailable" }, "Folder unavailable"],
    [{ status: "localError" }, "Local error"],
  ])("shows button state badge %s -> %s", async (state, expectedBadge) => {
    hookMock.useLibrarySync.mockReturnValue(makeHookResult({ snapshot: makeSnapshot(state) }));
    await renderControl(workspace);
    const button = host.querySelector("button");
    expect(button?.textContent).toContain("Sync with ChessRiddle");
    expect(button?.textContent).toContain(expectedBadge);
  });

  it.each<[LibrarySyncError, string]>([
    ["localStorage", "Local error"],
    ["invalidWorkspace", "Folder unavailable"],
    ["unavailable", "Not available yet"],
    ["busy", "Synced"],
    ["notActive", "Synced"],
  ])(
    "maps command error %s on button badge to %s without overriding transient errors",
    async (error, expectedBadge) => {
      hookMock.useLibrarySync.mockReturnValue(
        makeHookResult({
          snapshot: makeSnapshot({ status: "synced" }),
          error,
        }),
      );
      await renderControl(workspace);
      expect(host.querySelector("button")?.textContent).toContain(expectedBadge);
    },
  );

  it("opens the dialog lazily, wires setFileSelected and syncNow through the control, and closes when unavailable", async () => {
    const f1 = makeFile("f-1", "Repertoire", { kind: "synced" }, true);
    const setFileSelected = vi.fn(async () => {});
    const syncNow = vi.fn(async () => {});
    hookMock.useLibrarySync.mockReturnValue(
      makeHookResult({
        snapshot: makeSnapshot({ status: "synced" }, [f1]),
        setFileSelected,
        syncNow,
      }),
    );
    await renderControl(workspace);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await clickElement(host.querySelector("button"));
    await act(async () => {
      await Promise.resolve();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    await clickElement(dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    expect(setFileSelected).toHaveBeenCalledWith(f1.handle, false);

    await clickElement(findButton("Sync now"));
    expect(syncNow).toHaveBeenCalledTimes(1);

    hookMock.useLibrarySync.mockReturnValue(
      makeHookResult({ snapshot: makeSnapshot({ status: "off" }, [], { available: false }) }),
    );
    await renderControl(workspace);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("LibrarySyncDialog", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderDialog(
    snapshot: LibrarySyncSnapshot,
    overrides: Partial<{
      busy: boolean;
      error: UseLibrarySyncResult["error"];
      onTurnOn: UseLibrarySyncResult["turnOn"];
      onTurnOff: UseLibrarySyncResult["turnOff"];
      onSetFileSelected: UseLibrarySyncResult["setFileSelected"];
      onSyncNow: UseLibrarySyncResult["syncNow"];
      onClose: () => void;
    }> = {},
  ) {
    const props = {
      opened: true,
      onClose: overrides.onClose ?? vi.fn(),
      snapshot,
      busy: overrides.busy ?? false,
      error: overrides.error ?? null,
      onTurnOn: overrides.onTurnOn ?? vi.fn(async () => {}),
      onTurnOff: overrides.onTurnOff ?? vi.fn(async () => {}),
      onSetFileSelected: overrides.onSetFileSelected ?? vi.fn(async () => {}),
      onSyncNow: overrides.onSyncNow ?? vi.fn(async () => {}),
    };
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18nInstance}>
          <MantineProvider>
            <LibrarySyncDialog {...props} />
          </MantineProvider>
        </I18nextProvider>,
      );
    });
    return props;
  }

  it("renders sync-off explanation, limits, file checkboxes, oversized marker, and deselected turn-on", async () => {
    const f1 = makeFile("f-1", "Sicilian", { kind: "pending" }, true, "Openings");
    const f2 = makeFile("f-2", "Mega", { kind: "tooLarge" }, true);
    const onTurnOn = vi.fn(async () => {});

    await renderDialog(makeSnapshot({ status: "off" }, [f1, f2], { active: false }), { onTurnOn });

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("private Library on ChessRiddle");
    expect(dialog.textContent).toContain("website only reads them");
    expect(dialog.textContent).toContain(
      "Downloaded game histories and game databases are not synced",
    );
    expect(dialog.textContent).toContain("100 files, 5 MB and 40,000 moves");
    expect(dialog.textContent).toContain("Openings");
    expect(dialog.textContent).toContain("Too large");

    const checkboxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((cb) => cb.checked)).toBe(true);

    await clickElement(checkboxes[1]);
    expect(checkboxes[1].checked).toBe(false);

    await clickElement(findButton("Turn on sync"));
    expect(onTurnOn).toHaveBeenCalledWith([f2.handle]);
  });

  it("renders empty off folder message when there are no PGN files yet", async () => {
    await renderDialog(makeSnapshot({ status: "off" }, [], { active: false }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("No PGN files in this folder yet.");
    expect(findButton("Turn on sync")).toBeDefined();
  });

  it("renders off-mode folderUnavailable without file list, Turn on sync, Sync now, or Turn off sync", async () => {
    await renderDialog(makeSnapshot({ status: "folderUnavailable" }, [], { active: false }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("This Library folder is currently unavailable.");
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(findButton("Turn on sync")).toBeUndefined();
    expect(findButton("Sync now")).toBeUndefined();
    expect(findButton("Turn off sync")).toBeUndefined();
  });

  it("renders every file status vocabulary item in plain words when sync is on", async () => {
    const statuses: [LibrarySyncFileStatus, string][] = [
      [{ kind: "synced" }, "Synced"],
      [{ kind: "pending" }, "Waiting"],
      [{ kind: "uploading" }, "Uploading"],
      [{ kind: "notSelected" }, "Not selected"],
      [{ kind: "tooLarge" }, "Too large"],
      [{ kind: "tooManyMoves" }, "Too many moves"],
      [{ kind: "tooManyGames" }, "Too many games"],
      [{ kind: "invalidPgn", gameNumber: 4 }, "Game 4 could not be read"],
      [{ kind: "invalidPgn", gameNumber: null }, "Could not be read as PGN"],
      [{ kind: "unsupportedVariant" }, "Variant not supported"],
      [{ kind: "tooComplex" }, "Too complex"],
      [{ kind: "commentTooLong" }, "Comment too long"],
      [{ kind: "empty" }, "No games"],
      [{ kind: "libraryFull" }, "Library is full"],
      [{ kind: "storageFull" }, "Storage is full"],
      [{ kind: "unreadable" }, "File could not be read"],
      [{ kind: "rejected" }, "Not accepted by the website"],
    ];

    const files = statuses.map(([status, _text], index) =>
      makeFile(`f-${index}`, `File ${index}`, status, status.kind !== "notSelected"),
    );

    await renderDialog(makeSnapshot({ status: "attention", count: 12 }, files));

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("12 files could not be synced.");
    for (const [, expectedText] of statuses) {
      expect(dialog.textContent).toContain(expectedText);
    }
  });

  it.each<[LibrarySyncState, string]>([
    [{ status: "syncing", done: 2, total: 4 }, "Syncing 2 of 4…"],
    [{ status: "synced" }, "All selected files are synced."],
    [{ status: "attention", count: 1 }, "1 file could not be synced."],
    [{ status: "attention", count: 2 }, "2 files could not be synced."],
    [{ status: "offline" }, "Offline. Sync will continue when ChessRiddle is reachable."],
    [{ status: "serverBusy" }, "ChessRiddle is busy. Sync will retry automatically."],
    [
      { status: "serverError" },
      "ChessRiddle could not complete the request. Sync will retry automatically.",
    ],
    [
      { status: "signInNeeded" },
      "Your ChessRiddle session expired. Sign in again under Accounts to continue syncing.",
    ],
    [{ status: "unavailable" }, "Library sync is not available on ChessRiddle yet."],
    [
      { status: "folderUnavailable" },
      "This Library folder is currently unavailable. No files were removed from ChessRiddle.",
    ],
    [{ status: "localError" }, "Could not read or save local sync state."],
    [
      { status: "otherFolder" },
      "Sync is on for another Library folder. Turn off sync there before turning it on for this folder.",
    ],
    [{ status: "removing", done: 0, total: 0 }, "Removing synced files from ChessRiddle (0 of 0)…"],
  ])("renders state summary for %s", async (state, expectedText) => {
    await renderDialog(makeSnapshot(state));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(expectedText);
  });

  it.each<[LibrarySyncError, string]>([
    ["busy", "Sync is busy. Try again in a moment."],
    ["localStorage", "Could not read or save local sync state."],
    [
      "invalidWorkspace",
      "This Library folder is currently unavailable. No files were removed from ChessRiddle.",
    ],
    ["notActive", "Sync is currently turned off."],
    ["unavailable", "Library sync is not available on ChessRiddle yet."],
  ])("renders command error alert for %s", async (error, expectedText) => {
    await renderDialog(makeSnapshot({ status: "synced" }), { error });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(expectedText);
  });

  it("handles file selection toggle, Sync now, busy disabling, and Turn off keep/remove confirmation", async () => {
    const f1 = makeFile("f-1", "Repertoire", { kind: "synced" }, true);
    const onSetFileSelected = vi.fn(async () => {});
    const onSyncNow = vi.fn(async () => {});
    const onTurnOff = vi.fn(async () => {});

    await renderDialog(makeSnapshot({ status: "synced" }, [f1]), {
      onSetFileSelected,
      onSyncNow,
      onTurnOff,
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await clickElement(checkbox);
    expect(onSetFileSelected).toHaveBeenCalledWith(f1.handle, false);

    await clickElement(findButton("Sync now"));
    expect(onSyncNow).toHaveBeenCalledTimes(1);

    // Busy disables checkboxes and Turn off sync.
    await renderDialog(makeSnapshot({ status: "synced" }, [f1]), { busy: true });
    expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(findButton("Turn off sync")!.disabled).toBe(true);

    await renderDialog(makeSnapshot({ status: "synced" }, [f1]), {
      onSetFileSelected,
      onSyncNow,
      onTurnOff,
    });

    await clickElement(findButton("Turn off sync"));
    const radios = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);

    await clickElement(findButton("Turn off sync"));
    expect(onTurnOff).toHaveBeenCalledWith("keep");

    await clickElement(radios[1]);
    await clickElement(findButton("Turn off sync"));
    expect(onTurnOff).toHaveBeenCalledWith("remove");

    await clickElement(findButton("Cancel"));
    expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it("resets local deselections and turn-off confirmation across workspace changes and state transitions", async () => {
    const f1 = makeFile("f-1", "Sicilian", { kind: "pending" }, true);

    // Off mode: deselect f1, then transition to active -> back to off resets deselections.
    await renderDialog(makeSnapshot({ status: "off" }, [f1], { active: false }));
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await clickElement(checkbox);
    expect(checkbox.checked).toBe(false);

    await renderDialog(makeSnapshot({ status: "synced" }, [f1], { active: true }));
    await clickElement(findButton("Turn off sync"));
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);

    // Transitioning to removing clears turnOffConfirm.
    await renderDialog(
      makeSnapshot({ status: "removing", done: 1, total: 2 }, [], { active: true }),
    );
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);

    // Back to off: f1 is selected again.
    await renderDialog(makeSnapshot({ status: "off" }, [f1], { active: false }));
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);

    // Workspace change also resets turnOffConfirm.
    await renderDialog(makeSnapshot({ status: "synced" }, [f1], { active: true }));
    await clickElement(findButton("Turn off sync"));
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    await renderDialog(
      makeSnapshot({ status: "synced" }, [f1], { active: true, ws: otherWorkspace }),
    );
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it("shows only Turn off sync with keep or remove choice in otherFolder mode", async () => {
    const onTurnOff = vi.fn(async () => {});
    await renderDialog(makeSnapshot({ status: "otherFolder" }), { onTurnOff });

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("another Library folder");
    expect(findButton("Sync now")).toBeUndefined();
    expect(findButton("Turn on sync")).toBeUndefined();

    await clickElement(findButton("Turn off sync"));
    const radios = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios[0].checked).toBe(true);
    await clickElement(findButton("Turn off sync"));
    expect(onTurnOff).toHaveBeenCalledWith("keep");
  });

  it("shows progress and no other actions in removing mode, including total 0", async () => {
    await renderDialog(makeSnapshot({ status: "removing", done: 3, total: 10 }));

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Removing synced files from ChessRiddle (3 of 10)…");
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("30");
    expect(findButton("Sync now")).toBeUndefined();
    expect(findButton("Turn off sync")).toBeUndefined();
    expect(findButton("Turn on sync")).toBeUndefined();

    await renderDialog(makeSnapshot({ status: "removing", done: 0, total: 0 }));
    expect(dialog.textContent).toContain("Removing synced files from ChessRiddle (0 of 0)…");
    expect(dialog.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
  });

  it("renders no checkboxes and keeps Turn off sync and Sync now for an active pausing snapshot with no files", async () => {
    const onSyncNow = vi.fn(async () => {});
    const onTurnOff = vi.fn(async () => {});
    await renderDialog(makeSnapshot({ status: "offline" }, [], { active: true }), {
      onSyncNow,
      onTurnOff,
    });

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(
      "Offline. Sync will continue when ChessRiddle is reachable.",
    );
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(findButton("Turn off sync")).toBeDefined();
    expect(findButton("Sync now")).toBeDefined();
  });
});
