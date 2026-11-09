import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DirectorySetting } from "./DirectorySetting";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Input: ({ children, component: Component = "div", ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
  Text: ({ children }: any) => <span>{children}</span>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test.each(["Cancellation", "native rejection"])(
  "releases the picker after %s for a second activation",
  async (message) => {
    const error = new Error(message);
    const issueWorkspace = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("New workspace");
    const onSelect = vi.fn();
    const onError = vi.fn();
    await act(async () =>
      root.render(
        <DirectorySetting
          value="Current workspace"
          issueWorkspace={issueWorkspace}
          onSelect={onSelect}
          onError={onError}
        />,
      ),
    );
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    expect(onError).toHaveBeenCalledWith(error);
    expect(onSelect).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    await act(async () => button.click());
    expect(issueWorkspace).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith("New workspace");
  },
);

let root: Root;
let host: HTMLDivElement;

test.each([null, ""])("offers directory selection for value %s", async (value) => {
  await act(async () =>
    root.render(<DirectorySetting value={value} issueWorkspace={vi.fn()} onSelect={vi.fn()} />),
  );
  expect(host.textContent).toContain("Settings.Directories.Select");
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

test("commits a successfully issued workspace and prevents duplicate picks while pending", async () => {
  let resolveWorkspace!: (value: string) => void;
  const issueWorkspace = vi.fn(
    () => new Promise<string>((resolve) => (resolveWorkspace = resolve)),
  );
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <DirectorySetting
        value="Current workspace"
        issueWorkspace={issueWorkspace}
        onSelect={onSelect}
      />,
    ),
  );

  const button = host.querySelector("button")!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(issueWorkspace).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(host.textContent).toContain("Common.Loading");

  await act(async () => resolveWorkspace("Puzzle workspace"));
  expect(onSelect).toHaveBeenCalledWith("Puzzle workspace");
  expect(button.disabled).toBe(false);
  expect(button.hasAttribute("aria-busy")).toBe(false);
});

test("recovers its interactive state when issuing a workspace fails", async () => {
  const issueWorkspace = vi.fn().mockRejectedValue(new Error("native failure"));
  const onError = vi.fn();
  await act(async () =>
    root.render(
      <DirectorySetting
        value="Current workspace"
        issueWorkspace={issueWorkspace}
        onSelect={vi.fn()}
        onError={onError}
      />,
    ),
  );
  const button = host.querySelector("button")!;
  await act(async () => button.click());
  expect(issueWorkspace).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(expect.any(Error));
  expect(button.disabled).toBe(false);
  expect(host.textContent).toContain("Current workspace");
});
