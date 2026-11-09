import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
  getEngineWorkspace: vi.fn(),
  openEngineWorkspace: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: native.notify } }));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./IconAction", () => ({
  IconAction: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      Open
    </button>
  ),
}));

import OpenFolderButton from "./OpenFolderButton";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  native.getEngineWorkspace.mockResolvedValue({
    root: { id: { id: "engine-root" }, kind: "engineRoot" },
    displayName: "Engines",
  });
  native.openEngineWorkspace.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("opens only the native engine workspace capability", async () => {
  await act(async () => root.render(<OpenFolderButton />));
  await act(async () => container.querySelector("button")!.click());

  expect(native.getEngineWorkspace).toHaveBeenCalledOnce();
  expect(native.openEngineWorkspace).toHaveBeenCalledWith({
    id: { id: "engine-root" },
    kind: "engineRoot",
  });
});

test.each(["labelled", "unlabelled"])(
  "handles %s workspace acquisition rejection",
  async (outcome) => {
    native.getEngineWorkspace.mockRejectedValue({
      tag: "backend-error",
      category: "io",
      message: "native failure",
      ...(outcome === "labelled" ? { rootFailure: "missing" } : {}),
    });
    await act(async () => root.render(<OpenFolderButton />));
    await act(async () => container.querySelector("button")!.click());
    expect(native.openEngineWorkspace).not.toHaveBeenCalled();
    expect(native.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message:
        outcome === "labelled"
          ? "This engine folder is no longer available. Choose another in Settings."
          : "native failure",
    });
  },
);

test("keeps workspace acquisition cancellation silent", async () => {
  native.getEngineWorkspace.mockRejectedValue({
    tag: "backend-error",
    category: "cancellation",
    message: "Cancellation",
    rootFailure: "changed",
  });
  await act(async () => root.render(<OpenFolderButton />));
  await act(async () => container.querySelector("button")!.click());
  expect(native.openEngineWorkspace).not.toHaveBeenCalled();
  expect(native.notify).not.toHaveBeenCalled();
});

test("notifies a failure to open an acquired folder", async () => {
  native.openEngineWorkspace.mockRejectedValue(new Error("open failed"));
  await act(async () => root.render(<OpenFolderButton />));
  await act(async () => container.querySelector("button")!.click());
  expect(native.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: "open failed",
  });
});
