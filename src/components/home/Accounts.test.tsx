import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "./Accounts";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateLichess: vi.fn(),
  getAuthenticationStatus: vi.fn(),
  migrateLegacyLichessToken: vi.fn(),
  getChessComAccount: vi.fn(),
  getDatabases: vi.fn(),
  getLichessAccount: vi.fn(),
  notificationsShow: vi.fn(),
}));

vi.mock("@/bindings/generated", () => ({
  commands: {
    authenticate: mocks.authenticate,
    getAuthenticationStatus: mocks.getAuthenticationStatus,
    migrateLegacyLichessToken: mocks.migrateLegacyLichessToken,
  },
}));
vi.mock("@/utils/chess.com/api", () => ({ getChessComAccount: mocks.getChessComAccount }));
vi.mock("@/utils/db", () => ({ getDatabases: mocks.getDatabases }));
vi.mock("@/utils/lichess/api", () => ({ getLichessAccount: mocks.getLichessAccount }));
vi.mock("@/utils/lichess/authentication", () => ({
  authenticateLichess: mocks.authenticateLichess,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react", () => ({ Plus: () => null }));
vi.mock("../common/AccountCards", () => ({
  default: ({ onAddAccount }: { onAddAccount: () => void }) => (
    <button type="button" onClick={onAddAccount}>
      Add account
    </button>
  ),
}));
vi.mock("../common/GenericCard", () => ({
  default: ({ Header, setSelected }: { Header: React.ReactNode; setSelected: () => void }) => (
    <button type="button" onClick={setSelected}>
      {Header}
    </button>
  ),
}));
vi.mock("./LichessLogo", () => ({ default: () => null }));
vi.mock("@mantine/core", () => ({
  Autocomplete: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  ),
  Button: ({
    children,
    loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Checkbox: ({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <label>
      {label}
      <input aria-label={label} type="checkbox" checked={checked} onChange={onChange} />
    </label>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => <span />,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: ({
    opened,
    title,
    children,
  }: {
    opened: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    opened ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextInput: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <label>
      {label}
      <input aria-label={label} value={value} onChange={onChange} />
    </label>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let Accounts: ComponentType;

function click(element: Element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function submit() {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function fillUsername(username = "player") {
  const input = document.querySelector<HTMLInputElement>(
    "input[aria-label='Home.Accounts.Username']",
  )!;
  act(() => {
    input.value = username;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function openModal() {
  const addButton = container.querySelector("button");
  expect(addButton).not.toBeNull();
  click(addButton!);
  fillUsername();
}

function chooseBrowserLogin() {
  click(document.querySelector("input[aria-label='Home.Accounts.LoginWithBrowser']")!);
}

function chooseChessCom() {
  click(
    Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Chess.com",
    )!,
  );
}

function assertNoLichessAuthentication() {
  expect(mocks.authenticateLichess).not.toHaveBeenCalled();
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.getDatabases.mockResolvedValue({
    databases: [],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getLichessAccount.mockResolvedValue({ username: "player" });
  mocks.getChessComAccount.mockResolvedValue({});
  mocks.authenticateLichess.mockResolvedValue({ ok: false });
  mocks.migrateLegacyLichessToken.mockResolvedValue({ status: "ok", data: { handle: "handle" } });
  vi.resetModules();
  Accounts = (await import("./Accounts")).default;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Accounts />);
    await Promise.resolve();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("account authentication", () => {
  test.each([
    {
      provider: "Chess.com",
      lookup: mocks.getChessComAccount,
      setup: chooseChessCom,
      assertion: undefined,
    },
    {
      provider: "Lichess",
      lookup: mocks.getLichessAccount,
      setup: undefined,
      assertion: assertNoLichessAuthentication,
    },
  ])(
    "notifies a rejected $provider lookup and keeps the add modal open",
    async ({ provider, lookup, setup, assertion }) => {
      const { sessionsAtom } = await import("@/state/atoms");
      const { getDefaultStore } = await import("jotai");
      const store = getDefaultStore();
      const sessionsBefore = store.get(sessionsAtom);
      lookup.mockRejectedValue(new Error(`${provider} lookup failed`));
      openModal();
      setup?.();

      await submit();

      expect(store.get(sessionsAtom)).toEqual(sessionsBefore);
      expect(lookup).toHaveBeenCalledTimes(1);
      assertion?.();
      expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: `${provider} lookup failed`,
      });
      expect(document.querySelector("[role='dialog']")).not.toBeNull();
      expect(document.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(
        false,
      );
    },
  );

  test("closes on success with a durability warning and hides native text", async () => {
    mocks.authenticateLichess.mockResolvedValue({ ok: true, durabilityUncertain: true });

    openModal();
    chooseBrowserLogin();
    await submit();

    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(mocks.notificationsShow).toHaveBeenCalledWith({
      message: "Home.Accounts.LinkDurabilityUncertain",
      color: "warning",
    });
    expect(JSON.stringify(mocks.notificationsShow.mock.calls)).not.toContain(
      "Home.Accounts.AuthenticationFailed",
    );
    expect(JSON.stringify(mocks.notificationsShow.mock.calls)).not.toContain("native");
  });

  test("keeps the modal open and hides native authentication errors", async () => {
    const backendError = "backend error containing token=private-token";
    mocks.authenticateLichess.mockRejectedValue(new Error(backendError));

    openModal();
    chooseBrowserLogin();
    await submit();

    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    expect(mocks.notificationsShow).toHaveBeenCalledWith({
      message: "Home.Accounts.AuthenticationFailed",
      color: "danger",
    });
    expect(JSON.stringify(mocks.notificationsShow.mock.calls)).not.toContain(backendError);
    expect(JSON.stringify(mocks.notificationsShow.mock.calls)).not.toContain("private-token");

    mocks.getLichessAccount.mockResolvedValue(null);
    chooseBrowserLogin();
    await submit();
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    expect(mocks.notificationsShow).toHaveBeenCalledTimes(1);
  });

  test("reports one generic notification when authenticate throws", async () => {
    mocks.authenticateLichess.mockRejectedValue(new Error("token=private-token"));

    openModal();
    chooseBrowserLogin();
    await submit();

    expect(mocks.notificationsShow).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.notificationsShow.mock.calls)).not.toContain("private-token");
  });

  test("locks duplicate submits while authentication is pending", async () => {
    let resolveAuthentication: ((result: { ok: false }) => void) | undefined;
    mocks.authenticateLichess.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuthentication = resolve;
        }),
    );

    openModal();
    chooseBrowserLogin();
    act(() =>
      document
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await submit();

    expect(mocks.authenticateLichess).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(true);

    await act(async () => resolveAuthentication?.({ ok: false }));
    await act(async () => root.unmount());
  });
});
