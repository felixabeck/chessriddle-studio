import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import LastMoveHighlightColorInput from "./LastMoveHighlightColorInput";

const state = vi.hoisted(() => ({
  color: "#ffff00",
  opacity: 40,
  boardImage: "wood.jpg",
  setColor: vi.fn(),
  inputProps: undefined as any,
}));

vi.mock("@/state/atoms", () => ({
  lastMoveHighlightColorAtom: "color",
  lastMoveHighlightOpacityAtom: "opacity",
  boardImageAtom: "board",
}));
vi.mock("jotai", () => ({
  useAtom: () => [state.color, state.setColor],
  useAtomValue: (atom: string) => (atom === "opacity" ? state.opacity : state.boardImage),
}));
vi.mock("@mantine/core", () => ({
  Group: ({ children }: any) => <div>{children}</div>,
  Box: ({ style, ...props }: any) => <div style={style} {...props} />,
  ColorInput: (props: any) => {
    state.inputProps = props;
    return <input aria-label={props["aria-label"]} value={props.value} readOnly />;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  state.color = "#ffff00";
  state.opacity = 40;
  state.boardImage = "wood.jpg";
  state.setColor = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<LastMoveHighlightColorInput />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function input() {
  return host.querySelector("input") as HTMLInputElement;
}

test("offers the yellow, orange and blue presets without an eye dropper", () => {
  expect(state.inputProps.swatches).toEqual(["#ffff00", "#ff9500", "#0095ff"]);
  expect(state.inputProps.withEyeDropper).toBe(false);
  expect(state.inputProps.format).toBe("hex");
});

test("a half-typed colour stays in the field without changing the setting", () => {
  act(() => state.inputProps.onChange("#ff9"));
  expect(input().value).toBe("#ff9");
  expect(state.setColor).not.toHaveBeenCalled();
});

test("a complete colour is saved in lower case", () => {
  act(() => state.inputProps.onChange("#FF9500"));
  expect(state.setColor).toHaveBeenCalledWith("#ff9500");
});

test("a custom colour outside the presets is saved", () => {
  act(() => state.inputProps.onChange("#3a7f5c"));
  expect(state.setColor).toHaveBeenCalledWith("#3a7f5c");
});

test("leaving the field with an incomplete colour restores the saved one", () => {
  act(() => state.inputProps.onChange("#ff9"));
  act(() => state.inputProps.onBlur());
  expect(input().value).toBe("#ffff00");
});

test("the preview paints the highlight over the selected board", () => {
  const preview = host.querySelector('[data-testid="last-move-highlight-preview"]') as HTMLElement;
  expect(preview.style.backgroundImage).toContain("rgba(255, 255, 0, 0.4)");
  expect(preview.style.backgroundImage).toContain("/board/wood.jpg");
});

test("the preview follows the chosen opacity", () => {
  state.opacity = 70;
  act(() => root.render(<LastMoveHighlightColorInput />));
  const preview = host.querySelector('[data-testid="last-move-highlight-preview"]') as HTMLElement;
  expect(preview.style.backgroundImage).toContain("rgba(255, 255, 0, 0.7)");
});
