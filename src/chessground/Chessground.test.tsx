import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import type { Config } from "@lichess-org/chessground/config";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { defaults } from "@lichess-org/chessground/state";
import { afterEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { getDefaultStore } from "jotai";
import { boardAnimationSpeedAtom } from "@/state/atoms";
import { Chessground } from "./Chessground";

const { api, createChessground } = vi.hoisted(() => {
  const api = {
    destroy: vi.fn(),
    set: vi.fn(),
    setAutoShapes: vi.fn(),
    setShapes: vi.fn(),
    playPremove: vi.fn(() => false),
    cancelPremove: vi.fn(),
    selectSquare: vi.fn(),
    state: {
      drawable: { current: undefined as object | undefined },
      premovable: { current: undefined as string[] | undefined },
      dom: { bounds: { clear: vi.fn() } },
    },
    getFen: vi.fn(() => "start"),
  };
  const createChessground = vi.fn((_element: HTMLElement, _config: Config) => api);
  return { api, createChessground };
});
const mountedRoots = new Set<ReturnType<typeof createRoot>>();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
installMatchMediaStub();

const observed = new Map<Element, () => void>();
class MockResizeObserver implements ResizeObserver {
  private readonly elements = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(element: Element) {
    this.elements.add(element);
    observed.set(element, () => this.callback([], this));
  }

  unobserve(element: Element) {
    this.elements.delete(element);
    observed.delete(element);
  }

  disconnect() {
    for (const element of this.elements) observed.delete(element);
    this.elements.clear();
  }
}
Object.assign(globalThis, { ResizeObserver: MockResizeObserver });

vi.mock("@lichess-org/chessground", () => ({ Chessground: createChessground }));
// An invalid stored preference logs through the native facade, which has no Tauri host here.
vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  warn: vi.fn(),
}));

afterEach(async () => {
  for (const root of mountedRoots) await act(async () => root.unmount());
  mountedRoots.clear();
  api.destroy.mockClear();
  api.set.mockClear();
  api.setAutoShapes.mockClear();
  api.setShapes.mockClear();
  api.state.drawable.current = undefined;
  api.state.dom.bounds.clear.mockClear();
  createChessground.mockClear();
  observed.clear();
  vi.restoreAllMocks();
});

async function renderDrawable(drawable: Config["drawable"]) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 400),
  );
  const root = createRoot(document.createElement("div"));
  mountedRoots.add(root);
  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground drawable={drawable} />
      </MantineProvider>,
    );
  });
  const config = createChessground.mock.calls[0][1];
  expect(config.drawable?.onChange).toBeTypeOf("function");
  return config.drawable!.onChange!;
}

test("explicit false restores normalized saved shapes after an ordinary clear without forwarding it", async () => {
  const savedShapes: DrawShape[] = [
    { orig: "h5", dest: "h5", brush: "cyan" },
    { orig: "e2", dest: "e4", brush: "blue" },
  ];
  const onChange = vi.fn();
  const changeShapes = await renderDrawable({
    eraseOnMovablePieceClick: false,
    shapes: savedShapes,
    onChange,
  });
  expect(createChessground.mock.calls[0][1].drawable?.shapes).toEqual([
    { orig: "h5", dest: undefined, brush: "cyan" },
    savedShapes[1],
  ]);

  await act(async () => changeShapes([]));

  expect(api.setShapes).toHaveBeenCalledExactlyOnceWith([
    { orig: "h5", dest: undefined, brush: "cyan" },
    savedShapes[1],
  ]);
  expect(onChange).not.toHaveBeenCalled();
  expect(savedShapes[0].dest).toBe("h5");
});

test.each([false, true])(
  "explicit false forwards a drawing gesture while it is active, toggling off: %s",
  async (toggleOff) => {
    const savedShape: DrawShape = { orig: "c4", brush: "green" };
    const onChange = vi.fn();
    const changeShapes = await renderDrawable({
      eraseOnMovablePieceClick: false,
      shapes: [savedShape],
      onChange,
    });
    api.state.drawable.current = { orig: "c4" };
    const shapes: DrawShape[] = toggleOff
      ? []
      : [savedShape, { orig: "e2", dest: "e4", brush: "blue" }];

    await act(async () => changeShapes(shapes));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(shapes);
    expect(api.setShapes).not.toHaveBeenCalled();
  },
);

