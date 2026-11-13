import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sessions = [
  {
    player: "Ada",
    chessCom: { username: "ada-chess" },
    lichess: { username: "ada-lichess" },
  },
];

vi.mock("@/state/atoms", () => ({ sessionsAtom: Symbol("sessions") }));
vi.mock("jotai", () => ({ useAtomValue: () => sessions }));
vi.mock("@mantine/core", () => {
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Menu: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
      Item: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
      ),
      Target: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      Dropdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }),
    Select: ({
      label,
      value,
      onChange,
      data,
    }: {
      label: string;
      value: string | null;
      onChange: (value: string) => void;
      data: Array<string | { value: string; label: string }>;
    }) => (
      <label>
        {label}
        <select
          aria-label={label}
          value={value ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {data.map((item) => {
            const option = typeof item === "string" ? { value: item, label: item } : item;
            return (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            );
          })}
        </select>
      </label>
    ),
    UnstyledButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
  };
});

import TimeControlSelector from "./TimeControlSelector";
import WebsiteAccountSelector from "./WebsiteAccountSelector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("personal card selectors", () => {
  test.each([
    {
      website: "All websites",
      values: [
        "any",
        "ultra_bullet",
        "bullet",
        "blitz",
        "rapid",
        "classical",
        "correspondence",
        "daily",
      ],
    },
    {
      website: null,
      values: [
        "any",
        "ultra_bullet",
        "bullet",
        "blitz",
        "rapid",
        "classical",
        "correspondence",
        "daily",
      ],
    },
    {
      website: "Lichess",
      values: ["any", "ultra_bullet", "bullet", "blitz", "rapid", "classical", "correspondence"],
    },
    { website: "Chess.com", values: ["any", "bullet", "blitz", "rapid", "daily"] },
  ])("offers the expected time controls for $website", async ({ website, values }) => {
    await act(async () => {
      root.render(<TimeControlSelector website={website} allowAll onTimeControlChange={vi.fn()} />);
    });

    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(select.options, (option) => option.value)).toEqual(values);
  });

  test("selects Daily across all websites and resets when switching to Lichess", async () => {
    const onTimeControlChange = vi.fn();

    await act(async () => {
      root.render(
        <TimeControlSelector
          website="All websites"
          allowAll
          onTimeControlChange={onTimeControlChange}
        />,
      );
    });

    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "daily";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe("daily");
    expect(onTimeControlChange).toHaveBeenLastCalledWith("daily");

    await act(async () => {
      root.render(
        <TimeControlSelector
          website="Lichess"
          allowAll
          onTimeControlChange={onTimeControlChange}
        />,
      );
    });
    expect(select.value).toBe("any");
    expect(onTimeControlChange).toHaveBeenLastCalledWith("any");
  });

  test("notifies a replacement time-control callback with the current selection", async () => {
    const firstCallback = vi.fn();
    const replacementCallback = vi.fn();

    await act(async () => {
      root.render(
        <TimeControlSelector
          website="Lichess"
          allowAll={false}
          onTimeControlChange={firstCallback}
        />,
      );
    });
    await act(async () => {
      root.render(
        <TimeControlSelector
          website="Lichess"
          allowAll={false}
          onTimeControlChange={replacementCallback}
        />,
      );
    });

    expect(firstCallback).toHaveBeenCalledWith("rapid");
    expect(replacementCallback).toHaveBeenCalledWith("rapid");
  });

  test("notifies replacement website and account callbacks without changing selections", async () => {
    const firstWebsiteCallback = vi.fn();
    const firstAccountCallback = vi.fn();
    const replacementWebsiteCallback = vi.fn();
    const replacementAccountCallback = vi.fn();

    await act(async () => {
      root.render(
        <WebsiteAccountSelector
          playerName="Ada"
          allowAll={false}
          onWebsiteChange={firstWebsiteCallback}
          onAccountChange={firstAccountCallback}
        />,
      );
    });
    await act(async () => {
      root.render(
        <WebsiteAccountSelector
          playerName="Ada"
          allowAll={false}
          onWebsiteChange={replacementWebsiteCallback}
          onAccountChange={replacementAccountCallback}
        />,
      );
    });

    expect(firstWebsiteCallback).toHaveBeenCalledWith("Chess.com");
    expect(firstAccountCallback).toHaveBeenCalledWith("All accounts");
    expect(replacementWebsiteCallback).toHaveBeenCalledWith("Chess.com");
    expect(replacementAccountCallback).toHaveBeenCalledWith("All accounts");
  });
});
