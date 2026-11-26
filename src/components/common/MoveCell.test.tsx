import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/state/tabScope", () => ({ useTabAtom: (atom: unknown) => atom }));
vi.mock("@/state/atoms", () => ({ showCommentsFamily: "comments", moveNotationTypeAtom: "type" }));
vi.mock("jotai", () => ({
  useAtom: (atom: string) => [atom === "type" ? "letters" : true],
}));
vi.mock("lucide-react", () => ({ Flag: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Box: ({ component: Component = "div", children, ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
  rgba: (color: string, alpha: number) => `rgba(${color}, ${alpha})`,
  useMantineTheme: () => ({
    colors: {
      gray: Array(10).fill("#888"),
      teal: Array(10).fill("#099"),
    },
  }),
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

test("the current move is marked for assistive tech", async () => {
  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={true}
        move="c6"
        onClick={onClick}
        onContextMenu={() => {}}
      />,
    ),
  );
  expect(cell().getAttribute("aria-current")).toBe("true");

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
  expect(cell().hasAttribute("aria-current")).toBe(false);
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

test.each([false, true])(
  "an analysis move exposes its styling hook and preserves navigation (annotated: %s)",
  async (annotated) => {
    await act(async () =>
      root.render(
        <MoveCell
          annotations={annotated ? ["!"] : []}
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
    expect(cell().textContent).toBe(annotated ? "c6!" : "c6");
    for (const property of ["--light-color", "--dark-color"]) {
      expect(cell().style.getPropertyValue(property)).toBe(
        annotated
          ? "var(--cf-annotation-teal-text)"
          : "var(--notation-unannotated-move-color, #888)",
      );
    }
    await act(async () => cell().click());
    expect(onClick).toHaveBeenCalledOnce();
  },
);

test.each([
  [[], false, "transparent", "var(--cf-move-hover)"],
  [[], true, "var(--move-current-fill)", "var(--move-current-hover)"],
  [["!"], false, "transparent", "rgba(#099, 0.1)"],
  [["!"], true, "var(--move-current-fill)", "var(--move-current-hover)"],
] as const)(
  "an unannotated move takes the warm palette and an annotated one its colour (%j, current: %s)",
  async (annotations, current, fill, hover) => {
    await act(async () =>
      root.render(
        <MoveCell
          annotations={[...annotations]}
          isStart={false}
          isCurrentVariation={current}
          move="c6"
          onClick={onClick}
          onContextMenu={() => {}}
        />,
      ),
    );
    expect(cell().style.getPropertyValue("--move-bg")).toBe(fill);
    expect(cell().style.getPropertyValue("--move-hover")).toBe(hover);
  },
);

test("only an open variation carries the mark and its explanation", async () => {
  expect(cell().hasAttribute("data-notation-open-variation")).toBe(false);
  expect(cell().hasAttribute("title")).toBe(false);

  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={false}
        move="c6"
        onClick={onClick}
        onContextMenu={() => {}}
        openVariation
      />,
    ),
  );

  expect(cell().getAttribute("data-notation-open-variation")).toBe("true");
  expect(cell().getAttribute("title")).toBe("Notation.OpenVariation");
  expect(cell().classList.contains(classes.cell)).toBe(true);
});

test("an unsure move carries data-notation-unsure and announces itself to assistive technology", async () => {
  expect(cell().hasAttribute("data-notation-unsure")).toBe(false);
  expect(cell().hasAttribute("aria-label")).toBe(false);

  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={false}
        move="Nf3"
        onClick={onClick}
        onContextMenu={() => {}}
        unsure
      />,
    ),
  );

  expect(cell().getAttribute("data-notation-unsure")).toBe("true");
  expect(cell().getAttribute("title")).toBe("Notation.UnsureMove");
  expect(cell().getAttribute("aria-label")).toBe("Notation.UnsureMoveLabel");
});

test("a review-marked move carries data-notation-review-mark and its accessible label", async () => {
  expect(cell().hasAttribute("data-notation-review-mark")).toBe(false);
  expect(cell().hasAttribute("aria-label")).toBe(false);

  await act(async () =>
    root.render(
      <MoveCell
        annotations={[]}
        isStart={false}
        isCurrentVariation={false}
        move="c5"
        onClick={onClick}
        onContextMenu={() => {}}
        reviewMark
      />,
    ),
  );

  expect(cell().getAttribute("data-notation-review-mark")).toBe("true");
  expect(cell().getAttribute("title")).toBe("Notation.ReviewMove");
  expect(cell().getAttribute("aria-label")).toBe("Notation.ReviewMoveLabel");
});
