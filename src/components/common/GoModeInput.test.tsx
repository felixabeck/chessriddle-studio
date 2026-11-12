import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import GoModeInput from "./GoModeInput";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NumberInput: ({ value, rightSection }: { value: number; rightSection?: React.ReactNode }) => (
    <>
      <input type="number" value={value} readOnly />
      {rightSection}
    </>
  ),
  Select: (props: {
    data: (string | { value: string; label: string })[];
    value: string;
    onChange: (value: string | null) => void;
    allowDeselect?: boolean;
  }) => {
    mocks.select(props);
    return (
      <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
        {props.data.map((option) => {
          const item = typeof option === "string" ? { value: option, label: option } : option;
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          );
        })}
      </select>
    );
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test.each([undefined, 500])("Time switches use the configured default %s", (timeDefault) => {
  const setGoMode = vi.fn();
  act(() => {
    root.render(
      <GoModeInput
        gameMode
        timeDefault={timeDefault}
        goMode={{ t: "Depth", c: 30 }}
        setGoMode={setGoMode}
      />,
    );
  });
  act(() => {
    const select = host.querySelector("select")!;
    select.value = "Time";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(setGoMode).toHaveBeenCalledExactlyOnceWith({ t: "Time", c: timeDefault ?? 8000 });
});

test.each([
  ["Depth", 20],
  ["Nodes", 1000000],
])("%s switches keep their shared default", (type, count) => {
  const goMode = { t: "Time" as const, c: 500 };
  const setGoMode = vi.fn();
  act(() => {
    root.render(<GoModeInput gameMode goMode={goMode} setGoMode={setGoMode} />);
  });
  act(() => {
    const select = host.querySelector("select")!;
    select.value = type;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(setGoMode).toHaveBeenCalledExactlyOnceWith({ t: type, c: count });
  expect(setGoMode.mock.calls[0][0]).not.toBe(goMode);
  expect(goMode).toEqual({ t: "Time", c: 500 });
});

test.each([true, false])("the type Select cannot be deselected with gameMode %s", (gameMode) => {
  act(() => {
    root.render(
      <GoModeInput gameMode={gameMode} goMode={{ t: "Depth", c: 20 }} setGoMode={vi.fn()} />,
    );
  });
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ allowDeselect: false }),
  );
  expect(Array.from(host.querySelector("select")!.options, (option) => option.value)).toEqual(
    gameMode ? ["Time", "Depth", "Nodes"] : ["Time", "Depth", "Nodes", "Infinite"],
  );
});
