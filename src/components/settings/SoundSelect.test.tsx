import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_THEME, MantineProvider, mergeMantineTheme, type SelectProps } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import { createAppTheme } from "@/styles/theme";
import { chooseSelectOption } from "@/tests/select";
import { SettingRow } from "./SettingsLayout";
import SoundSelect from "./SoundSelect";

const collection = vi.hoisted(() => ({
  current: "standard",
  set: vi.fn(),
}));
const playSound = vi.hoisted(() => vi.fn());
const selectOnChange = vi.hoisted(() => vi.fn());

vi.mock("./SettingsSelect", async (importOriginal) => {
  const { default: SettingsSelect } = await importOriginal<typeof import("./SettingsSelect")>();
  return {
    default: (props: SelectProps) => (
      <SettingsSelect
        {...props}
        onChange={(val, option) => {
          selectOnChange(val, option);
          props.onChange?.(val, option);
        }}
      />
    ),
  };
});

vi.mock("jotai", async () => {
  const { useState } = await import("react");
  return {
    useAtom: () => {
      const [value, setValue] = useState(collection.current);
      return [
        value,
        (next: string) => {
          collection.set(next);
          setValue(next);
        },
      ];
    },
  };
});
vi.mock("@/state/atoms", () => ({ soundCollectionAtom: {} }));
vi.mock("@/utils/sound", () => ({ playSound }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const theme = mergeMantineTheme(DEFAULT_THEME, createAppTheme({ spellCheck: true, fontSize: 100 }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let restoreScrollIntoView: (() => void) | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  collection.current = "standard";
  collection.set.mockReset();
  playSound.mockReset();
  selectOnChange.mockReset();
  restoreScrollIntoView?.();
  restoreScrollIntoView = undefined;
});

async function renderSelect(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MantineProvider theme={theme}>{node}</MantineProvider>));
}

test("renders a Mantine Select named by the Sound Collection row and plays a sound after a choice", async () => {
  restoreScrollIntoView = stubScrollIntoView();
  await renderSelect(
    <SettingRow title="Sound Collection" description="d">
      <SoundSelect />
    </SettingRow>,
  );

  const input = host!.querySelector<HTMLInputElement>("input.mantine-Select-input");
  expect(input).not.toBeNull();
  expect(input!.getAttribute("aria-label")).toBe("Sound Collection");
  expect(host!.querySelector("select")).toBeNull();
  expect(host!.querySelector('button[aria-haspopup="listbox"]')).toBeNull();

  await chooseSelectOption(input!, "Piano");

  expect(collection.set).toHaveBeenCalledWith("piano");
  expect(playSound).toHaveBeenCalledWith(false, false);
});

test("clicking the selected collection keeps it and does not clear or play", async () => {
  restoreScrollIntoView = stubScrollIntoView();
  await renderSelect(
    <SettingRow title="Sound Collection" description="d">
      <SoundSelect />
    </SettingRow>,
  );

  const input = host!.querySelector<HTMLInputElement>("input.mantine-Select-input")!;
  expect(input.value).toBe("Standard");

  await chooseSelectOption(input, "Standard");

  expect(input.value).toBe("Standard");
  expect(selectOnChange).not.toHaveBeenCalled();
  expect(selectOnChange).not.toHaveBeenCalledWith(null);
  expect(collection.set).not.toHaveBeenCalled();
  expect(playSound).not.toHaveBeenCalled();
});
