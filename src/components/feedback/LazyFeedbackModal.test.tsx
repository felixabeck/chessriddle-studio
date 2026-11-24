import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { FeedbackType } from "@/bindings";

const mocks = vi.hoisted(() => ({
  FeedbackModal: vi.fn(
    ({
      opened,
      onClose,
    }: {
      opened: boolean;
      onClose: () => void;
      initialType?: FeedbackType;
      initialMessage?: string;
    }) =>
      opened ? (
        <div data-testid="feedback-modal">
          <button type="button" data-testid="feedback-modal-close" onClick={onClose}>
            close
          </button>
        </div>
      ) : null,
  ),
}));

vi.mock("./FeedbackModal", () => ({
  default: (props: {
    opened: boolean;
    onClose: () => void;
    initialType?: FeedbackType;
    initialMessage?: string;
  }) => mocks.FeedbackModal(props),
}));

import LazyFeedbackModal from "./LazyFeedbackModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await act(async () => Promise.resolve());
    }
  }
  assertion();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.FeedbackModal.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("renders nothing while closed", async () => {
  const onClose = vi.fn();
  await act(async () => {
    root.render(<LazyFeedbackModal opened={false} onClose={onClose} />);
  });
  // Long enough for the lazy import to settle, so a wrapper that mounts while closed would be seen.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(container.querySelector("[data-testid='feedback-modal']")).toBeNull();
  expect(mocks.FeedbackModal).not.toHaveBeenCalled();
});

test("when opened, lazily renders FeedbackModal with opened=true and forwards onClose", async () => {
  const onClose = vi.fn();
  await act(async () => {
    root.render(<LazyFeedbackModal opened onClose={onClose} />);
  });
  await waitFor(() => expect(mocks.FeedbackModal).toHaveBeenCalled());
  expect(mocks.FeedbackModal.mock.calls.at(-1)?.[0]).toEqual({ opened: true, onClose });
  await act(async () => {
    mocks.FeedbackModal.mock.calls.at(-1)?.[0].onClose();
  });
  expect(onClose).toHaveBeenCalledOnce();
});

test("forwards initialType and initialMessage when opened and clears them when reopened empty", async () => {
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <LazyFeedbackModal
        opened
        initialType="suggestion"
        initialMessage="Add a shortcut for this view."
        onClose={onClose}
      />,
    );
  });
  await waitFor(() => expect(mocks.FeedbackModal).toHaveBeenCalled());
  expect(mocks.FeedbackModal.mock.calls.at(-1)?.[0]).toEqual({
    opened: true,
    onClose,
    initialType: "suggestion",
    initialMessage: "Add a shortcut for this view.",
  });

  await act(async () => {
    root.render(<LazyFeedbackModal opened={false} onClose={onClose} />);
  });
  expect(container.querySelector("[data-testid='feedback-modal']")).toBeNull();

  await act(async () => {
    root.render(<LazyFeedbackModal opened onClose={onClose} />);
  });
  await waitFor(() => expect(mocks.FeedbackModal).toHaveBeenCalledTimes(2));
  expect(mocks.FeedbackModal.mock.calls.at(-1)?.[0]).toEqual({
    opened: true,
    onClose,
    initialType: undefined,
    initialMessage: undefined,
  });
});
