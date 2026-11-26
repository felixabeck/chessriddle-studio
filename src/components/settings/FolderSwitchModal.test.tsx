import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDefaultStore, useAtomValue } from "jotai";
import { notifications } from "@mantine/notifications";
import { enginesAtom, fileWorkspaceAtom, fileWorkspaceDisplayNameAtom } from "@/state/atoms";
import { writeDefaultFileWorkspace } from "@/utils/files";
import { choosePuzzleDatabase } from "@/utils/puzzles";
import { rootFailureMessage } from "@/components/files/listingFailure";
import { FolderSwitchDialogHost } from "./FolderSwitchModal";
import { WorkspaceDirectorySetting } from "./WorkspaceDirectorySetting";
import {
  folderSwitchFailureMessage,
  runFolderSwitch,
  setPendingFolderSwitch,
} from "./folderSwitch";

const applyFolderSwitch = vi.fn();
const cancelFolderSwitch = vi.fn();
const getDefaultFileWorkspace = vi.fn();
const issuePuzzleWorkspace = vi.fn();
const getEngineFolderStatus = vi.fn();
const issueEngineWorkspace = vi.fn();

vi.mock("@/platform/tauri", () => ({
  tauri: {
    applyFolderSwitch: (...args: unknown[]) => applyFolderSwitch(...args),
    cancelFolderSwitch: (...args: unknown[]) => cancelFolderSwitch(...args),
    getDefaultFileWorkspace: (...args: unknown[]) => getDefaultFileWorkspace(...args),
    issuePuzzleWorkspace: (...args: unknown[]) => issuePuzzleWorkspace(...args),
    getEngineFolderStatus: (...args: unknown[]) => getEngineFolderStatus(...args),
    issueEngineWorkspace: (...args: unknown[]) => issueEngineWorkspace(...args),
  },
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("@/platform/native", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let lastModalProps: { onClose?: () => void; pending?: boolean } | null = null;
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children, title, onClose, pending }: any) => {
    lastModalProps = { onClose, pending };
    return opened ? (
      <div role="dialog" aria-label={title} data-pending={String(Boolean(pending))}>
        {children}
      </div>
    ) : null;
  },
}));

