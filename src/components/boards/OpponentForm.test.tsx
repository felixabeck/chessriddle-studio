import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { OpponentSettings } from "@/state/opponentSettings";
import { OpponentForm } from "./OpponentForm";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react", () => ({
  Brain: () => null,
  User: () => null,
}));
vi.mock("@/components/common/GoModeInput", () => ({ default: () => null }));
vi.mock("@/components/common/TimeInput", () => ({ default: () => null }));
vi.mock("@/components/panels/analysis/EngineSettingsForm", () => ({ default: () => null }));
const picker = vi.hoisted(() => ({ setEngine: null as ((engine: unknown) => void) | null }));
vi.mock("./EnginesSelect", () => ({
  EnginesSelect: ({ setEngine }: { setEngine: (engine: unknown) => void }) => {
    picker.setEngine = setEngine;
    return null;
  },
}));
vi.mock("@mantine/core", () => ({
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Divider: () => null,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SegmentedControl: ({
    data,
    onChange,
    value,
  }: {
    data: Array<{ value: string; label: React.ReactNode }>;
    onChange: (value: string) => void;
    value: string;
  }) => (
    <div data-value={value}>
      {data.map((item) => (
        <button
          key={item.value}
          type="button"
          data-option={item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextInput: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

function renderOpponent(opponent: OpponentSettings) {
  let current = opponent;
  const setOpponent = vi.fn((update: React.SetStateAction<OpponentSettings>) => {
    current = typeof update === "function" ? update(current) : update;
  });
  const setOtherOpponent = vi.fn();
  act(() => {
    root.render(
      <OpponentForm
        sameTimeControl={false}
        opponent={opponent}
        setOpponent={setOpponent}
        setOtherOpponent={setOtherOpponent}
      />,
    );
  });
  return { getCurrent: () => current, setOpponent };
}

test("human to engine creates the exact engine branch", () => {
  const { getCurrent, setOpponent } = renderOpponent({
    type: "human",
    name: "Alice",
    timeControl: { seconds: 30, increment: 2 },
    timeUnit: "s",
    incrementUnit: "s",
  });

  host.querySelector<HTMLButtonElement>('[data-option="engine"]')?.click();

  expect(setOpponent).toHaveBeenCalledOnce();
  expect(getCurrent()).toEqual({
    type: "engine",
    engine: null,
    go: { t: "Depth", c: 24 },
    timeControl: { seconds: 30, increment: 2 },
    timeUnit: "s",
    incrementUnit: "s",
  });
});

test("engine to human removes engine-owned fields while retaining shared time", () => {
  const { getCurrent, setOpponent } = renderOpponent({
    type: "engine",
    engine: null,
    go: { t: "Nodes", c: 1000 },
    engineSettings: [{ type: "string", name: "Threads", value: "2" }],
    timeControl: { seconds: 60, increment: 0 },
    timeUnit: "s",
    incrementUnit: "s",
  });

  host.querySelector<HTMLButtonElement>('[data-option="human"]')?.click();

  expect(setOpponent).toHaveBeenCalledOnce();
  expect(getCurrent()).toEqual({
    type: "human",
    name: "Player",
    timeControl: { seconds: 60, increment: 0 },
    timeUnit: "s",
    incrementUnit: "s",
  });
});

test("a refreshed record for the same engine keeps the per-game settings", () => {
  const selected = {
    type: "local" as const,
    id: "engine-a",
    name: "Engine A",
    version: "1",
    filename: "a",
    handle: { id: { id: "a" }, kind: "engine" as const },
    settings: [{ type: "string" as const, name: "Threads", value: "1" }],
  };
  const { getCurrent } = renderOpponent({
    type: "engine",
    engine: selected,
    go: { t: "Depth", c: 20 },
    engineSettings: [{ type: "string", name: "Threads", value: "8" }],
  });

  // Editing the engine's global settings must not silently discard this player's overrides.
  act(() => picker.setEngine?.({ ...selected, name: "Engine A renamed" }));
  expect(getCurrent()).toMatchObject({
    engine: { name: "Engine A renamed" },
    engineSettings: [{ type: "string", name: "Threads", value: "8" }],
  });

  // Choosing a different engine does replace them with that engine's own settings.
  act(() =>
    picker.setEngine?.({
      ...selected,
      id: "engine-b",
      settings: [{ type: "string", name: "Hash", value: "512" }],
    }),
  );
  expect(getCurrent()).toMatchObject({
    engineSettings: [{ type: "string", name: "Hash", value: "512" }],
  });

  // Clearing the selection clears the overrides with it.
  act(() => picker.setEngine?.(null));
  expect(getCurrent()).toMatchObject({ engine: null, engineSettings: undefined });
});
