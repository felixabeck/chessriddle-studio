import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

const logFailureSafely = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/platform/errors", () => ({
  logFailureSafely,
  safeFailureContext: (error: unknown) => ({
    category: "unexpected",
    message: error instanceof Error ? error.message : String(error),
  }),
}));

vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Stack: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Text: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  logFailureSafely.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("catches panel load failures, logs safely, and recovers on retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let shouldThrow = true;
  const onRetry = vi.fn(() => {
    shouldThrow = false;
  });

  function FlakyPanel() {
    if (shouldThrow) throw new Error("chunk failed");
    return <div data-recovered="true">ok</div>;
  }

  await act(async () => {
    root.render(
      <PanelErrorBoundary
        operation="photo-panel-load"
        logLabel="Photo panel failed to load"
        loadFailedText="Could not load"
        retryLabel="Retry"
        onRetry={onRetry}
      >
        <FlakyPanel />
      </PanelErrorBoundary>,
    );
  });

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Could not load");
  expect(logFailureSafely).toHaveBeenCalledWith(
    "Photo panel failed to load: chunk failed",
    expect.objectContaining({ operation: "photo-panel-load" }),
    "photo-panel-load",
  );

  await act(async () => {
    host.querySelector<HTMLButtonElement>("button")!.click();
  });

  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-recovered="true"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
