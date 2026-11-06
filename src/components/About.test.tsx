import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { shippedCatalogues } from "@/tests/catalogues";

const native = vi.hoisted(() => ({
  arch: vi.fn(),
  getTauriVersion: vi.fn(),
  getVersion: vi.fn(),
  OSVersion: vi.fn(),
  osType: vi.fn(),
}));
const notifyUnlessCancelled = vi.hoisted(() => vi.fn());
let translatedErrorTitle = "Common.Error";

vi.mock("@/platform/native", () => native);
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { date?: string }) =>
      key === "About.ModificationNotice"
        ? `Modified version of En Croissant, modified by Felix Beck since ${options?.date}. Distributed under the GNU General Public License version 3, with no warranty.`
        : key === "Common.Error"
          ? translatedErrorTitle
          : key,
  }),
}));
vi.mock("@mantine/core", () => ({
  Anchor: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href}>{children}</a>
  ),
  Text: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("./common/AppModal", () => ({
  default: ({
    children,
    opened,
    title,
  }: {
    children?: React.ReactNode;
    opened: boolean;
    title: string;
  }) =>
    opened ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

import AboutModal from "./About";
import catalogue from "@/translation/en-US.json";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  translatedErrorTitle = "Common.Error";
  native.arch.mockResolvedValue("x86_64");
  native.getTauriVersion.mockResolvedValue("2.0.0");
  native.getVersion.mockResolvedValue("1.0.0");
  native.OSVersion.mockResolvedValue("1.0.0");
  native.osType.mockResolvedValue("Linux");
  notifyUnlessCancelled.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("renders the modification notice inside the opened About dialog", async () => {
  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));

  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain("Modified version of En Croissant");
  expect(dialog?.textContent).toContain("Felix Beck");
  expect(dialog?.textContent).toContain("since 2026-08-09");
  expect(dialog?.textContent).toContain("GNU General Public License version 3");
  expect(dialog?.textContent).toContain("no warranty");
  expect(dialog?.getAttribute("aria-label")).toBe("ChessRiddle Studio");
  expect(dialog?.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/felixabeck/chessriddle-studio",
  );
});

test("renders every metadata field after a successful load", async () => {
  native.getVersion.mockResolvedValue("app-version-4.5.6");
  native.getTauriVersion.mockResolvedValue("tauri-version-7.8.9");
  native.osType.mockResolvedValue("TestOS");
  native.arch.mockResolvedValue("test-architecture");
  native.OSVersion.mockResolvedValue("test-os-version");

  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));

  expect(container.textContent).toContain("app-version-4.5.6");
  expect(container.textContent).toContain("tauri-version-7.8.9");
  expect(container.textContent).toContain("TestOS");
  expect(container.textContent).toContain("test-architecture");
  expect(container.textContent).toContain("test-os-version");
});

test("reports metadata failure and renders translated unknown values", async () => {
  const failure = new Error("metadata unavailable");
  native.getVersion.mockRejectedValue(failure);
  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));
  expect(notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  expect(container.textContent).toContain("Common.Unknown");
});

test("does not update or notify after unmount", async () => {
  let rejectVersion: (error: Error) => void = () => undefined;
  native.getVersion.mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectVersion = reject;
      }),
  );
  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));
  await act(async () => root.unmount());
  await act(async () => rejectVersion(new Error("late failure")));
  expect(notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("keeps newer metadata when an obsolete successful load completes later", async () => {
  const first = {
    os: deferred<string>(),
    version: deferred<string>(),
    tauri: deferred<string>(),
    architecture: deferred<string>(),
    osVersion: deferred<string>(),
  };
  const second = {
    os: deferred<string>(),
    version: deferred<string>(),
    tauri: deferred<string>(),
    architecture: deferred<string>(),
    osVersion: deferred<string>(),
  };

  native.osType
    .mockImplementationOnce(() => first.os.promise)
    .mockImplementationOnce(() => second.os.promise);
  native.getVersion
    .mockImplementationOnce(() => first.version.promise)
    .mockImplementationOnce(() => second.version.promise);
  native.getTauriVersion
    .mockImplementationOnce(() => first.tauri.promise)
    .mockImplementationOnce(() => second.tauri.promise);
  native.arch
    .mockImplementationOnce(() => first.architecture.promise)
    .mockImplementationOnce(() => second.architecture.promise);
  native.OSVersion.mockImplementationOnce(() => first.osVersion.promise).mockImplementationOnce(
    () => second.osVersion.promise,
  );

  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));
  translatedErrorTitle = "Reloaded.Error";
  await act(async () => root.render(<AboutModal opened setOpened={vi.fn()} />));

  await act(async () => {
    second.os.resolve("new-os");
    second.version.resolve("new-version");
    second.tauri.resolve("new-tauri");
    second.architecture.resolve("new-architecture");
    second.osVersion.resolve("new-os-version");
    await Promise.all([
      second.os.promise,
      second.version.promise,
      second.tauri.promise,
      second.architecture.promise,
      second.osVersion.promise,
    ]);
  });

  expect(container.textContent).toContain("new-version");
  expect(container.textContent).toContain("new-tauri");
  expect(container.textContent).toContain("new-os new-architecture new-os-version");

  await act(async () => {
    first.os.resolve("old-os");
    first.version.resolve("old-version");
    first.tauri.resolve("old-tauri");
    first.architecture.resolve("old-architecture");
    first.osVersion.resolve("old-os-version");
    await Promise.all([
      first.os.promise,
      first.version.promise,
      first.tauri.promise,
      first.architecture.promise,
      first.osVersion.promise,
    ]);
  });

  expect(container.textContent).toContain("new-version");
  expect(container.textContent).toContain("new-tauri");
  expect(container.textContent).toContain("new-os new-architecture new-os-version");
  expect(container.textContent).not.toContain("old-version");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// The test above renders through a mocked `t`, so it proves the notice is rendered and that the
// date is interpolated, but not that the shipped English string actually says what GPL-3 section
// 5(a) requires. Assert the catalogue itself: a notice that names no modifier does not discharge
// the licence, and that is a defect no rendering test would catch.
test("the shipped en-US notice carries every element section 5(a) requires", () => {
  const notice = (catalogue as { translation: Record<string, string> }).translation[
    "About.ModificationNotice"
  ];

  expect(notice).toBeDefined();
  expect(notice).toContain("{{date}}");
  expect(notice).toMatch(/modified/i);
  expect(notice).toContain("Felix Beck");
  expect(notice).toContain("General Public License");
  expect(notice).toMatch(/no warranty/i);
});

test("every shipped catalogue preserves the modification notice", () => {
  for (const { translation } of shippedCatalogues()) {
    const notice = translation["About.ModificationNotice"];

    expect(notice).toBeTypeOf("string");
    if (typeof notice !== "string") continue;

    expect(notice).toContain("{{date}}");
    expect(notice).toContain("En Croissant");
    expect(notice).toContain("Felix Beck");
    expect(notice).toMatch(/GNU General Public License.*3/i);
  }
});
