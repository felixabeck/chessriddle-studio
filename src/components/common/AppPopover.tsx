import {
  Popover,
  type PopoverDropdownProps,
  type PopoverProps,
  type PopoverTargetProps,
} from "@mantine/core";
import { useMergedRef } from "@mantine/hooks";
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { isPlainEscape } from "@/utils/keyboardOwnership";

// Runs after useFocusTrap's uncancelled setTimeout and Mantine's 10 ms useFocusReturn timer
// so the fading dropdown cannot pull focus back.
const ESCAPE_FOCUS_RETURN_DELAY_MS = 15;

const MANTINE_POPOVER_DROPDOWN_SELECTOR = ".mantine-Popover-dropdown";

type AppPopoverProps = Omit<PopoverProps, "trapFocus" | "closeOnEscape">;

interface AppPopoverContextValue {
  opened: boolean;
  disabled: boolean;
  isControlled: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
  toggle: () => void;
  closeFromEscape: () => void;
}

const AppPopoverContext = createContext<AppPopoverContextValue | null>(null);

function useAppPopoverContext(): AppPopoverContextValue {
  const ctx = useContext(AppPopoverContext);
  if (!ctx) {
    throw new Error("AppPopover.Target and AppPopover.Dropdown must be used within AppPopover");
  }
  return ctx;
}

function isDefaultPrevented(event: SyntheticEvent & { nativeEvent: Event }): boolean {
  return event.isDefaultPrevented() || event.nativeEvent.defaultPrevented;
}

function tryCloseOnEscape(
  ctx: AppPopoverContextValue,
  event: SyntheticEvent & { nativeEvent: globalThis.KeyboardEvent },
  shouldClose?: () => boolean,
) {
  if (
    !ctx.opened ||
    ctx.disabled ||
    !isPlainEscape(event.nativeEvent) ||
    isDefaultPrevented(event)
  ) {
    return;
  }
  if (shouldClose && !shouldClose()) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  ctx.closeFromEscape();
}

function singleElementChild(children: ReactNode): ReactElement | null {
  const items = Children.toArray(children);
  if (items.length !== 1 || !isValidElement(items[0])) {
    return null;
  }
  return items[0];
}

// The first check catches a nested dropdown rendered in a portal that holds the target;
// the second catches an inline (withinPortal: false) nested dropdown shown while focus stays on its input.
function hasShownNestedDropdown(dropdown: HTMLElement, target: EventTarget | null): boolean {
  const targetElement =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const targetDropdown = targetElement?.closest(MANTINE_POPOVER_DROPDOWN_SELECTOR);
  if (targetDropdown && targetDropdown !== dropdown) {
    return true;
  }

  for (const nested of dropdown.querySelectorAll(MANTINE_POPOVER_DROPDOWN_SELECTOR)) {
    if (!nested.hasAttribute("data-hidden") && getComputedStyle(nested).display !== "none") {
      return true;
    }
  }
  return false;
}

const AppPopoverTarget = forwardRef<HTMLElement, PopoverTargetProps>(function AppPopoverTarget(
  { children, refProp = "ref", ...props },
  ref,
) {
  const ctx = useAppPopoverContext();
  const child = singleElementChild(children);
  const existingRef = child
    ? ((child.props as Record<string, unknown>)[refProp] as Ref<HTMLElement> | undefined)
    : undefined;
  const mergedChildRef = useMergedRef(ctx.triggerRef, existingRef);

  if (!child) {
    return (
      <Popover.Target ref={ref} refProp={refProp} {...props}>
        {children}
      </Popover.Target>
    );
  }

  const childProps = child.props as {
    onClick?: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
    disabled?: boolean;
  };
  const triggerDisabled = ctx.disabled || Boolean(childProps.disabled);

  const clonedChild = cloneElement(child, {
    [refProp]: mergedChildRef,
    ...(!ctx.isControlled
      ? {
          onClick: (event: MouseEvent<HTMLElement>) => {
            if (!triggerDisabled) {
              ctx.toggle();
            }
            childProps.onClick?.(event);
          },
        }
      : null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      childProps.onKeyDown?.(event);
      tryCloseOnEscape(ctx, event);
    },
  } as Record<string, unknown>);

  return (
    <Popover.Target ref={ref} refProp={refProp} {...props}>
      {clonedChild}
    </Popover.Target>
  );
});

const AppPopoverDropdown = forwardRef<HTMLDivElement, PopoverDropdownProps>(
  function AppPopoverDropdown({ onKeyDownCapture, ...props }, ref) {
    const ctx = useAppPopoverContext();
    const mergedRef = useMergedRef(ctx.dropdownRef, ref);

    const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
      onKeyDownCapture?.(event);
      tryCloseOnEscape(ctx, event, () => {
        const dropdown = ctx.dropdownRef.current ?? event.currentTarget;
        return !hasShownNestedDropdown(dropdown, event.target);
      });
    };

    return <Popover.Dropdown {...props} ref={mergedRef} onKeyDownCapture={handleKeyDownCapture} />;
  },
);

/**
 * Shared popover contract: always traps focus and closes only the innermost shown layer on
 * Escape, whether focus is on the trigger or inside the dropdown.
 */
export function AppPopover({
  opened: openedProp,
  defaultOpened,
  onChange,
  onDismiss,
  disabled = false,
  children,
  ...props
}: AppPopoverProps) {
  const isControlled = typeof openedProp === "boolean";
  const [uncontrolledOpened, setUncontrolledOpened] = useState(defaultOpened ?? false);
  const opened = isControlled ? openedProp : uncontrolledOpened;

  const triggerRef = useRef<HTMLElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const closedByEscapeRef = useRef(false);

  const commitOpenChange = (nextOpened: boolean) => {
    if (!isControlled) {
      setUncontrolledOpened(nextOpened);
    }
    onChange?.(nextOpened);
  };

  const handleMantineChange = (nextOpened: boolean) => {
    closedByEscapeRef.current = false;
    commitOpenChange(nextOpened);
  };

  const toggle = () => {
    if (disabled) {
      return;
    }
    closedByEscapeRef.current = false;
    commitOpenChange(!opened);
  };

  const closeFromEscape = () => {
    if (!opened || disabled) {
      return;
    }
    closedByEscapeRef.current = true;
    commitOpenChange(false);
    onDismiss?.();
  };

  useEffect(() => {
    if (opened) {
      closedByEscapeRef.current = false;
      return;
    }
    if (!closedByEscapeRef.current) {
      return;
    }
    closedByEscapeRef.current = false;
    const timerId = window.setTimeout(() => {
      const active = document.activeElement;
      const focusStillInPopover =
        active === null ||
        active === document.body ||
        Boolean(dropdownRef.current?.contains(active));
      if (focusStillInPopover && triggerRef.current?.isConnected) {
        triggerRef.current.focus({ preventScroll: true });
      }
    }, ESCAPE_FOCUS_RETURN_DELAY_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [opened]);

  return (
    <AppPopoverContext.Provider
      value={{
        opened,
        disabled,
        isControlled,
        triggerRef,
        dropdownRef,
        toggle,
        closeFromEscape,
      }}
    >
      <Popover
        {...props}
        opened={opened}
        onChange={handleMantineChange}
        onDismiss={onDismiss}
        disabled={disabled}
        trapFocus
        closeOnEscape={false}
      >
        {children}
      </Popover>
    </AppPopoverContext.Provider>
  );
}

AppPopover.Target = AppPopoverTarget;
AppPopover.Dropdown = AppPopoverDropdown;

export default AppPopover;
