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
  coachSignInChatgpt: vi.fn(),
  coachCancelSignIn: vi.fn(),
  coachOpenUsage: vi.fn(),
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
  account: null,
  status: "ready",
};
const hosted: ConnectionSummary = {
  handle: "handle-hosted",
  kind: "api",
  label: "Hosted",
  address: "https://api.example.com/v1",
  hasKey: true,
  account: null,
  status: "ready",
};
const broken: ConnectionSummary = {
  handle: "handle-broken",
  kind: "api",
  label: "Broken",
  address: null,
  hasKey: false,
  account: null,
  status: "needsRepair",
};

const chatGpt: ConnectionSummary = {
  handle: "handle-chatgpt",
  kind: "chatGpt",
  label: "ChatGPT",
  address: null,
  hasKey: false,
  account: "player@example.com",
  status: "ready",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.coachCancelSignIn.mockResolvedValue(null);
  mocks.coachOpenUsage.mockResolvedValue(null);
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

test("removing a sign-in the provider did not confirm says so and points to the provider", async () => {
  mocks.coachConnections.mockResolvedValue([chatGpt]);
  await render();
  await click(button(row("ChatGPT"), "Settings.Coach.Connection.Remove"));
  mocks.coachRemoveConnection.mockResolvedValue({
    durabilityUncertain: false,
    revocationPending: true,
  });
  mocks.coachConnections.mockResolvedValue([]);
  await click(button(dialog()!, "Common.Remove"));
  const notice = [...host.querySelectorAll<HTMLElement>('[role="status"]')].find((node) =>
    node.textContent?.includes("Settings.Coach.Connection.RevocationPending:ChatGPT"),
  )!;
  expect(notice).toBeDefined();
  await click(button(notice, "Coach.Plan.ManageUsage"));
  expect(mocks.coachOpenUsage).toHaveBeenCalledOnce();
});

test("a confirmed removal shows no sign-out notice", async () => {
  mocks.coachConnections.mockResolvedValue([chatGpt]);
  await render();
  await click(button(row("ChatGPT"), "Settings.Coach.Connection.Remove"));
  mocks.coachRemoveConnection.mockResolvedValue({
    durabilityUncertain: false,
    revocationPending: false,
  });
  await click(button(dialog()!, "Common.Remove"));
  expect(host.textContent).not.toContain("Settings.Coach.Connection.RevocationPending");
});

test("a ChatGPT connection shows its account, has nothing to edit and leaves no second sign-in", async () => {
  mocks.coachConnections.mockResolvedValue([chatGpt, ollama]);
  await render();
  expect(row("ChatGPT").textContent).toContain("player@example.com");
  expect(button(row("ChatGPT"), "Settings.Coach.Form.EditTitle")).toBeUndefined();
  expect(button(row("Ollama"), "Settings.Coach.Form.EditTitle")).toBeDefined();
  await click(button(row("ChatGPT"), "Coach.Plan.ManageUsage"));
  expect(mocks.coachOpenUsage).toHaveBeenCalledOnce();
  // One ChatGPT connection: while it works there is no button for another sign-in.
  expect(button(host, "Settings.Coach.SignIn.ChatGpt")).toBeUndefined();
  expect(button(host, "Settings.Coach.Connections.Add")).toBeDefined();
});

test("a sign-in that has ended is marked, cannot be checked and can be renewed", async () => {
  mocks.coachConnections.mockResolvedValue([{ ...chatGpt, account: null, status: "signInAgain" }]);
  await render();
  expect(row("ChatGPT").textContent).toContain("Settings.Coach.Connection.SignInAgain");
  expect(row("ChatGPT").textContent).toContain("Coach.Error.SignInAgain");
  expect(button(row("ChatGPT"), "Settings.Coach.Connection.Check").disabled).toBe(true);
  expect(button(row("ChatGPT"), "Coach.Plan.ManageUsage")).toBeUndefined();
  expect(button(host, "Settings.Coach.SignIn.ChatGpt")).toBeDefined();
});

test("Continue with ChatGPT waits for the browser, then lists the connection and shows the plan notice once", async () => {
  mocks.coachConnections.mockResolvedValue([]);
  const first = deferred<unknown>();
  mocks.coachSignInChatgpt.mockReturnValue(first.promise);
  await render();
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  expect(mocks.coachSignInChatgpt).toHaveBeenCalledOnce();
  const attempt = mocks.coachSignInChatgpt.mock.calls[0][0] as string;
  expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
  expect(host.textContent).toContain("Settings.Coach.SignIn.Waiting");
  // A second click while the browser is open starts nothing.
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  expect(mocks.coachSignInChatgpt).toHaveBeenCalledOnce();

  mocks.coachConnections.mockResolvedValue([chatGpt]);
  await act(async () => first.resolve({ connection: chatGpt, durabilityUncertain: false }));
  expect(host.textContent).not.toContain("Settings.Coach.SignIn.Waiting");
  expect(row("ChatGPT")).not.toBeNull();
  expect(dialog()!.textContent).toContain("Coach.Plan.Notice.Title");
  expect(dialog()!.textContent).toContain("Coach.Plan.Notice.Body");
  await click(button(dialog()!, "Coach.Plan.Notice.Accept"));
  expect(dialog()).toBeNull();

  // The session ended later: signing in again shows no notice a second time.
  mocks.coachConnections.mockResolvedValue([{ ...chatGpt, status: "signInAgain" }]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  mocks.coachSignInChatgpt.mockResolvedValue({ connection: chatGpt, durabilityUncertain: true });
  mocks.coachConnections.mockResolvedValue([chatGpt]);
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  expect(dialog()).toBeNull();
  expect(row("ChatGPT").textContent).not.toContain("Settings.Coach.Connection.SignInAgain");
  // The save's durability notice is the same one an address connection shows.
  expect(host.textContent).toContain("Common.DurabilityUncertain");
});

test("a sign-in can be cancelled by its id, and only a real failure leaves a message", async () => {
  mocks.coachConnections.mockResolvedValue([]);
  const running = deferred<unknown>();
  mocks.coachSignInChatgpt.mockReturnValue(running.promise);
  await render();
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  const attempt = mocks.coachSignInChatgpt.mock.calls[0][0] as string;
  const waiting = [...host.querySelectorAll<HTMLElement>('[role="status"]')].find((node) =>
    node.textContent?.includes("Settings.Coach.SignIn.Waiting"),
  )!;
  await click(button(waiting, "Common.Cancel"));
  expect(mocks.coachCancelSignIn).toHaveBeenCalledExactlyOnceWith(attempt);
  // The native side ends the attempt; its command answers "cancelled".
  await act(async () => running.reject(new CoachCommandError("cancelled")));
  expect(host.textContent).not.toContain("Settings.Coach.SignIn.Waiting");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.coachConnections).toHaveBeenCalledTimes(1);

  mocks.coachSignInChatgpt.mockRejectedValue(new CoachCommandError("subscriptionNotEligible"));
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Coach.Error.SubscriptionNotEligible",
  );
  expect(dialog()).toBeNull();
});

test("leaving the page cancels a sign-in that still waits and ignores its late answer", async () => {
  mocks.coachConnections.mockResolvedValue([]);
  const running = deferred<unknown>();
  mocks.coachSignInChatgpt.mockReturnValue(running.promise);
  await render();
  await click(button(host, "Settings.Coach.SignIn.ChatGpt"));
  const attempt = mocks.coachSignInChatgpt.mock.calls[0][0] as string;
  await act(async () => root.unmount());
  expect(mocks.coachCancelSignIn).toHaveBeenCalledExactlyOnceWith(attempt);
  await act(async () => running.resolve({ connection: chatGpt, durabilityUncertain: false }));
  expect(mocks.coachConnections).toHaveBeenCalledTimes(1);
  root = createRoot(host);
});

test("a failed removal still re-reads the native list and keeps the dialog's error", async () => {
  await render();
  await click(button(row("Ollama"), "Settings.Coach.Connection.Remove"));
  mocks.coachRemoveConnection.mockRejectedValue(new CoachCommandError("storage"));
  await click(button(dialog()!, "Common.Remove"));
  expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull();
  expect(mocks.coachConnections).toHaveBeenCalledTimes(2);
});
