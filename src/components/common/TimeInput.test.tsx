import { MantineProvider } from "@mantine/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GoMode } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import TimeInput, { type TimeType } from "./TimeInput";

installMatchMediaStub();
installResizeObserverStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function numberField() {
  return host.querySelector<HTMLInputElement>(".mantine-NumberInput-input")!;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderTimeInput(props: {
  value: number;
  type: TimeType;
  setValue?: (v: GoMode) => void;
}) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <TimeInput value={props.value} type={props.type} setValue={props.setValue ?? vi.fn()} />
      </MantineProvider>,
    );
  });
}

function Bound({
  initial,
  type,
  setValue,
  clamp = false,
}: {
  initial: number;
  type: TimeType;
  setValue: (v: GoMode) => void;
  clamp?: boolean;
}) {
  const [value, setMs] = useState(initial);
  return (
    <TimeInput
      value={value}
      type={type}
      setValue={(next) => {
        setValue(next);
        if (next.t === "Time") setMs(clamp ? Math.max(1, next.c) : next.c);
      }}
    />
  );
}

async function renderBound(props: {
  initial: number;
  type: TimeType;
  setValue: (v: GoMode) => void;
  clamp?: boolean;
}) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <Bound {...props} />
      </MantineProvider>,
    );
  });
}

async function blurField() {
  const input = numberField();
  await act(async () => {
    input.focus();
    input.blur();
  });
}

test.each([
  [30_000, "m", "0.5"],
  [90_000, "m", "1.5"],
  [2500, "s", "2.5"],
  [1500, "s", "1.5"],
  [60_000, "m", "1"],
  [1, "s", "0.001"],
  [180_000, "h", "0.05"],
] as const)("%s ms in %s displays %s", async (ms, type, shown) => {
  await renderTimeInput({ value: ms, type });
  expect(numberField().value).toBe(shown);
});

test("typing 1.5 in m calls setValue with 90000 ms and shows 1.5", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderBound({ initial: 60_000, type: "m", setValue });
  await typeInto(numberField(), "1.5");
  expect(setValue).toHaveBeenCalledWith({ t: "Time", c: 90_000 });
  expect(numberField().value).toBe("1.5");
});

test("clearing the field calls setValue with 1 ms", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderTimeInput({ value: 90_000, type: "m", setValue });
  await typeInto(numberField(), "");
  expect(setValue).toHaveBeenCalledWith({ t: "Time", c: 1 });
});

test("keystroke 1.5 in m keeps the field and stores 90000 ms", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderBound({ initial: 300_000, type: "m", setValue });
  await typeInto(numberField(), "1");
  await typeInto(numberField(), "1.");
  expect(setValue).toHaveBeenLastCalledWith({ t: "Time", c: 60_000 });
  await typeInto(numberField(), "1.5");
  expect(numberField().value).toBe("1.5");
  expect(setValue).toHaveBeenLastCalledWith({ t: "Time", c: 90_000 });
});

test("keystroke 2.0 in m keeps the field and stores 120000 ms", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderBound({ initial: 300_000, type: "m", setValue });
  await typeInto(numberField(), "2");
  await typeInto(numberField(), "2.");
  await typeInto(numberField(), "2.0");
  expect(numberField().value).toBe("2.0");
  expect(setValue).toHaveBeenLastCalledWith({ t: "Time", c: 120_000 });
});

test("clamped keystroke 0.5 s keeps the field through blur", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderBound({ initial: 1000, type: "s", setValue, clamp: true });
  await typeInto(numberField(), "0");
  expect(numberField().value).toBe("0");
  await typeInto(numberField(), "0.");
  expect(numberField().value).toBe("0.");
  await typeInto(numberField(), "0.5");
  expect(numberField().value).toBe("0.5");
  expect(setValue).toHaveBeenLastCalledWith({ t: "Time", c: 500 });
  await blurField();
  expect(numberField().value).toBe("0.5");
});

test("clamped typing 0 s then blur shows stored 0.001", async () => {
  const setValue = vi.fn<(v: GoMode) => void>();
  await renderBound({ initial: 1000, type: "s", setValue, clamp: true });
  await typeInto(numberField(), "0");
  await blurField();
  expect(numberField().value).toBe("0.001");
});
