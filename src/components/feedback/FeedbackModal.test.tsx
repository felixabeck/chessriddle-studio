import {
  act,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FeedbackOutcome } from "@/bindings";

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
  tauri: { submitFeedback: mocks.submitFeedback },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey, components }: { i18nKey: string; components: Record<string, ReactNode> }) => (
    <span>
      {i18nKey}
      {components.privacy}
    </span>
  ),
}));
vi.mock("../common/AppModal", () => ({
  default: ({
    children,
    opened,
    title,
    onClose,
  }: {
    children: ReactNode;
    opened: boolean;
    title?: string;
    onClose?: () => void;
  }) =>
    opened ? (
      <div data-testid="dialog" data-title={title}>
        <button type="button" data-testid="dialog-close" onClick={onClose}>
          close
        </button>
        {children}
      </div>
    ) : null,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@mantine/core", () => ({
  Anchor: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href}>{children}</a>
  ),
  Button: ({
    children,
    loading,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props} disabled={loading || props.disabled}>
      {children}
    </button>
  ),
  Group: ({ children }: HTMLAttributes<HTMLDivElement>) => <div>{children}</div>,
  SegmentedControl: ({
    data,
    value,
    onChange,
  }: {
    data: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <div>
      {data.map((item) => (
        <button
          key={item.value}
          type="button"
          data-selected={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Stack: ({ children }: HTMLAttributes<HTMLDivElement>) => <div>{children}</div>,
  Text: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  Textarea: ({
    description,
    ...props
  }: TextareaHTMLAttributes<HTMLTextAreaElement> & { description?: string }) => (
    <label>
      <textarea {...props} />
      {description && <span>{description}</span>}
    </label>
  ),
  TextInput: ({
    description,
    error,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    description?: string;
    error?: string;
  }) => (
    <label>
      <input {...props} />
      {description && <span>{description}</span>}
      {error && <span role="status">{error}</span>}
    </label>
  ),
}));

import FeedbackModal from "./FeedbackModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
type Uuid = `${string}-${string}-${string}-${string}-${string}`;
const firstKey: Uuid = "11111111-1111-4111-8111-111111111111";
const secondKey: Uuid = "22222222-2222-4222-8222-222222222222";
const thirdKey: Uuid = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitFeedback.mockResolvedValue("sent" satisfies FeedbackOutcome);
  let issued = 0;
  const keys = [firstKey, secondKey, thirdKey] as const;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    const key = keys[issued++];
    if (!key) throw new Error("unexpected extra UUID");
    return key;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderModal() {
  await act(async () => {
    root.render(<FeedbackModal opened onClose={onClose} />);
  });
}

async function fillMessage(value: string) {
  const textarea = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fillEmail(value: string) {
  const input = container.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

test("keeps send disabled until the message is long enough", async () => {
  await renderModal();
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  await fillMessage("A useful Studio report.");
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(false);
});

test("success closes the dialog and notifies without exposing a server body", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  await fillEmail("user@example.com");
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenCalledExactlyOnceWith(
    "bug",
    "A useful Studio report.",
    "user@example.com",
    firstKey,
  );
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "success",
    message: "Feedback.Success",
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("an unchanged retry reuses the idempotency key", async () => {
  mocks.submitFeedback.mockResolvedValueOnce("inProgress" satisfies FeedbackOutcome);
  mocks.submitFeedback.mockResolvedValueOnce("sent" satisfies FeedbackOutcome);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.InProgress");
  expect(onClose).not.toHaveBeenCalled();
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenNthCalledWith(
    1,
    "bug",
    "A useful Studio report.",
    null,
    firstKey,
  );
  expect(mocks.submitFeedback).toHaveBeenNthCalledWith(
    2,
    "bug",
    "A useful Studio report.",
    null,
    firstKey,
  );
});

test("a payload change or mismatch mints a new key", async () => {
  mocks.submitFeedback.mockResolvedValueOnce("keyMismatch" satisfies FeedbackOutcome);
  mocks.submitFeedback.mockResolvedValueOnce("deliveryFailed" satisfies FeedbackOutcome);
  mocks.submitFeedback.mockResolvedValueOnce("sent" satisfies FeedbackOutcome);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.KeyMismatch");
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[1]?.[3]).toBe(secondKey);
  await fillMessage("A different Studio report.");
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[2]?.[1]).toBe("A different Studio report.");
  expect(mocks.submitFeedback.mock.calls[2]?.[3]).toBe(thirdKey);
});

test("mapped outcomes keep the typed message", async () => {
  mocks.submitFeedback.mockResolvedValueOnce("rateLimited" satisfies FeedbackOutcome);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("textarea")?.value).toBe("A useful Studio report.");
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.RateLimited");
  expect(onClose).not.toHaveBeenCalled();
});

test("transport failures map to the network copy", async () => {
  mocks.submitFeedback.mockRejectedValueOnce({
    category: "network",
    message: "network failure",
  });
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.Network");
  expect(container.querySelector("textarea")?.value).toBe("A useful Studio report.");
});

test("mapped outcomes surface the closed alert copy", async () => {
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => firstKey);
  const cases: [FeedbackOutcome, string][] = [
    ["inProgress", "Feedback.Error.InProgress"],
    ["keyMismatch", "Feedback.Error.KeyMismatch"],
    ["invalidInput", "Feedback.Error.InvalidInput"],
    ["rateLimited", "Feedback.Error.RateLimited"],
    ["deliveryFailed", "Feedback.Error.DeliveryFailed"],
    ["serviceUnavailable", "Feedback.Error.ServiceUnavailable"],
  ];
  for (const [outcome, copy] of cases) {
    mocks.submitFeedback.mockReset();
    mocks.submitFeedback.mockResolvedValueOnce(outcome);
    await renderModal();
    await fillMessage("A useful Studio report.");
    await submitForm();
    expect(container.querySelector("[role='alert']")?.textContent).toBe(copy);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
  }
});

test("success notifies without an error alert", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "success",
    message: "Feedback.Success",
  });
  expect(container.querySelector("[role='alert']")).toBeNull();
});

test("a cancelled transport leaves the form without an alert", async () => {
  mocks.submitFeedback.mockRejectedValueOnce({
    category: "cancelled",
    message: "cancelled",
  });
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("A useful Studio report.");
});

test("a validation transport maps to invalid input", async () => {
  mocks.submitFeedback.mockRejectedValueOnce({
    category: "validation",
    message: "invalid",
  });
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.InvalidInput",
  );
});

test("an unclassified transport maps to delivery failed", async () => {
  mocks.submitFeedback.mockRejectedValueOnce({
    category: "unexpected",
    message: "boom",
  });
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.DeliveryFailed",
  );
});

test("keeps send disabled for an implausible email", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(false);
  await fillEmail("not-an-email");
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
});

test("keeps send disabled for a message over the max", async () => {
  await renderModal();
  await fillMessage("x".repeat(5001));
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
});

test("ignores a second submit and close while pending", async () => {
  let finish!: (outcome: FeedbackOutcome) => void;
  mocks.submitFeedback.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await renderModal();
  await fillMessage("A useful Studio report.");
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='dialog-close']")?.click();
  });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => {
    finish("sent");
  });
});

test("privacy link points at the ChessRiddle privacy policy", async () => {
  await renderModal();
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://chessriddle.com/privacy",
  );
});
