import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/state/tabScope", () => ({ useTabAtom: (atom: unknown) => atom }));
vi.mock("@/state/atoms", () => ({ showCommentsFamily: "comments", moveNotationTypeAtom: "type" }));
vi.mock("jotai", () => ({
  useAtom: (atom: string) => [atom === "type" ? "letters" : false],
}));
vi.mock("lucide-react", () => ({ Flag: () => null }));
vi.mock("@mantine/core", () => ({
  Box: ({ component: Component = "div", children, ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
  rgba: () => "transparent",
  useMantineTheme: () => ({ colors: { gray: Array(10).fill("#888") } }),
}));

import MoveCell from "./MoveCell";
import classes from "./MoveCell.module.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let onClick: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onClick = vi.fn<() => void>();
  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={false}
        move="c6"
        onClick={onClick}
        onContextMenu={() => {}}
      />,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function cell() {
  const button = host.querySelector("button");
  if (!button) throw new Error("move cell not rendered");
  return button;
}

test("a pointer click navigates and releases focus so no stale focus ring stays on the move", async () => {
  const button = cell();
  button.focus();
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(document.activeElement).not.toBe(button);
});

test("keyboard activation navigates and keeps focus on the move", async () => {
  const button = cell();
  button.focus();
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
});

test("an unmocked MoveCell exposes the analysis styling hook and preserves navigation", async () => {
  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={false}
        move="c6"
        analysis
        onClick={onClick}
        onContextMenu={() => {}}
      />,
    ),
  );
  expect(cell().getAttribute("data-notation-analysis")).toBe("true");
  expect(cell().classList.contains(classes.cell)).toBe(true);
  expect(cell().style.getPropertyValue("--light-color")).toContain("--notation-analysis-color");
  expect(cell().style.getPropertyValue("--dark-color")).toContain("--notation-analysis-color");
  await act(async () => cell().click());
  expect(onClick).toHaveBeenCalledOnce();
});