test.each([true, undefined])(
  "forwards an ordinary empty-shape change with erase preference %s",
  async (eraseOnMovablePieceClick) => {
    const onChange = vi.fn();
    const changeShapes = await renderDrawable({
      eraseOnMovablePieceClick,
      shapes: [{ orig: "c4", brush: "green" }],
      onChange,
    });

    await act(async () => changeShapes([]));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
    expect(api.setShapes).not.toHaveBeenCalled();
  },
);

test("constructs Chessground once, updates it, and destroys it on unmount", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const chessgroundRef = createRef<import("./Chessground").ChessgroundRef>();

  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground ref={chessgroundRef} fen="start" orientation="white" />
      </MantineProvider>,
    );
  });
  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground ref={chessgroundRef} fen="8/8/8/8/8/8/8/8" orientation="black" />
      </MantineProvider>,
    );
  });
  expect(createChessground).toHaveBeenCalledTimes(1);
  expect(api.set).toHaveBeenCalled();

  api.selectSquare
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      api.state.premovable.current = ["e2", "e4"];
    });
  expect(chessgroundRef.current?.queuePremove("e2", "e4")).toBe(true);
  expect(api.selectSquare).toHaveBeenNthCalledWith(1, "e2");
  expect(api.selectSquare).toHaveBeenNthCalledWith(2, "e4");

  await act(async () => root.unmount());
  expect(api.destroy).toHaveBeenCalledTimes(1);
});

test("defers saved shapes until the observed board has positive bounds", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const savedShape = { orig: "h5", dest: "h5", brush: "cyan" } as const;
  const automaticShape = { orig: "e2", dest: "e4", brush: "blue" } as const;

  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground drawable={{ shapes: [savedShape], autoShapes: [automaticShape] }} />
      </MantineProvider>,
    );
  });
  expect(createChessground).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ drawable: expect.objectContaining({ shapes: [], autoShapes: [] }) }),
  );
  expect(api.set).toHaveBeenLastCalledWith(
    expect.objectContaining({ drawable: expect.objectContaining({ shapes: [], autoShapes: [] }) }),
  );
  expect(observed.size).toBe(1);
  const [element, onResize] = [...observed.entries()][0];
  expect(element.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 });
  await act(async () => onResize());
  expect(api.state.dom.bounds.clear).not.toHaveBeenCalled();

  const getBounds = vi
    .spyOn(element, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 400, 400));
  api.set.mockClear();
  await act(async () => onResize());
  expect(api.state.dom.bounds.clear).toHaveBeenCalledOnce();
  expect(api.setAutoShapes).toHaveBeenCalledExactlyOnceWith([automaticShape]);
  expect(api.setShapes).toHaveBeenCalledExactlyOnceWith([{ ...savedShape, dest: undefined }]);
  expect(api.set).not.toHaveBeenCalled();

  const nextShape = { orig: "a2", dest: "a4", brush: "red" } as const;
  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground drawable={{ shapes: [nextShape], autoShapes: [automaticShape] }} />
      </MantineProvider>,
    );
  });
  getBounds.mockReturnValue(new DOMRect(0, 0, 500, 500));
  api.set.mockClear();
  api.setAutoShapes.mockClear();
  api.setShapes.mockClear();
  api.state.dom.bounds.clear.mockClear();
  await act(async () => onResize());
  expect(api.state.dom.bounds.clear).toHaveBeenCalledOnce();
  expect(api.setAutoShapes).toHaveBeenCalledExactlyOnceWith([automaticShape]);
  expect(api.setShapes).toHaveBeenCalledExactlyOnceWith([nextShape]);
  expect(api.set).not.toHaveBeenCalled();
  await act(async () => onResize());
  expect(api.state.dom.bounds.clear).toHaveBeenCalledOnce();
  expect(api.setAutoShapes).toHaveBeenCalledTimes(1);
  expect(api.setShapes).toHaveBeenCalledTimes(1);
  expect(api.set).not.toHaveBeenCalled();

  await act(async () => root.unmount());
  expect(observed.size).toBe(0);
});

