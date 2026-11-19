import { getDefaultZIndex, Stack } from "@mantine/core";
import { type ReactNode, useEffect, useRef } from "react";
import classes from "./FixedNoticeStack.module.css";

/**
 * How far the toast column must rise to clear the notice stack: the stack's height plus one
 * gap while any notice shows, `0px` otherwise. Published on `<html>` because Mantine renders
 * `<Notifications>` in a portal that cannot inherit from the stack.
 */
export const FIXED_NOTICE_STACK_OFFSET = "--fixed-notice-stack-offset";

/** `classNames.root` for `<Notifications>`: lifts the bottom-right toast column above the stack. */
export const fixedNoticeToastRoot = classes.toastRoot;

/**
 * The one bottom-right slot for app-wide, nonmodal notices. Children stack in it instead of
 * each hand-placing itself in the same corner, and the toast column sits above it.
 */
export function FixedNoticeStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stack = ref.current;
    if (!stack) return;
    const root = document.documentElement;
    const publish = () => {
      const height = stack.offsetHeight;
      root.style.setProperty(
        FIXED_NOTICE_STACK_OFFSET,
        height > 0 ? `calc(${height}px + var(--mantine-spacing-xs))` : "0px",
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(stack);
    return () => {
      observer.disconnect();
      root.style.removeProperty(FIXED_NOTICE_STACK_OFFSET);
    };
  }, []);

  return (
    <Stack
      ref={ref}
      data-fixed-notice-stack=""
      gap="xs"
      pos="fixed"
      bottom="var(--mantine-spacing-xs)"
      right="var(--mantine-spacing-xs)"
      w="36rem"
      style={{
        // Keep dialogs and menus above these nonmodal notices.
        zIndex: getDefaultZIndex("modal") - 1,
        maxWidth: "calc(100vw - 2rem)",
        maxHeight: "calc(100dvh - 2rem)",
      }}
    >
      {children}
    </Stack>
  );
}
