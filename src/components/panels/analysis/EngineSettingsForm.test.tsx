import { WorkspaceTabScope } from "@/state/tabScope";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Engine } from "@/utils/engines";
import EngineSettingsForm, { type Settings } from "./EngineSettingsForm";

const mocks = vi.hoisted(() => ({
  activeTabAtom: Symbol("activeTabAtom"),
  enginesAtom: Symbol("enginesAtom"),
  killEngine: vi.fn(),
  navigate: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
}));

const engines: Engine[] = [
  {
    type: "local",
    id: "engine-1",
    name: "Duplicate",
    version: "17",
    filename: "first",
    handle: { id: { id: "handle-1" }, kind: "engine" },
    settings: [{ type: "string", name: "MultiPV", value: "2" }],
  },
  {
    type: "local",
    id: "engine-2",
    name: "Duplicate",
    version: "17",
    filename: "second",
    handle: { id: { id: "handle-2" }, kind: "engine" },
    settings: [{ type: "string", name: "MultiPV", value: "9" }],
  },
];

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/utils/engines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/engines")>()),
  killEngine: mocks.killEngine,
}));
vi.mock("@/state/atoms", () => ({
  activeTabAtom: mocks.activeTabAtom,
  enginesAtom: mocks.enginesAtom,
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: symbol) => (atom === mocks.activeTabAtom ? "tab-B" : engines),
}));
vi.mock("@mantine/core", () => ({
  Checkbox: ({ label, checked, onChange }: any) => (
    <input
      aria-label={label}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event)}
    />
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("lucide-react", () => ({
  Square: () => null,
  Settings: () => null,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ label, onClick, children }: any) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/common/GoModeInput", () => ({ default: () => null }));
vi.mock("./CoresSlider", () => ({ default: () => null }));
vi.mock("./HashSlider", () => ({ default: () => null }));
vi.mock("./LinesSlider", () => ({
  default: ({ value, setValue }: { value: number; setValue: (value: number) => void }) => (
    <>
      <output data-testid="multipv">{value}</output>
      <button type="button" onClick={() => setValue(5)}>
        5 lines
      </button>
    </>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const settings: Settings = {
  enabled: true,
  go: { t: "Infinite" },
  settings: [
    { type: "string", name: "MultiPV", value: "2" },
    { type: "string", name: "MultiPV", value: "4" },
  ],
  synced: false,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(setSettings = vi.fn()) {
  await act(async () => {
    root.render(
      <WorkspaceTabScope tabId="tab-A">
        <EngineSettingsForm
          engine={engines[1]}
          settings={settings}
          setSettings={setSettings}
          remote={false}
        />
      </WorkspaceTabScope>,
    );
  });
  return setSettings;
}

test("uses last-wins settings and immutable ids for sync and advanced navigation", async () => {
  const setSettings = await render();

  expect(host.querySelector('[data-testid="multipv"]')?.textContent).toBe("4");
  await act(async () => {
    (host.querySelector('[aria-label="Board.Analysis.SyncGlobally"]') as HTMLInputElement).click();
  });
  const update = setSettings.mock.calls[0][0] as (value: Settings) => Settings;
  expect(update(settings).settings).toEqual(engines[1].settings);

  await act(async () => {
    (
      host.querySelector('[aria-label="Engines.Settings.AdvancedSettings"]') as HTMLButtonElement
    ).click();
  });
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/engines", search: { selected: 1 } });
});

test("selecting a line count updates MultiPV through the settings setter", async () => {
  const setSettings = await render();
  const previous: Settings = {
    ...settings,
    settings: [...settings.settings, { type: "string", name: "Hash", value: "128" }],
  };
  await act(async () => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "5 lines")!
      .click();
  });
  const update = setSettings.mock.calls[0][0] as (value: Settings) => Settings;
  expect(update(previous)).toEqual({
    ...previous,
    settings: [
      { type: "string", name: "MultiPV", value: "5" },
      { type: "string", name: "MultiPV", value: "5" },
      { type: "string", name: "Hash", value: "128" },
    ],
  });
  expect(previous.settings[1]).toEqual({ type: "string", name: "MultiPV", value: "4" });
});

test("a rejected kill leaves enabled state unchanged and notifies", async () => {
  const failure = new Error("kill failed");
  mocks.killEngine.mockRejectedValue(failure);
  const setSettings = await render();

  await act(async () => {
    (host.querySelector('[aria-label="Board.Analysis.KillEngine"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });

  expect(mocks.killEngine).toHaveBeenCalledWith(
    expect.objectContaining({ id: "engine-2" }),
    "tab-A",
  );
  expect(setSettings).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
});

test("a successful kill disables the engine", async () => {
  mocks.killEngine.mockResolvedValue(undefined);
  const setSettings = await render();

  await act(async () => {
    (host.querySelector('[aria-label="Board.Analysis.KillEngine"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });

  expect(setSettings).toHaveBeenCalled();
  const update = setSettings.mock.calls[0][0] as (value: Settings) => Settings;
  expect(update(settings).enabled).toBe(false);
});
