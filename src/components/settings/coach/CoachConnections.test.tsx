import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSummary } from "@/bindings";
import { CoachCommandError } from "@/platform/coach";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { CoachConnections } from "./CoachConnections";

const mocks = vi.hoisted(() => ({
  coachConnections: vi.fn(),
  coachSaveApiConnection: vi.fn(),
  coachRemoveConnection: vi.fn(),
  coachModels: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && ("total" in options || "label" in options)
        ? `${key}:${String(options.total ?? options.label)}`
        : key,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const ollama: ConnectionSummary = {
  handle: "handle-ollama",
  kind: "api",
  label: "Ollama",
  address: "http://localhost:11434/v1",
  hasKey: false,
  status: "ready",
};
const hosted: ConnectionSummary = {
  handle: "handle-hosted",
  kind: "api",
  label: "Hosted",
  address: "https://api.example.com/v1",
  hasKey: true,
  status: "ready",
};
const broken: ConnectionSummary = {
  handle: "handle-broken",
  kind: "api",
  label: "Broken",
  address: null,
  hasKey: false,
  status: "needsRepair",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.coachConnections.mockResolvedValue([ollama, hosted, broken]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <Provider store={createStore()}>
        <MantineProvider env="test">
          <CoachConnections />
        </MantineProvider>
      </Provider>,
    ),
  );
}

function row(label: string) {
  return document.querySelector<HTMLElement>(`[role="listitem"][aria-label="${label}"]`)!;
}

function button(scope: ParentNode, name: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  )!;
}

async function click(node: HTMLElement) {
  await act(async () => node.click());
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function field(label: string) {
  const labels = [...dialog()!.querySelectorAll("label")];
  const match = labels.find((node) => node.textContent?.startsWith(label))!;
  return document.getElementById(match.getAttribute("for")!) as HTMLInputElement;
}

test("lists the native connections and never shows a key", async () => {
  await render();
  expect(row("Ollama").textContent).toContain("http://localhost:11434/v1");
  expect(row("Hosted").textContent).toContain("https://api.example.com/v1");
  // An unreadable connection is listed beside the others, marked, and cannot be checked.
  expect(row("Broken").textContent).toContain("Settings.Coach.Connection.NeedsRepair");
  expect(row("Broken").textContent).toContain("Coach.Error.NeedsRepair");
  expect(button(row("Broken"), "Settings.Coach.Connection.Check").disabled).toBe(true);
  expect(button(row("Ollama"), "Settings.Coach.Connection.Check").disabled).toBe(false);
});

test("a failed list read shows its error and can be retried", async () => {
  mocks.coachConnections.mockRejectedValueOnce(new CoachCommandError("storage"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Coach.Error.Storage");
  expect(button(host, "Settings.Coach.Connections.Add").disabled).toBe(true);
  await click(button(host, "Common.Retry"));
  expect(row("Ollama")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("Check loads the model list of that connection and reports the count or the error", async () => {
  await render();
  mocks.coachModels.mockResolvedValueOnce({
    models: [{ id: "a" }, { id: "b" }],
    truncated: false,
  });
  await click(button(row("Ollama"), "Settings.Coach.Connection.Check"));
  expect(mocks.coachModels).toHaveBeenLastCalledWith("handle-ollama");
  expect(row("Ollama").textContent).toContain("Settings.Coach.Connection.Models:2");

  mocks.coachModels.mockResolvedValueOnce({ models: [{ id: "a" }], truncated: true });
  await click(button(row("Ollama"), "Settings.Coach.Connection.Check"));
  expect(row("Ollama").textContent).toContain("Settings.Coach.Connection.ModelsTruncated:1");

  mocks.coachModels.mockRejectedValueOnce(new CoachCommandError("keyRejected"));
  await click(button(row("Hosted"), "Settings.Coach.Connection.Check"));
  expect(row("Hosted").textContent).toContain("Coach.Error.KeyRejected");
  expect(row("Ollama").textContent).not.toContain("Coach.Error.KeyRejected");
});

test("adding sends label, address and key once, then re-reads the native list", async () => {
  await render();
  await click(button(host, "Settings.Coach.Connections.Add"));
  // The first preset is prefilled.
  expect(field("Common.Name").value).toBe("OpenAI");
  expect(field("Settings.Coach.Form.Address").value).toBe("https://api.openai.com/v1");
  await type(field("Common.Name"), "Mine");
  await type(field("Settings.Coach.Form.Address"), "https://api.example.com/v1");
  await type(field("Settings.Coach.Form.Key"), "sk-test");
  mocks.coachSaveApiConnection.mockResolvedValue({
    connection: hosted,
    durabilityUncertain: true,
  });
  await click(button(dialog()!, "Common.Save"));
  expect(mocks.coachSaveApiConnection).toHaveBeenCalledExactlyOnceWith({
    handle: undefined,
    label: "Mine",
    address: "https://api.example.com/v1",
    key: "sk-test",
  });
  expect(dialog()).toBeNull();
  expect(mocks.coachConnections).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Common.DurabilityUncertain");
  expect(document.body.textContent).not.toContain("sk-test");
});

test("editing addresses the connection by handle and leaves an untouched key out", async () => {
  await render();
  await click(button(row("Hosted"), "Settings.Coach.Form.EditTitle"));
  expect(field("Common.Name").value).toBe("Hosted");
  expect(field("Settings.Coach.Form.Address").value).toBe("https://api.example.com/v1");
  expect(field("Settings.Coach.Form.Key").value).toBe("");
  expect(dialog()!.textContent).toContain("Settings.Coach.Form.Key.Keep");
  expect(dialog()!.textContent).not.toContain("Settings.Coach.Form.Service");

  await type(field("Settings.Coach.Form.Address"), "https://other.example.com/v1");
  mocks.coachSaveApiConnection.mockRejectedValueOnce(new CoachCommandError("keyRequired"));
  await click(button(dialog()!, "Common.Save"));
  expect(mocks.coachSaveApiConnection).toHaveBeenLastCalledWith({
    handle: "handle-hosted",
    label: "Hosted",
    address: "https://other.example.com/v1",
    key: undefined,
  });
  // A refusal keeps the form open with what was entered.
  expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("Coach.Error.KeyRequired");
  expect(field("Settings.Coach.Form.Address").value).toBe("https://other.example.com/v1");
  expect(mocks.coachConnections).toHaveBeenCalledTimes(1);
});

test("removing asks first, removes by handle and re-reads the native list", async () => {
  await render();
  await click(button(row("Ollama"), "Settings.Coach.Connection.Remove"));
  expect(dialog()!.textContent).toContain("Settings.Coach.Connection.RemoveConfirm:Ollama");
  expect(mocks.coachRemoveConnection).not.toHaveBeenCalled();
  mocks.coachRemoveConnection.mockResolvedValue({ durabilityUncertain: false });
  mocks.coachConnections.mockResolvedValue([hosted, broken]);
  await click(button(dialog()!, "Common.Remove"));
  expect(mocks.coachRemoveConnection).toHaveBeenCalledExactlyOnceWith("handle-ollama");
  expect(dialog()).toBeNull();
  expect(row("Ollama")).toBeNull();
  expect(row("Hosted")).not.toBeNull();
});

test("a failed removal still re-reads the native list and keeps the dialog's error", async () => {
  await render();
  await click(button(row("Ollama"), "Settings.Coach.Connection.Remove"));
  mocks.coachRemoveConnection.mockRejectedValue(new CoachCommandError("storage"));
  await click(button(dialog()!, "Common.Remove"));
  expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
  expect(mocks.coachConnections).toHaveBeenCalledTimes(2);
});
