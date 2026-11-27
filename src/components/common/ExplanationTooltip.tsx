import { Tooltip } from "@mantine/core";
import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useState } from "react";

export interface ExplanationOpenState {
  opened: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

/**
 * Manages open/dismissed state for an explanation tooltip triggered by pointer hover or keyboard
 * focus. Dismisses on Escape via the focused trigger or, when hover-opened without focus, via a
 * window keydown listener.
 */
export function useExplanationOpen(): ExplanationOpenState {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const opened = (hovered || focused) && !dismissed;

  useEffect(() => {
    // Only handle window Escape when hovered without trigger focus; focused triggers dismiss via
    // onKeyDown so focus-open dismissal stays owned by the trigger itself.
    if (!opened || focused) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setDismissed(true);
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [opened, focused]);

  return {
    opened,
    onMouseEnter: () => {
      setDismissed(false);
      setHovered(true);
    },
    onMouseLeave: () => {
      setHovered(false);
    },
    onFocus: () => {
      setDismissed(false);
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape" && opened) {
        event.stopPropagation();
        setDismissed(true);
      }
    },
  };
}

/**
 * Shared explanation tooltip on the bordered popover surface with viewport clamping so 200%
 * typography cannot widen a 320px panel.
 */
export function ExplanationTooltip({
  label,
  opened,
  children,
}: {
  label: ReactNode;
  opened: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip
      label={label}
      multiline
      // 260 is rem-based (16.25rem). At 200% type that is 520px, wider than a 320px window.
      // Cap to the viewport and pin with shift/flip so the explanation cannot widen the page.
      w="min(16.25rem, calc(100vw - 16px))"
      maw="calc(100vw - 16px)"
      withinPortal
      floatingStrategy="fixed"
      middlewares={{ flip: true, shift: true, inline: false }}
      opened={opened}
      events={{ hover: false, focus: false, touch: false }}
    >
      {children}
    </Tooltip>
  );
}
