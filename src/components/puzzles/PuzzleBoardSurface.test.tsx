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
