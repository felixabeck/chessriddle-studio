import { Autocomplete, Button, MantineProvider, Select } from "@mantine/core";
import { DateInput, MonthPickerInput } from "@mantine/dates";
import { act, forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchEscape } from "@/tests/keyboard";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { stubScrollIntoView } from "@/tests/scrollIntoView";
import AppModal from "./AppModal";
import AppPopover from "./AppPopover";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

let root: Root;
let host: HTMLDivElement;
let restoreScrollIntoView: (() => void) | undefined;

async function flushTimers(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  installResizeObserverStub();
  restoreScrollIntoView = stubScrollIntoView();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  restoreScrollIntoView?.();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("click toggles an uncontrolled popover, keeps child onClick, and ignores a disabled trigger", async () => {
  const onTriggerClick = vi.fn();
  const onDisabledClick = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger" onClick={onTriggerClick}>
              Open
            </Button>
          </AppPopover.Target>
          <AppPopover.Dropdown>
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="disabled-trigger" disabled onClick={onDisabledClick}>
              Disabled
            </Button>
          </AppPopover.Target>
          <AppPopover.Dropdown>
            <div data-testid="disabled-dropdown">Hidden</div>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  const disabledTrigger = host.querySelector<HTMLButtonElement>(
    '[data-testid="disabled-trigger"]',
  )!;

  expect(host.querySelector('[data-testid="inside"]')).toBeNull();

  await act(async () => {
    trigger.click();
  });
  expect(onTriggerClick).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-testid="inside"]')).not.toBeNull();

  await act(async () => {
    trigger.click();
  });
  expect(onTriggerClick).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-testid="inside"]')).toBeNull();

  await act(async () => {
    disabledTrigger.click();
  });
  expect(onDisabledClick).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="disabled-dropdown"]')).toBeNull();
});

test("opening moves focus into the dropdown for both uncontrolled and controlled popovers", async () => {
  const onControlledChange = vi.fn();
  const onControlledClick = vi.fn();

  function ControlledHarness() {
    const [opened, setOpened] = useState(false);
    return (
      <AppPopover
        opened={opened}
        onChange={(next) => {
          onControlledChange(next);
          setOpened(next);
        }}
      >
        <AppPopover.Target>
          <Button
            data-testid="ctrl-trigger"
            onClick={() => {
              onControlledClick();
              setOpened((current) => !current);
            }}
          >
            Controlled
          </Button>
        </AppPopover.Target>
        <AppPopover.Dropdown>
          <button type="button" data-testid="ctrl-inside">
            Inside
          </button>
        </AppPopover.Dropdown>
      </AppPopover>
    );
  }

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="unctrl-trigger">Uncontrolled</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown>
            <button type="button" data-testid="unctrl-inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
        <ControlledHarness />
      </MantineProvider>,
    );
  });

  const unctrlTrigger = host.querySelector<HTMLButtonElement>('[data-testid="unctrl-trigger"]')!;
  await act(async () => {
    unctrlTrigger.focus();
    unctrlTrigger.click();
  });
  await flushTimers();

  const unctrlInside = host.querySelector<HTMLButtonElement>('[data-testid="unctrl-inside"]')!;
  expect(document.activeElement).toBe(unctrlInside);

  const ctrlTrigger = host.querySelector<HTMLButtonElement>('[data-testid="ctrl-trigger"]')!;
  await act(async () => {
    ctrlTrigger.focus();
    ctrlTrigger.click();
  });
  await flushTimers();

  const ctrlInside = host.querySelector<HTMLButtonElement>('[data-testid="ctrl-inside"]')!;
  expect(document.activeElement).toBe(ctrlInside);
  expect(onControlledClick).toHaveBeenCalledTimes(1);
  expect(onControlledChange).not.toHaveBeenCalled();
});

