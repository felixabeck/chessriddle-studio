import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { MINI_BOARD_SIZE, MiniBoard } from "./MiniBoard";

const chessground = vi.hoisted(() => ({ props: [] as any[] }));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: any) => {
    chessground.props.push(props);
    return <div data-chessground />;
  },
}));
vi.mock("@mantine/core", () => ({
  Box: ({ children, w, ...props }: any) => (
    <div data-width={w} {...props}>
      {children}
    </div>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("MiniBoard owns its width, takes no pointer events and draws the given shapes on a view-only board", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const shapes = [{ orig: "e2" as const, dest: "e4" as const, brush: "green" }];
  await act(async () =>
    root.render(
      <MiniBoard
        fen="8/8/8/8/8/8/8/K6k b - - 0 1"
        orientation="black"
        turnColor="black"
        check
        lastMove={["a2", "a1"]}
        shapes={shapes}
      />,
    ),
  );
  const box = host.querySelector<HTMLElement>("[data-mini-board]")!;
  expect(box.getAttribute("data-width")).toBe(String(MINI_BOARD_SIZE));
  expect(box.style.pointerEvents).toBe("none");
  expect(box.querySelector("[data-chessground]")).not.toBeNull();
  expect(chessground.props.at(-1)).toMatchObject({
    fen: "8/8/8/8/8/8/8/K6k b - - 0 1",
    viewOnly: true,
    coordinates: false,
    orientation: "black",
    turnColor: "black",
    check: true,
    lastMove: ["a2", "a1"],
    drawable: { visible: true, shapes },
  });

  await act(async () =>
    root.render(
      <MiniBoard fen="8/8/8/8/8/8/8/K6k w - - 0 1" orientation="white" turnColor="white" />,
    ),
  );
  expect("shapes" in chessground.props.at(-1).drawable).toBe(false);
  await act(async () => root.unmount());
});
