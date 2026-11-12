import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LocalEngine } from "@/utils/engines";

vi.mock("@/state/atoms", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return { enginesAtom: atom<unknown[] | undefined>(undefined) };
});
vi.mock("@mantine/core", () => ({
  Select: ({
    value,
    data,
    "aria-label": label,
  }: {
    value: string;
    data: Array<{ value: string; label: string }>;
    "aria-label"?: string;
  }) => (
    <div
      aria-label={label}
      data-value={value}
      data-options={data.map((option) => option.value).join(",")}
    />
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { getDefaultStore } = await import("jotai");
const { enginesAtom } = await import("@/state/atoms");
const { EnginesSelect } = await import("./EnginesSelect");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const store = getDefaultStore();

function localEngine(id: string): LocalEngine {
  return {
    type: "local",
    id,
    name: `Engine ${id}`,
    version: "1",
    handle: { id: { id: `handle-${id}` }, kind: "engine" as const },
    filename: `${id}.bin`,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  store.set(enginesAtom as never, undefined as never);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(engine: LocalEngine | null) {
  const selections: Array<LocalEngine | null> = [];
  let current = engine;
  const setEngine = (next: LocalEngine | null) => {
    selections.push(next);
    current = next;
  };
  const draw = () => {
    act(() => {
      root.render(<EnginesSelect engine={current} setEngine={setEngine} />);
    });
  };
  draw();
  return { selections, draw, getCurrent: () => current };
}

test("an unhydrated engine store leaves the saved selection intact", () => {
  const { selections, getCurrent } = render(localEngine("a"));
  expect(host.firstElementChild?.getAttribute("aria-label")).toBe("Common.Engine");

  expect(selections).toEqual([]);
  expect(getCurrent()?.id).toBe("a");
});

test("an engine list that becomes untrusted leaves the saved selection intact", () => {
  const a = localEngine("a");
  store.set(enginesAtom as never, [a] as never);
  const { selections, draw, getCurrent } = render(a);

  act(() => {
    store.set(enginesAtom as never, undefined as never);
  });
  draw();

  expect(selections).toEqual([]);
  expect(getCurrent()?.id).toBe("a");
});

test("removing the selected engine falls back to a remaining engine", () => {
  const a = localEngine("a");
  const b = localEngine("b");
  store.set(enginesAtom as never, [a, b] as never);
  const { selections, draw, getCurrent } = render(a);

  expect(selections).toEqual([]);

  act(() => {
    store.set(enginesAtom as never, [b] as never);
  });
  draw();

  expect(getCurrent()).toEqual(b);
  expect(selections).toEqual([b]);
});

test("removing the last engine clears the selection instead of keeping a retired id", () => {
  const a = localEngine("a");
  store.set(enginesAtom as never, [a] as never);
  const { draw, getCurrent } = render(a);

  act(() => {
    store.set(enginesAtom as never, [] as never);
  });
  draw();

  expect(getCurrent()).toBeNull();
});

test("an empty selection adopts the first engine, and an updated record is re-read", () => {
  const a = localEngine("a");
  store.set(enginesAtom as never, [a] as never);
  const { draw, getCurrent } = render(null);

  expect(getCurrent()).toEqual(a);

  const renamed = { ...a, name: "Engine renamed" };
  act(() => {
    store.set(enginesAtom as never, [renamed] as never);
  });
  draw();

  expect(getCurrent()?.name).toBe("Engine renamed");
});

test("remote engines are never offered or selected", () => {
  store.set(enginesAtom as never, [{ type: "remote", id: "r", name: "Remote" }] as never);
  const { getCurrent } = render(null);

  expect(getCurrent()).toBeNull();
  expect(host.firstElementChild?.getAttribute("data-options")).toBe("");
});
