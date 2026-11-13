import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { saveEngineLogs, notifyUnlessCancelled } = vi.hoisted(() => ({
  saveEngineLogs: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({ tauri: { saveEngineLogs } }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled }));
vi.mock("@/state/atoms", () => ({ fontSizeAtom: {} }));
vi.mock("jotai", () => ({ useAtomValue: () => 100 }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [] }),
}));
vi.mock("./IconAction", () => ({
  IconAction: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      Export
    </button>
  ),
}));
vi.mock("@mantine/core", () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Divider: () => <hr />,
  Group: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SegmentedControl: () => <div />,
  Stack: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  TextInput: () => <input />,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import EngineLogsView from "./EngineLogsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  saveEngineLogs.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("reports a refused engine-log save", async () => {
  const failure = new Error("Permission denied");
  saveEngineLogs.mockRejectedValue(failure);
  await act(async () => {
    root.render(<EngineLogsView logs={[]} />);
  });
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Engines.Logs.Export"]')!;
  await act(async () => button.click());
  expect(notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
});
