import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ErrorComponent from "./ErrorComponent";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), notify: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
  Trans: ({ components }: { components: Record<string, React.ReactNode> }) => components.github,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@mantine/core", () => ({
  Anchor: ({ children, href }: any) => <a href={href}>{children}</a>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Code: ({ children }: any) => <code>{children}</code>,
  CopyButton: ({ children, value }: any) => (
    <div data-copy={value}>{children({ copied: false, copy: () => undefined })}</div>
  ),
  Group: ({ children }: any) => <div>{children}</div>,
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <p>{children}</p>,
  Title: ({ children }: any) => <h1>{children}</h1>,
}));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.notify.mockReset();
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  vi.unstubAllGlobals();
});

function replaceWindowReload(reload: () => void) {
  vi.stubGlobal("window", { location: { reload } });
}

async function renderError() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ErrorComponent error={new Error("boom")} />));
  return host.querySelector("button") as HTMLButtonElement;
}

test("does not present a duplicate diagnostic", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ErrorComponent error={new Error("boom")} />));
  expect(host.querySelector("code")).toBeNull();
  expect(host.textContent).not.toContain("Error.CopyStackTrace");
  expect(host.textContent).toContain("Error.Unexpected");
  expect(host.textContent).toContain("boom");
  expect(host.textContent).toContain("Menu.View.Reload");
});

test("hides a diagnostic that only repeats the message", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ErrorComponent
        error={{
          category: "unexpected",
          message: "boom",
          diagnostic: "boom",
        }}
      />,
    ),
  );
  expect(host.querySelector("code")).toBeNull();
  expect(host.textContent).not.toContain("Error.CopyStackTrace");
  expect(host.textContent).toContain("boom");
});

test("renders an extra diagnostic when it differs from the message", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ErrorComponent
        error={{
          category: "unexpected",
          message: "boom",
          diagnostic: "safe-code",
        }}
      />,
    ),
  );
  expect(host.querySelector("code")?.textContent).toBe("safe-code");
  expect(host.textContent).toContain("Error.CopyStackTrace");
});

test("routes issue reports to the fork", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ErrorComponent error={new Error("boom")} />));
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/felixabeck/chessriddle-studio/issues/new?assignees=&labels=bug&projects=&template=bug.yml",
  );
});

test("rendered recovery waits for navigation before reloading", async () => {
  const navigation = deferred<void>();
  const reload = vi.fn();
  replaceWindowReload(reload);
  mocks.navigate.mockReturnValue(navigation.promise);

  const button = await renderError();
  button.click();
  await act(async () => Promise.resolve());
  expect(reload).not.toHaveBeenCalled();

  await act(async () => {
    navigation.resolve(undefined);
    await navigation.promise;
  });
  expect(reload).toHaveBeenCalledTimes(1);
});

test("rendered recovery reports rejected navigation and does not reload", async () => {
  const failure = new Error("navigation failed");
  const reload = vi.fn();
  replaceWindowReload(reload);
  mocks.navigate.mockRejectedValue(failure);

  const button = await renderError();
  button.click();
  await act(async () => Promise.resolve());

  expect(reload).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Common.Error", message: "navigation failed" }),
  );
});

test("rendered recovery reports a thrown reload", async () => {
  const failure = new Error("reload failed");
  const reload = vi.fn(() => {
    throw failure;
  });
  replaceWindowReload(reload);
  mocks.navigate.mockResolvedValue(undefined);

  const button = await renderError();
  button.click();
  await act(async () => Promise.resolve());

  expect(reload).toHaveBeenCalledTimes(1);
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Common.Error", message: "reload failed" }),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