test("Escape on the trigger right after opening closes it and keeps focus on the trigger after the trap timer", async () => {
  vi.useFakeTimers();

  await act(async () => {
    root.render(
      <MantineProvider>
        <AppPopover transitionProps={{ duration: 1000 }} hideDetached={false}>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown>
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  act(() => {
    trigger.focus();
    trigger.click();
  });
  act(() => {
    vi.advanceTimersToNextFrame();
  });

  // Dropdown is mounted (pre-entering), focus is still on the trigger before useFocusTrap's timer fires.
  expect(document.activeElement).toBe(trigger);
  expect(document.body.querySelector('[data-testid="inside"]')).not.toBeNull();

  const escape = dispatchEscape(trigger);
  expect(escape.defaultPrevented).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  // Advance past useFocusTrap's timer and AppPopover's focus timer while the 1000ms exit transition keeps the dropdown mounted.
  await act(async () => {
    vi.advanceTimersByTime(50);
  });
  expect(document.body.querySelector('[data-testid="inside"]')).not.toBeNull();
  expect(document.activeElement).toBe(trigger);

  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
});

test("Escape inside the dropdown closes it and returns focus to the trigger", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown>
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  await flushTimers();

  const inside = host.querySelector<HTMLButtonElement>('[data-testid="inside"]')!;
  expect(document.activeElement).toBe(inside);

  const escape = dispatchEscape(inside);
  expect(escape.defaultPrevented).toBe(true);
  await flushTimers();

  expect(host.querySelector('[data-testid="inside"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("nested DateInput, MonthPickerInput, and Select with withinPortal:false close before the popover", async () => {
  const renderNested = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(
        <MantineProvider env="test">
          <AppPopover>
            <AppPopover.Target>
              <Button data-testid="filters-trigger">Filters</Button>
            </AppPopover.Target>
            <AppPopover.Dropdown data-testid="outer-dropdown">{node}</AppPopover.Dropdown>
          </AppPopover>
        </MantineProvider>,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="filters-trigger"]')!;
    await act(async () => {
      trigger.click();
    });
    await flushTimers();
  };

  // 1. Open DateInput calendar (focus stays on input).
  await renderNested(
    <DateInput label="From" data-testid="date-input" popoverProps={{ withinPortal: false }} />,
  );
  const dateInput = host.querySelector<HTMLInputElement>('[data-testid="date-input"]')!;
  await act(async () => {
    dateInput.focus();
    dateInput.click();
  });
  await flushTimers();
  expect(document.activeElement).toBe(dateInput);
  expect(host.querySelector("[data-dates-dropdown]")).not.toBeNull();

  dispatchEscape(dateInput);
  expect(host.querySelector("[data-dates-dropdown]")).toBeNull();
  expect(host.querySelector('[data-testid="outer-dropdown"]')).not.toBeNull();

  dispatchEscape(dateInput);
  await flushTimers();
  expect(host.querySelector('[data-testid="outer-dropdown"]')).toBeNull();

  // 2. Open MonthPickerInput dropdown.
  await renderNested(<MonthPickerInput label="Month" popoverProps={{ withinPortal: false }} />);
  const monthInput = host.querySelector<HTMLButtonElement>(
    "button.mantine-MonthPickerInput-input",
  )!;
  await act(async () => {
    monthInput.click();
  });
  await flushTimers();
  const monthDropdown = host.querySelector<HTMLElement>(
    '[data-testid="outer-dropdown"] .mantine-Popover-dropdown',
  )!;
  expect(monthDropdown).not.toBeNull();
  const monthOption = monthDropdown.querySelector<HTMLElement>("button")!;

  dispatchEscape(monthOption);
  expect(host.querySelector('[data-testid="outer-dropdown"] .mantine-Popover-dropdown')).toBeNull();
  expect(host.querySelector('[data-testid="outer-dropdown"]')).not.toBeNull();

  dispatchEscape(monthInput);
  await flushTimers();
  expect(host.querySelector('[data-testid="outer-dropdown"]')).toBeNull();

  // 3. Open Select list.
  await renderNested(
    <Select
      label="Result"
      data={[
        { value: "any", label: "Any" },
        { value: "draw", label: "Draw" },
      ]}
      comboboxProps={{ withinPortal: false }}
    />,
  );
  const selectInput = host.querySelector<HTMLInputElement>("input.mantine-Select-input")!;
  await act(async () => {
    selectInput.focus();
    selectInput.click();
  });
  await flushTimers();
  const selectDropdown = host.querySelector<HTMLElement>(
    '[data-testid="outer-dropdown"] .mantine-Select-dropdown',
  )!;
  expect(getComputedStyle(selectDropdown).display).not.toBe("none");

  dispatchEscape(selectInput);
  expect(getComputedStyle(selectDropdown).display).toBe("none");
  expect(host.querySelector('[data-testid="outer-dropdown"]')).not.toBeNull();

  dispatchEscape(selectInput);
  await flushTimers();
  expect(host.querySelector('[data-testid="outer-dropdown"]')).toBeNull();
});

test("Escape inside a real-portal nested picker closes only that picker", async () => {
  await act(async () => {
    root.render(
      <MantineProvider>
        <AppPopover hideDetached={false}>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="outer-dropdown">
            <MonthPickerInput
              label="Month"
              popoverProps={{ withinPortal: true, hideDetached: false }}
            />
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => {
    trigger.click();
  });
  await flushTimers(50);

  const outerDropdown = document.body.querySelector<HTMLElement>('[data-testid="outer-dropdown"]')!;
  expect(outerDropdown).not.toBeNull();

  const monthInput = outerDropdown.querySelector<HTMLButtonElement>(
    "button.mantine-MonthPickerInput-input",
  )!;
  await act(async () => {
    monthInput.click();
  });
  await flushTimers(50);

  const allDropdowns = Array.from(
    document.body.querySelectorAll<HTMLElement>(".mantine-Popover-dropdown"),
  );
  const portaledPicker = allDropdowns.find(
    (el) => el !== outerDropdown && !outerDropdown.contains(el),
  );
  expect(portaledPicker).toBeDefined();

  const pickerControl = portaledPicker!.querySelector<HTMLElement>("button")!;
  act(() => {
    pickerControl.focus();
  });
  dispatchEscape(pickerControl);
  await flushTimers(220);

  expect(portaledPicker!.isConnected).toBe(false);
  expect(
    Array.from(document.body.querySelectorAll<HTMLElement>(".mantine-Popover-dropdown")).filter(
      (el) => el !== outerDropdown && !outerDropdown.contains(el),
    ),
  ).toHaveLength(0);
  expect(document.body.querySelector('[data-testid="outer-dropdown"]')).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

test("a closed Select and an empty Autocomplete opened on focus allow the first Escape to close the popover", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="outer-dropdown">
            <Autocomplete
              label="Player"
              data={[]}
              comboboxProps={{ withinPortal: false }}
              data-testid="auto"
            />
            <Select
              label="Result"
              data={[{ value: "any", label: "Any" }]}
              comboboxProps={{ withinPortal: false }}
              data-testid="select"
            />
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => {
    trigger.click();
  });
  await flushTimers();

  const autoInput = host.querySelector<HTMLInputElement>('[data-testid="auto"]')!;
  expect(document.activeElement).toBe(autoInput);
  const autoDropdown = host.querySelector<HTMLElement>(
    '[data-testid="outer-dropdown"] .mantine-Autocomplete-dropdown',
  )!;
  expect(autoDropdown.hasAttribute("data-hidden")).toBe(true);
  const selectDropdown = host.querySelector<HTMLElement>(
    '[data-testid="outer-dropdown"] .mantine-Select-dropdown',
  )!;
  expect(getComputedStyle(selectDropdown).display).toBe("none");

  const escape = dispatchEscape(autoInput);
  expect(escape.defaultPrevented).toBe(true);
  await flushTimers();

  expect(host.querySelector('[data-testid="outer-dropdown"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Escape on a closed trigger is not consumed and composing/defaultPrevented Escapes are ignored", async () => {
  const onChildKeyDown = vi.fn((event: React.KeyboardEvent) => {
    if (event.shiftKey) {
      event.preventDefault();
    }
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger" onKeyDown={onChildKeyDown}>
              Open
            </Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="dropdown">
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  const closedEscape = dispatchEscape(trigger);
  expect(closedEscape.defaultPrevented).toBe(false);
  expect(host.querySelector('[data-testid="dropdown"]')).toBeNull();

  await act(async () => {
    trigger.click();
  });
  await flushTimers();

  dispatchEscape(trigger, { isComposing: true });
  dispatchEscape(trigger, { keyCode: 229 });
  dispatchEscape(trigger, { shiftKey: true });
  expect(host.querySelector('[data-testid="dropdown"]')).not.toBeNull();

  const inside = host.querySelector<HTMLButtonElement>('[data-testid="inside"]')!;
  dispatchEscape(inside, { isComposing: true });
  dispatchEscape(inside, { keyCode: 229 });
  expect(host.querySelector('[data-testid="dropdown"]')).not.toBeNull();
});

test("inside AppModal, Escape at the trigger and inside closes only the popover, and the next Escape closes the dialog", async () => {
  const onModalClose = vi.fn();

  function ModalWithPopover() {
    const [popoverOpened, setPopoverOpened] = useState(false);
    return (
      <AppModal opened onClose={onModalClose} title="Settings">
        <AppPopover opened={popoverOpened} onChange={setPopoverOpened} returnFocus>
          <AppPopover.Target>
            <Button
              data-testid="popover-trigger"
              onClick={() => setPopoverOpened((current) => !current)}
            >
              Motifs
            </Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="popover-dropdown">
            <button type="button" data-testid="popover-inside">
              Choice
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </AppModal>
    );
  }

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <ModalWithPopover />
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="popover-trigger"]')!;

  // Case A: Escape on trigger right after opening.
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  expect(host.querySelector('[data-testid="popover-dropdown"]')).not.toBeNull();

  dispatchEscape(trigger);
  expect(host.querySelector('[data-testid="popover-dropdown"]')).toBeNull();
  expect(onModalClose).not.toHaveBeenCalled();

  dispatchEscape(trigger);
  expect(onModalClose).toHaveBeenCalledTimes(1);

  // Case B: Escape inside popover dropdown.
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  await flushTimers();

  const inside = host.querySelector<HTMLButtonElement>('[data-testid="popover-inside"]')!;
  expect(document.activeElement).toBe(inside);

  dispatchEscape(inside);
  await flushTimers();
  expect(host.querySelector('[data-testid="popover-dropdown"]')).toBeNull();
  expect(onModalClose).toHaveBeenCalledTimes(1);

  dispatchEscape(document.activeElement ?? trigger);
  expect(onModalClose).toHaveBeenCalledTimes(2);
});

test("AppPopover inside AppModal does not steal focus back from the modal opener when both close on consecutive Escapes", async () => {
  vi.useFakeTimers();

  function OpenerWithModalAndPopover() {
    const [modalOpened, setModalOpened] = useState(false);
    return (
      <>
        <button type="button" data-testid="modal-opener" onClick={() => setModalOpened(true)}>
          Open modal
        </button>
        <AppModal opened={modalOpened} onClose={() => setModalOpened(false)} title="Settings">
          <AppPopover hideDetached={false}>
            <AppPopover.Target>
              <Button data-testid="popover-trigger">Open popover</Button>
            </AppPopover.Target>
            <AppPopover.Dropdown>
              <button type="button" data-testid="popover-inside">
                Inside
              </button>
            </AppPopover.Dropdown>
          </AppPopover>
        </AppModal>
      </>
    );
  }

  await act(async () => {
    root.render(
      <MantineProvider>
        <OpenerWithModalAndPopover />
      </MantineProvider>,
    );
  });

  const opener = host.querySelector<HTMLButtonElement>('[data-testid="modal-opener"]')!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await act(async () => {
    vi.advanceTimersByTime(50);
  });

  const popoverTrigger = document.body.querySelector<HTMLButtonElement>(
    '[data-testid="popover-trigger"]',
  )!;
  expect(popoverTrigger).not.toBeNull();
  await act(async () => {
    popoverTrigger.focus();
    popoverTrigger.click();
  });

  // Close the popover with Escape, then immediately close the modal before timers run.
  dispatchEscape(popoverTrigger);
  dispatchEscape(popoverTrigger);

  // Modal exit transition (200 ms) still keeps popoverTrigger connected while Modal's 10 ms
  // useFocusReturn and AppPopover's 15 ms timer both run.
  await act(async () => {
    vi.advanceTimersByTime(50);
  });
  expect(popoverTrigger.isConnected).toBe(true);
  expect(document.activeElement).toBe(opener);
  expect(document.activeElement).not.toBe(popoverTrigger);

  await act(async () => {
    vi.advanceTimersByTime(250);
  });
});

test("non-Escape keydowns on open trigger and inside dropdown do not close AppPopover", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="dropdown">
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => {
    trigger.click();
  });
  await flushTimers();

  dispatchEscape(trigger, { key: "Enter" });
  dispatchEscape(trigger, { key: "a" });
  expect(host.querySelector('[data-testid="dropdown"]')).not.toBeNull();

  const inside = host.querySelector<HTMLButtonElement>('[data-testid="inside"]')!;
  dispatchEscape(inside, { key: "Enter" });
  dispatchEscape(inside, { key: "a" });
  expect(host.querySelector('[data-testid="dropdown"]')).not.toBeNull();
});

test("disabled AppPopover and disabled non-button trigger do not toggle on click", async () => {
  const NonButtonTrigger = forwardRef<
    HTMLSpanElement,
    ComponentPropsWithoutRef<"span"> & { disabled?: boolean }
  >(function NonButtonTrigger({ disabled: _disabled, ...props }, ref) {
    return <span ref={ref} role="button" tabIndex={0} {...props} />;
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover disabled>
          <AppPopover.Target>
            <Button data-testid="popover-disabled-trigger">Disabled popover</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="popover-disabled-dropdown">
            <div>Hidden</div>
          </AppPopover.Dropdown>
        </AppPopover>
        <AppPopover>
          <AppPopover.Target>
            <NonButtonTrigger data-testid="non-button-disabled" disabled>
              Span trigger
            </NonButtonTrigger>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="non-button-dropdown">
            <div>Hidden</div>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const popoverDisabledTrigger = host.querySelector<HTMLButtonElement>(
    '[data-testid="popover-disabled-trigger"]',
  )!;
  await act(async () => {
    popoverDisabledTrigger.click();
  });
  expect(host.querySelector('[data-testid="popover-disabled-dropdown"]')).toBeNull();

  const nonButtonTrigger = host.querySelector<HTMLSpanElement>(
    '[data-testid="non-button-disabled"]',
  )!;
  await act(async () => {
    nonButtonTrigger.click();
  });
  expect(host.querySelector('[data-testid="non-button-dropdown"]')).toBeNull();
});

test("Escape inside dropdown respects defaultPrevented and invokes caller onKeyDownCapture", async () => {
  const callerCapture = vi.fn((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.shiftKey) {
      event.preventDefault();
    }
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppPopover>
          <AppPopover.Target>
            <Button data-testid="trigger">Open</Button>
          </AppPopover.Target>
          <AppPopover.Dropdown data-testid="dropdown" onKeyDownCapture={callerCapture}>
            <button type="button" data-testid="inside">
              Inside
            </button>
          </AppPopover.Dropdown>
        </AppPopover>
      </MantineProvider>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  await act(async () => {
    trigger.click();
  });
  await flushTimers();

  const inside = host.querySelector<HTMLButtonElement>('[data-testid="inside"]')!;
  const escape = dispatchEscape(inside, { shiftKey: true });
  expect(callerCapture).toHaveBeenCalledTimes(1);
  expect(escape.defaultPrevented).toBe(true);
  expect(host.querySelector('[data-testid="dropdown"]')).not.toBeNull();
});
