import { MantineProvider } from "@mantine/core";
import { INITIAL_FEN } from "chessops/fen";
import { Provider, createStore } from "jotai";
import type { Config } from "@lichess-org/chessground/config";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { positionFromFen } from "@/utils/chessops";
import PuzzleBoardSurface from "./PuzzleBoardSurface";

const board = vi.hoisted(() => ({ config: null as Config | null }));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (config: Config) => {
    board.config = config;
    return <div />;
  },
}));
vi.mock("@/platform/native", () => ({ warn: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => true, media: (query) => query });
const resizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
vi.stubGlobal("ResizeObserver", resizeObserver);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

test("a surface without tree context refuses illegal moves and contains rejected callbacks", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onMove = vi.fn().mockRejectedValue(new Error("rejected"));
  const position = positionFromFen(INITIAL_FEN)[0]!;
  await act(async () =>
    root!.render(
      <MantineProvider>
        <Provider store={createStore()}>
          <PuzzleBoardSurface position={position} orientation="white" canPlay onMove={onMove} />
        </Provider>
      </MantineProvider>,
    ),
  );
  await act(async () => {
    board.config!.movable!.events!.after!("e2", "e5", { premove: false });
  });
  expect(onMove).not.toHaveBeenCalled();
  await act(async () => {
    board.config!.movable!.events!.after!("e2", "e4", { premove: false });
  });
  expect(onMove).toHaveBeenCalledOnce();
  expect(position.turn).toBe("white");
});

async function pendingPromotion() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onMove = vi.fn();
  const store = createStore();
  const promotionFen = "7k/P7/8/8/8/8/8/7K w - - 0 1";
  const render = async (fen: string) => {
    await act(async () =>
      root!.render(
        <MantineProvider>
          <Provider store={store}>
            <PuzzleBoardSurface
              position={positionFromFen(fen)[0]!}
              orientation="white"
              canPlay
              onMove={onMove}
            />
          </Provider>
        </MantineProvider>,
      ),
    );
  };
  await render(promotionFen);
  await act(async () => {
    board.config!.movable!.events!.after!("a7", "a8", { premove: false });
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await render(promotionFen);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  return { render, promotionFen, onMove, surface: container };
}

test("promotion survives equal FEN objects and confirms the pending move", async () => {
  const { onMove, surface } = await pendingPromotion();
  await act(async () => {
    surface
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
  });
  expect(onMove).toHaveBeenCalledExactlyOnceWith({ from: 48, to: 56, promotion: "knight" });
  expect(surface.querySelector('[role="dialog"]')).toBeNull();
});

test("promotion survives equal FEN objects but is discarded after a changed position", async () => {
  const { render, promotionFen, onMove, surface } = await pendingPromotion();
  await render(INITIAL_FEN);
  expect(surface.querySelector('[role="dialog"]')).toBeNull();
  await render(promotionFen);
  expect(surface.querySelector('[role="dialog"]')).toBeNull();
  expect(onMove).not.toHaveBeenCalled();
});