test.each([
  ["default", null, "url('/board/wood4-square.png')"],
  ["stored false", "false", "none"],
  ["stored true", "true", "url('/board/wood4-square.png')"],
])("board texture custom property with %s preference", async (_name, stored, expected) => {
  localStorage.clear();
  if (stored !== null) localStorage.setItem("board-wood-texture", stored);
  const host = document.createElement("div");
  const root = createRoot(host);
  mountedRoots.add(root);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 400),
  );
  try {
    await act(async () => {
      root.render(
        <MantineProvider>
          <Chessground />
        </MantineProvider>,
      );
    });
    const board = createChessground.mock.calls[0][0];
    expect(board.style.getPropertyValue("--board-texture")).toBe(expected);
    expect(board.style.getPropertyValue("--board-image")).toContain("/board/chessriddle.svg");
  } finally {
    localStorage.clear();
  }
});

test("a re-render after mount clears the bounds cache before set when the board is visible", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  mountedRoots.add(root);
  const getBounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 400, 400));
  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground fen="start" />
      </MantineProvider>,
    );
  });
  api.set.mockClear();
  api.state.dom.bounds.clear.mockClear();

  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground fen="8/8/8/8/8/8/8/8" />
      </MantineProvider>,
    );
  });
  expect(api.state.dom.bounds.clear).toHaveBeenCalledOnce();
  expect(api.set).toHaveBeenCalledOnce();
  expect(api.state.dom.bounds.clear.mock.invocationCallOrder[0]).toBeLessThan(
    api.set.mock.invocationCallOrder[0],
  );

  getBounds.mockReturnValue(new DOMRect(0, 0, 0, 0));
  api.set.mockClear();
  api.state.dom.bounds.clear.mockClear();
  await act(async () => {
    root.render(
      <MantineProvider>
        <Chessground fen="start" />
      </MantineProvider>,
    );
  });
  expect(api.set).toHaveBeenCalledOnce();
  expect(api.state.dom.bounds.clear).not.toHaveBeenCalled();
});

test.each([
  ["default", null, undefined, { enabled: true, duration: 200 }],
  ["fast", '"fast"', undefined, { enabled: true, duration: 100 }],
  ["slow", '"slow"', undefined, { enabled: true, duration: 400 }],
  ["off", '"off"', undefined, { enabled: false }],
  ["unknown preset", '"warp"', undefined, { enabled: true, duration: 200 }],
  ["malformed JSON", "{", undefined, { enabled: true, duration: 200 }],
  ["slow with caller-disabled animation", '"slow"', false, { enabled: false, duration: 400 }],
])(
  "animation preference %s reaches Chessground",
  async (_name, stored, callerEnabled, expected) => {
    localStorage.clear();
    if (stored !== null) localStorage.setItem("board-animation-speed", stored);
    const root = createRoot(document.createElement("div"));
    mountedRoots.add(root);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 400),
    );
    try {
      await act(async () => {
        root.render(
          <MantineProvider>
            <Chessground animation={{ enabled: callerEnabled ?? true }} />
          </MantineProvider>,
        );
      });
      // The stored preference is read when the atom mounts and applied through api.set.
      expect(api.set.mock.lastCall?.[0].animation).toEqual(expected);
    } finally {
      localStorage.clear();
    }
  },
);

test("a mounted board without its own animation config resumes animating when Off changes to Slow", async () => {
  localStorage.clear();
  localStorage.setItem("board-animation-speed", '"off"');
  const root = createRoot(document.createElement("div"));
  mountedRoots.add(root);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 400),
  );
  try {
    await act(async () => {
      root.render(
        <MantineProvider>
          <Chessground />
        </MantineProvider>,
      );
    });
    expect(api.set.mock.lastCall?.[0].animation).toEqual({ enabled: false });
    await act(async () => getDefaultStore().set(boardAnimationSpeedAtom, "slow"));
    expect(api.set.mock.lastCall?.[0].animation).toEqual({ enabled: true, duration: 400 });
  } finally {
    localStorage.clear();
  }
});

test("every board receives all six drawing brushes, even when the caller passes none", async () => {
  await renderDrawable({});
  const brushes = createChessground.mock.calls[0][1].drawable?.brushes;
  expect(brushes?.orange).toMatchObject({ color: "#ff6600" });
  expect(brushes?.cyan).toMatchObject({ color: "#00bcd4" });
  expect(brushes?.yellow).toMatchObject({ color: "#e8c500" });
});

test("a caller's brushes cannot replace a drawing colour", async () => {
  await renderDrawable({
    brushes: {
      ...defaults().drawable.brushes,
      yellow: { key: "y", color: "#000", opacity: 1, lineWidth: 1 },
    },
  });
  expect(createChessground.mock.calls[0][1].drawable?.brushes?.yellow).toMatchObject({
    color: "#e8c500",
  });
});