vi.mock("@mantine/core", () => ({
  ActionIcon: ({ children, onClick, "aria-label": ariaLabel }: any) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Group: ({ children }: any) => <div>{children}</div>,
  Input: ({ children, onClick, "aria-label": ariaLabel }: any) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, role }: any) => <span role={role}>{children}</span>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  applyFolderSwitch.mockReset();
  cancelFolderSwitch.mockReset().mockResolvedValue(undefined);
  getDefaultFileWorkspace.mockReset();
  issuePuzzleWorkspace.mockReset();
  getEngineFolderStatus.mockReset();
  issueEngineWorkspace.mockReset();
  vi.mocked(notifications.show).mockReset();
  lastModalProps = null;
  setPendingFolderSwitch(null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("dialog is not shown for Activated and resolves immediately", async () => {
  await act(async () => root.render(<FolderSwitchDialogHost />));
  const result = await runFolderSwitch(async () => ({
    status: "activated",
    descriptor: {
      root: { id: { id: "r1" }, kind: "databaseRoot" },
      displayName: "Databases",
    },
  }));
  expect(result).toEqual({ switched: true, displayName: "Databases" });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("dialog is shown for Pending, applies Move and UseOnly, and keeps persisted engines byte-identical with a mounted Engines consumer", async () => {
  const initialEngines = JSON.stringify([
    {
      type: "local",
      name: "Stockfish",
      version: "17",
      path: { id: { id: "ref-1" }, kind: "engine" },
      loaded: true,
      settings: [],
    },
  ]);
  localStorage.setItem("engines", initialEngines);

  getEngineFolderStatus.mockResolvedValue({ displayName: "OldEngines", isDefault: false });
  issueEngineWorkspace.mockResolvedValue({
    status: "pending",
    grant: { id: { id: "g1" }, kind: "engine" },
    displayName: "MovedFolder",
    itemCount: 2,
  });
  applyFolderSwitch.mockResolvedValue({
    displayName: "MovedFolder",
    isDefault: false,
  });

  const onSelected = vi.fn();
  function EnginesRowHarness() {
    const engines = useAtomValue(enginesAtom);
    return (
      <>
        <div data-testid="engine-count">{Array.isArray(engines) ? engines.length : 0}</div>
        <WorkspaceDirectorySetting
          load={() => getEngineFolderStatus()}
          issue={async () => {
            const result = await runFolderSwitch(() => issueEngineWorkspace());
            if (!result.switched) return null;
            return result.status ?? (await getEngineFolderStatus());
          }}
          onSelected={onSelected}
          onError={() => {}}
        />
        <FolderSwitchDialogHost />
      </>
    );
  }

  await act(async () => root.render(<EnginesRowHarness />));
  await act(async () => {});

  const pickerBtn = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("OldEngines"),
  ) as HTMLButtonElement;
  expect(pickerBtn).not.toBeNull();
  await act(async () => pickerBtn.click());
  await act(async () => {});
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();

  const moveBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Settings.Directories.SwitchDialog.Move",
  )!;
  await act(async () => moveBtn.click());
  expect(applyFolderSwitch).toHaveBeenCalledWith({ id: { id: "g1" }, kind: "engine" }, "move");
  expect(onSelected).toHaveBeenCalledWith("MovedFolder");
  expect(localStorage.getItem("engines")).toBe(initialEngines);

  // Now UseOnly
  applyFolderSwitch.mockResolvedValue({ displayName: "OnlyFolder", isDefault: false });
  const useOnlyPromise = runFolderSwitch(async () => ({
    status: "pending",
    grant: { id: { id: "g2" }, kind: "engine" },
    displayName: "OnlyFolder",
    itemCount: 1,
  }));
  await act(async () => {});
  const useOnlyBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Settings.Directories.SwitchDialog.UseOnly",
  )!;
  await act(async () => useOnlyBtn.click());
  const useOnlyResult = await useOnlyPromise;
  expect(useOnlyResult.switched).toBe(true);
  expect(applyFolderSwitch).toHaveBeenCalledWith({ id: { id: "g2" }, kind: "engine" }, "useOnly");
  expect(localStorage.getItem("engines")).toBe(initialEngines);
});

test("modal Cancel calls cancelFolderSwitch and returns switched=false through choosePuzzleDatabase", async () => {
  issuePuzzleWorkspace.mockResolvedValue({
    status: "pending",
    grant: { id: { id: "gp1" }, kind: "puzzle" },
    displayName: "NewPuzzles",
    itemCount: 3,
  });
  await act(async () => root.render(<FolderSwitchDialogHost />));
  const promise = choosePuzzleDatabase();
  await act(async () => {});
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();

  const cancelBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Common.Cancel",
  )!;
  await act(async () => cancelBtn.click());
  const result = await promise;
  expect(result).toEqual({ switched: false });
  expect(cancelFolderSwitch).toHaveBeenCalledWith({ id: { id: "gp1" }, kind: "puzzle" });
});

test("apply rejection renders translated alert and dismissal is blocked while pending", async () => {
  let rejectApply!: (reason: unknown) => void;
  applyFolderSwitch.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectApply = reject;
      }),
  );

  await act(async () => root.render(<FolderSwitchDialogHost />));
  const pendingPromise = runFolderSwitch(async () => ({
    status: "pending",
    grant: { id: { id: "g-err" }, kind: "database" },
    displayName: "Target",
    itemCount: 1,
  }));
  await act(async () => {});

  const moveBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Settings.Directories.SwitchDialog.Move",
  )!;
  await act(async () => moveBtn.click());

  // While pending: AppModal pending=true, Cancel disabled, onClose ignored.
  expect(lastModalProps?.pending).toBe(true);
  const cancelBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Common.Cancel",
  ) as HTMLButtonElement;
  expect(cancelBtn.disabled).toBe(true);
  await act(async () => lastModalProps?.onClose?.());
  expect(cancelFolderSwitch).not.toHaveBeenCalled();

  // Reject with structured FolderSwitchFailure -> translated message shown in role="alert".
  await act(async () => {
    rejectApply({
      tag: "folder-switch",
      category: "conflict",
      message: "collision",
      folderSwitch: { reason: "name-collision", count: 2 },
    });
  });
  const alertEl = host.querySelector('[role="alert"]');
  expect(alertEl?.textContent).toBe("Settings.Directories.SwitchError.NameCollision");

  // Now Cancel dismisses cleanly.
  await act(async () => cancelBtn.click());
  expect(await pendingPromise).toEqual({ switched: false });
});

