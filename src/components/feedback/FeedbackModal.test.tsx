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
  toPng: vi.fn(),
  pickImage: undefined as ((file: File | null) => void) | undefined,
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
vi.mock("html-to-image", () => ({
  toPng: mocks.toPng,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("@mantine/core", () => ({
  Anchor: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href}>{children}</a>
  ),
  Button: ({
    children,
    loading,
    leftSection: _leftSection,
    styles: _styles,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    leftSection?: ReactNode;
    styles?: unknown;
    variant?: string;
  }) => (
    <button {...props} disabled={loading || props.disabled}>
      {children}
    </button>
  ),
  FileButton: ({
    children,
    onChange,
    disabled,
  }: {
    children: (props: { onClick: () => void; disabled?: boolean }) => ReactNode;
    onChange: (file: File | null) => void;
    disabled?: boolean;
  }) => {
    mocks.pickImage = onChange;
    return children({ onClick: () => {}, disabled });
  },
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
const fourthKey: Uuid = "44444444-4444-4444-8444-444444444444";
const FEEDBACK_MAX_EMAIL = 254;
const FEEDBACK_MAX_MESSAGE = 5000;
const SMALL_PNG = "data:image/png;base64,aGVsbG8=";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OVERSIZED_PNG = `data:image/png;base64,${"A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1) * 4) / 3))}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submitFeedback.mockResolvedValue("sent" satisfies FeedbackOutcome);
  let issued = 0;
  mocks.toPng.mockResolvedValue(SMALL_PNG);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  const keys = [firstKey, secondKey, thirdKey, fourthKey] as const;
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
  vi.unstubAllGlobals();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function screenshotButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Feedback.TakeScreenshot"),
  );
}

function chooseImageButton() {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Feedback.ChooseImage"),
  );
}

function sendButton() {
  return container.querySelector<HTMLButtonElement>("button[type='submit']");
}

function preview() {
  return container.querySelector<HTMLImageElement>("img[alt='Feedback.ImagePreview']");
}

async function takeScreenshot() {
  await act(async () => {
    screenshotButton()?.click();
  });
}

async function clickSend() {
  await act(async () => {
    sendButton()?.click();
  });
}

async function pickFile(file: File) {
  await act(async () => {
    mocks.pickImage?.(file);
  });
}

async function removeAttachedImage() {
  const button = container.querySelector<HTMLButtonElement>(
    "button[aria-label='Feedback.RemoveImage']",
  );
  await act(async () => {
    button?.click();
  });
}

function pngFile(name = "shot.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function installDeferredFileReader() {
  const readers: Array<{
    load: (dataUrl: string) => void;
    error: () => void;
    abort: () => void;
  }> = [];
  class DeferredFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
    onabort: ((event: ProgressEvent<FileReader>) => void) | null = null;
    abort = () => {
      this.onabort?.(new ProgressEvent("abort") as ProgressEvent<FileReader>);
    };
    readAsDataURL = () => {
      readers.push({
        load: (dataUrl: string) => {
          this.result = dataUrl;
          this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        },
        error: () => {
          this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
        },
        abort: () => {
          this.abort();
        },
      });
    };
  }
  vi.stubGlobal("FileReader", DeferredFileReader);
  return {
    async load(index: number, dataUrl: string) {
      await act(async () => {
        readers[index]?.load(dataUrl);
      });
    },
    async error(index = 0) {
      await act(async () => {
        readers[index]?.error();
      });
    },
    async abort(index = 0) {
      await act(async () => {
        readers[index]?.abort();
      });
    },
  };
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
    null,
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
    null,
  );
  expect(mocks.submitFeedback).toHaveBeenNthCalledWith(
    2,
    "bug",
    "A useful Studio report.",
    null,
    firstKey,
    null,
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
    ["invalidImage", "Feedback.Error.InvalidImage"],
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

test("keeps send disabled for a too-long or whitespace email", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  await fillEmail(`a@b.${"c".repeat(FEEDBACK_MAX_EMAIL)}`);
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  await fillEmail("user @example.com");
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
  await fillEmail("user@example.com");
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(false);
});

test("keeps send disabled for a message over the max", async () => {
  await renderModal();
  await fillMessage("x".repeat(FEEDBACK_MAX_MESSAGE + 1));
  expect(container.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);
});

test("selecting suggestion sends that feedback type", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  const suggestion = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Feedback.Type.Suggestion",
  );
  await act(async () => {
    suggestion?.click();
  });
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenCalledExactlyOnceWith(
    "suggestion",
    "A useful Studio report.",
    null,
    firstKey,
    null,
  );
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

test("capture success attaches and previews the image", async () => {
  await renderModal();
  await takeScreenshot();
  expect(preview()?.getAttribute("src")).toBe(SMALL_PNG);
  expect(mocks.toPng).toHaveBeenCalledTimes(1);
  expect(mocks.toPng.mock.calls[0]?.[0]).toBe(document.body);
  expect(mocks.toPng.mock.calls[0]?.[1]).toMatchObject({
    pixelRatio: 2,
    cacheBust: true,
    skipFonts: true,
  });
});

test("capture filter excludes dialog, presentation, and notifications", async () => {
  await renderModal();
  await takeScreenshot();
  const filter = mocks.toPng.mock.calls[0]?.[1]?.filter as
    | ((node: HTMLElement) => boolean)
    | undefined;
  expect(typeof filter).toBe("function");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const presentation = document.createElement("div");
  presentation.setAttribute("role", "presentation");
  const notificationsRoot = document.createElement("div");
  notificationsRoot.className = "mantine-Notifications-root";
  const ordinary = document.createElement("div");
  expect(filter!(dialog)).toBe(false);
  expect(filter!(presentation)).toBe(false);
  expect(filter!(notificationsRoot)).toBe(false);
  expect(filter!(ordinary)).toBe(true);
});

test("capture failure shows the screenshot-failed copy", async () => {
  mocks.toPng.mockRejectedValueOnce(new Error("boom"));
  await renderModal();
  await takeScreenshot();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ScreenshotFailed",
  );
  expect(preview()).toBeNull();
});

test("retries capture at pixelRatio 1 when the first PNG is over 5 MiB", async () => {
  mocks.toPng.mockResolvedValueOnce(OVERSIZED_PNG);
  mocks.toPng.mockResolvedValueOnce(SMALL_PNG);
  await renderModal();
  await takeScreenshot();
  expect(mocks.toPng).toHaveBeenCalledTimes(2);
  expect(mocks.toPng.mock.calls[0]?.[1]).toMatchObject({ pixelRatio: 2 });
  expect(mocks.toPng.mock.calls[1]?.[1]).toMatchObject({ pixelRatio: 1 });
  expect(preview()?.getAttribute("src")).toBe(SMALL_PNG);
});

test("too-large capture after retry attaches nothing", async () => {
  mocks.toPng.mockResolvedValue(OVERSIZED_PNG);
  await renderModal();
  await takeScreenshot();
  expect(mocks.toPng).toHaveBeenCalledTimes(2);
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageTooLarge",
  );
});

test("rejects a file that is not an accepted image type", async () => {
  await renderModal();
  await pickFile(new File(["nope"], "notes.txt", { type: "text/plain" }));
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.ImageType");
});

test("rejects a file over 5 MiB", async () => {
  const file = pngFile("big.png");
  Object.defineProperty(file, "size", { value: MAX_IMAGE_BYTES + 1 });
  await renderModal();
  await pickFile(file);
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageTooLarge",
  );
});

test("file read failure shows the could-not-read copy", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await pickFile(pngFile());
  await reader.error(0);
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageReadFailed",
  );
});

test("file read abort clears in-flight state and shows the could-not-read copy", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await fillMessage("A useful Studio report.");
  await pickFile(pngFile());
  expect(sendButton()?.disabled).toBe(true);
  await reader.abort(0);
  expect(sendButton()?.disabled).toBe(false);
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageReadFailed",
  );
});

test("remove clears the attached image", async () => {
  await renderModal();
  await takeScreenshot();
  expect(preview()).not.toBeNull();
  await removeAttachedImage();
  expect(preview()).toBeNull();
});

test("ignores a stale capture after close", async () => {
  const capture = deferred<string>();
  mocks.toPng.mockReturnValueOnce(capture.promise);
  await renderModal();
  await takeScreenshot();
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='dialog-close']")?.click();
  });
  await act(async () => {
    capture.resolve(SMALL_PNG);
    await capture.promise;
  });
  expect(preview()).toBeNull();
});

test("ignores a stale capture after remove", async () => {
  await renderModal();
  await takeScreenshot();
  const capture = deferred<string>();
  mocks.toPng.mockReturnValueOnce(capture.promise);
  await takeScreenshot();
  await removeAttachedImage();
  await act(async () => {
    capture.resolve(SMALL_PNG);
    await capture.promise;
  });
  expect(preview()).toBeNull();
});

test("ignores a stale capture after a successful send", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  mocks.toPng.mockReturnValueOnce(first.promise);
  mocks.toPng.mockReturnValueOnce(second.promise);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  await takeScreenshot();
  await act(async () => {
    second.resolve(SMALL_PNG);
    await second.promise;
  });
  expect(preview()?.getAttribute("src")).toBe(SMALL_PNG);
  await submitForm();
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.resolve(`${SMALL_PNG}stale`);
    await first.promise;
  });
  expect(preview()).toBeNull();
});

test("ignores a stale file read after close", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await pickFile(pngFile());
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-testid='dialog-close']")?.click();
  });
  await reader.load(0, SMALL_PNG);
  expect(preview()).toBeNull();
});

test("ignores a stale file read after remove", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await pickFile(pngFile());
  await reader.load(0, SMALL_PNG);
  expect(preview()).not.toBeNull();
  await pickFile(pngFile("second.png"));
  await removeAttachedImage();
  await reader.load(1, `${SMALL_PNG}stale`);
  expect(preview()).toBeNull();
});

test("ignores a stale file read after a successful send", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await fillMessage("A useful Studio report.");
  await pickFile(pngFile("first.png"));
  await pickFile(pngFile("second.png"));
  await reader.load(1, SMALL_PNG);
  expect(preview()?.getAttribute("src")).toBe(SMALL_PNG);
  await submitForm();
  expect(onClose).toHaveBeenCalledTimes(1);
  await reader.load(0, `${SMALL_PNG}stale`);
  expect(preview()).toBeNull();
});

test("does not submit while a capture is in flight", async () => {
  const capture = deferred<string>();
  mocks.toPng.mockReturnValueOnce(capture.promise);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  expect(sendButton()?.disabled).toBe(true);
  await clickSend();
  await submitForm();
  expect(mocks.submitFeedback).not.toHaveBeenCalled();
  await act(async () => {
    capture.resolve(SMALL_PNG);
    await capture.promise;
  });
});

test("does not submit while a file read is in flight", async () => {
  const reader = installDeferredFileReader();
  await renderModal();
  await fillMessage("A useful Studio report.");
  await pickFile(pngFile());
  expect(sendButton()?.disabled).toBe(true);
  await clickSend();
  await submitForm();
  expect(mocks.submitFeedback).not.toHaveBeenCalled();
  await reader.load(0, SMALL_PNG);
});

test("changing the image after a failed send mints a new idempotency key", async () => {
  mocks.submitFeedback.mockResolvedValueOnce("deliveryFailed" satisfies FeedbackOutcome);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[0]?.[3]).toBe(firstKey);
  mocks.toPng.mockResolvedValueOnce("data:image/png;base64,c2Vjb25k");
  await takeScreenshot();
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[1]?.[3]).toBe(secondKey);
});

test("removing the image after a failed send mints a new idempotency key", async () => {
  mocks.submitFeedback.mockResolvedValueOnce("deliveryFailed" satisfies FeedbackOutcome);
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[0]?.[3]).toBe(firstKey);
  await removeAttachedImage();
  await submitForm();
  expect(mocks.submitFeedback.mock.calls[1]?.[3]).toBe(secondKey);
  expect(mocks.submitFeedback.mock.calls[1]?.[4]).toBeNull();
});

test("disables screenshot, choose-image and remove while send is pending", async () => {
  let finish!: (outcome: FeedbackOutcome) => void;
  mocks.submitFeedback.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  await submitForm();
  expect(screenshotButton()?.disabled).toBe(true);
  expect(chooseImageButton()?.disabled).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>("button[aria-label='Feedback.RemoveImage']")
      ?.disabled,
  ).toBe(true);
  await act(async () => {
    finish("sent");
  });
});

test("a rejected file while capture is in flight invalidates the capture", async () => {
  const capture = deferred<string>();
  mocks.toPng.mockReturnValueOnce(capture.promise);
  await renderModal();
  await takeScreenshot();
  await pickFile(new File(["nope"], "notes.txt", { type: "text/plain" }));
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.ImageType");
  await act(async () => {
    capture.resolve(SMALL_PNG);
    await capture.promise;
  });
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Feedback.Error.ImageType");
});

test("an oversize file while capture is in flight invalidates the capture", async () => {
  const capture = deferred<string>();
  mocks.toPng.mockReturnValueOnce(capture.promise);
  const file = pngFile("big.png");
  Object.defineProperty(file, "size", { value: MAX_IMAGE_BYTES + 1 });
  await renderModal();
  await takeScreenshot();
  await pickFile(file);
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageTooLarge",
  );
  await act(async () => {
    capture.resolve(SMALL_PNG);
    await capture.promise;
  });
  expect(preview()).toBeNull();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "Feedback.Error.ImageTooLarge",
  );
});

test("passes the attached image as the fifth argument", async () => {
  await renderModal();
  await fillMessage("A useful Studio report.");
  await takeScreenshot();
  await submitForm();
  expect(mocks.submitFeedback).toHaveBeenCalledExactlyOnceWith(
    "bug",
    "A useful Studio report.",
    null,
    firstKey,
    SMALL_PNG,
  );
});
