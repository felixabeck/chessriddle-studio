import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const tooltip = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  return {
    ...actual,
    Tooltip: (props: Record<string, unknown>) => {
      tooltip.props = props;
      return props.children;
    },
  };
});

import ExplainedAction from "./ExplainedAction";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  tooltip.props = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("caps the explanation to the viewport so it cannot widen the page", async () => {
  await act(async () => {
    root.render(
      <ExplainedAction explanation="Enter a new game move by move and save it to this file">
        <button type="button">New game</button>
      </ExplainedAction>,
    );
  });
  expect(tooltip.props).toMatchObject({
    label: "Enter a new game move by move and save it to this file",
    multiline: true,
    w: "min(16.25rem, calc(100vw - 16px))",
    maw: "calc(100vw - 16px)",
    withinPortal: true,
    floatingStrategy: "fixed",
    middlewares: { flip: true, shift: true, inline: false },
  });
});