test("post-commit deferred cleanup (rootFailure=interrupted-move) shows error toast instead of success", async () => {
  applyFolderSwitch.mockResolvedValue({
    displayName: "Target",
    isDefault: false,
    rootFailure: "interrupted-move",
  });
  await act(async () => root.render(<FolderSwitchDialogHost />));
  const promise = runFolderSwitch(async () => ({
    status: "pending",
    grant: { id: { id: "g-def" }, kind: "database" },
    displayName: "Target",
    itemCount: 1,
  }));
  await act(async () => {});
  const moveBtn = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Settings.Directories.SwitchDialog.Move",
  )!;
  await act(async () => moveBtn.click());
  await promise;

  expect(notifications.show).toHaveBeenCalledWith(
    expect.objectContaining({
      color: "danger",
      message: "Settings.Directories.SwitchError.InterruptedMove",
    }),
  );
  expect(notifications.show).not.toHaveBeenCalledWith(
    expect.objectContaining({ color: "success" }),
  );
});

test("refusal and interrupted-move labels map to translated text", () => {
  const t = ((key: string, opts?: Record<string, unknown>) =>
    opts?.count != null ? `${key}:${opts.count}` : key) as any;
  expect(folderSwitchFailureMessage({ reason: "name-collision", count: 4 }, t)).toBe(
    "Settings.Directories.SwitchError.NameCollision:4",
  );
  expect(folderSwitchFailureMessage({ reason: "rollback-incomplete" }, t)).toBe(
    "Settings.Directories.SwitchError.RollbackIncomplete",
  );
  expect(folderSwitchFailureMessage({ reason: "interrupted-move" }, t)).toBe(
    "Settings.Directories.SwitchError.InterruptedMove",
  );
  expect(
    rootFailureMessage(
      "database",
      { tag: "folder-switch", category: "conflict", message: "x", rootFailure: "interrupted-move" },
      t,
    ),
  ).toBe("Databases.LoadError.InterruptedMove");
});

test("PGN restore replaces custom selection with default handle and keeps custom handle on failure", async () => {
  const store = getDefaultStore();
  const customHandle = { id: { id: "custom-pgn" }, kind: "fileWorkspace" as const };
  store.set(fileWorkspaceAtom, customHandle);
  store.set(fileWorkspaceDisplayNameAtom, "CustomPGN");

  getDefaultFileWorkspace.mockRejectedValueOnce(new Error("home unavailable"));
  await expect(writeDefaultFileWorkspace()).rejects.toThrow("home unavailable");
  expect(store.get(fileWorkspaceAtom)).toEqual(customHandle);
  expect(store.get(fileWorkspaceDisplayNameAtom)).toBe("CustomPGN");

  const defaultHandle = { id: { id: "default-pgn" }, kind: "fileWorkspace" as const };
  getDefaultFileWorkspace.mockResolvedValueOnce({
    handle: defaultHandle,
    displayName: "PGN",
    availability: "available",
  });
  const restored = await writeDefaultFileWorkspace();
  expect(restored).toEqual(defaultHandle);
  expect(store.get(fileWorkspaceAtom)).toEqual(defaultHandle);
  expect(store.get(fileWorkspaceDisplayNameAtom)).toBe("PGN");
});
