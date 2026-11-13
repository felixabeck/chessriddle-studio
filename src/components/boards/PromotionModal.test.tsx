import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import PromotionModal from "./PromotionModal";

vi.mock("@mantine/core", () => ({
  FocusTrap: ({ active, children }: { active: boolean; children: React.ReactNode }) => (
    <div data-focus-trap={active}>{children}</div>
  ),
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mantine/hooks", () => ({ useClickOutside: () => () => undefined }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; piece?: string }) =>
      options?.defaultValue?.replace("{{piece}}", options.piece || "") || key,
  }),
}));
vi.mock("../common/IconAction", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        label: string;
      }
    >(function TestIconAction({ label, children, ...props }, ref) {
      return (
        <button ref={ref} aria-label={label} {...props}>
          {children}
        </button>
      );
    }),
  };
});
vi.mock("../common/Piece", () => ({ default: () => <span /> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

test("traps focus in localized promotion choices and restores its trigger on close", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const pendingMove = { from: 12, to: 4, promotion: undefined } as any;

  await act(async () =>
    root.render(
      <PromotionModal
        pendingMove={pendingMove}
        cancelMove={vi.fn()}
        confirmMove={vi.fn()}
        turn="white"
        orientation="white"
      />,
    ),
  );

  expect(host.querySelector("[data-focus-trap='true']")).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
    "Choose promotion piece",
  );
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Promote to queen"]'));

  await act(async () =>
    root.render(
      <PromotionModal
        pendingMove={null}
        cancelMove={vi.fn()}
        confirmMove={vi.fn()}
        turn="white"
        orientation="white"
      />,
    ),
  );
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("uses keyboard choice shortcuts and escape", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const cancelMove = vi.fn();
  const confirmMove = vi.fn();

  await act(async () =>
    root.render(
      <PromotionModal
        pendingMove={{ from: 12, to: 4, promotion: undefined } as any}
        cancelMove={cancelMove}
        confirmMove={confirmMove}
        turn="white"
        orientation="white"
      />,
    ),
  );

  const dialog = host.querySelector('[role="dialog"]')!;
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })),
  );
  expect(confirmMove).toHaveBeenCalledWith("knight");
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(cancelMove).toHaveBeenCalledTimes(1);
});

test("keeps queen focus and semantic shortcuts when promotion choices render in reverse", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const confirmMove = vi.fn();

  await act(async () =>
    root.render(
      <PromotionModal
        pendingMove={{ from: 9, to: 1 }}
        cancelMove={vi.fn()}
        confirmMove={confirmMove}
        turn="black"
        orientation="white"
      />,
    ),
  );

  expect(document.activeElement).toBe(host.querySelector('[aria-label="Promote to queen"]'));
  expect(
    Array.from(host.querySelectorAll("button"), (button) => button.getAttribute("aria-label")),
  ).toEqual(["Promote to bishop", "Promote to rook", "Promote to knight", "Promote to queen"]);

  const dialog = host.querySelector('[role="dialog"]')!;
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })),
  );
  expect(confirmMove).toHaveBeenNthCalledWith(1, "queen");
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true })),
  );
  expect(confirmMove).toHaveBeenNthCalledWith(2, "bishop");
});
