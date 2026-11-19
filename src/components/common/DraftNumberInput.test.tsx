import { MantineProvider } from "@mantine/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import DraftNumberInput from "./DraftNumberInput";

installMatchMediaStub();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
const stored = vi.fn();
const blurred = vi.fn();

beforeEach(() => {
  stored.mockReset();
  blurred.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// Stores only whole numbers in range, the way the settings callers do.
function Harness({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <DraftNumberInput
      aria-label="field"
      min={1}
      max={32}
      allowDecimal={false}
      value={value}
      onBlur={blurred}
      onChange={(next) => {
        if (typeof next === "number" && next >= 1 && next <= 32) {
          stored(next);
          setValue(next);
        }
      }}
    />
  );
}

async function mount(initial: number) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Harness initial={initial} />
      </MantineProvider>,
    ),
  );
  return host.querySelector<HTMLInputElement>("input")!;
}

async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.focus();
    input.blur();
  });
}

test("a cleared field shows the stored value again on blur", async () => {
  const input = await mount(4);
  await type(input, "");
  expect(input.value).toBe("");
  await blur(input);
  expect(input.value).toBe("4");
  expect(stored).not.toHaveBeenCalled();
  expect(blurred).toHaveBeenCalledOnce();
});

test("an out-of-range draft is clamped on blur and the clamped value is stored", async () => {
  const input = await mount(4);
  await type(input, "99");
  expect(stored).not.toHaveBeenCalled();
  await blur(input);
  expect(stored).toHaveBeenLastCalledWith(32);
  expect(input.value).toBe("32");
});

test("a valid draft is stored while typing and kept after blur", async () => {
  const input = await mount(4);
  await type(input, "8");
  expect(stored).toHaveBeenLastCalledWith(8);
  await blur(input);
  expect(input.value).toBe("8");
});
