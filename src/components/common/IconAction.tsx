import {
  ActionIcon,
  Loader,
  Tooltip,
  type ActionIconProps,
  type ElementProps,
} from "@mantine/core";
import { forwardRef, type ReactElement } from "react";
import { externalLinkProps } from "./ExternalLink";

type IconActionProps = Omit<
  ActionIconProps & ElementProps<"button", keyof ActionIconProps>,
  "aria-label" | "children" | "loading"
> & {
  /** Localized accessible name and tooltip text. */
  label: string;
  /** The icon. An element, never text: the button is icon-sized and clips a word. */
  children: ReactElement;
  pending?: boolean;
  pressed?: boolean;
  /**
   * An external URL. The action renders as one link that opens it in a new window,
   * instead of a button wrapped in an anchor (two tab stops, invalid nesting).
   * A link action does not receive the forwarded ref; while disabled or pending it
   * renders as the disabled button, because an anchor cannot be disabled.
   */
  href?: string;
};

/**
 * The only icon-only action primitive. It keeps the accessible name, keyboard
 * behaviour, pressed state, pending state, and visible tooltip in sync.
 */
export const IconAction = forwardRef<HTMLButtonElement, IconActionProps>(function IconAction(
  { label, children, pending = false, pressed, disabled, href, ...props },
  ref,
) {
  const unavailable = disabled || pending;
  const shared = {
    "aria-label": label,
    "aria-busy": pending || undefined,
    "aria-pressed": pressed,
    disabled: unavailable,
    children: pending ? <Loader size="1em" aria-hidden /> : children,
  };
  // The rest props are declared for the button form; their DOM handlers apply to the
  // anchor unchanged. The forwarded ref is button-typed, so a link action takes none.
  // An anchor cannot be disabled, so an unavailable link renders as the disabled button.
  const anchorProps = props as ActionIconProps & ElementProps<"a", keyof ActionIconProps>;
  const action =
    href && !unavailable ? (
      <ActionIcon
        {...anchorProps}
        {...shared}
        component="a"
        {...externalLinkProps(href, {
          onClick: anchorProps.onClick,
          onAuxClick: anchorProps.onAuxClick,
        })}
      />
    ) : (
      <ActionIcon {...props} {...shared} ref={ref} />
    );

  return (
    <Tooltip label={label} withinPortal>
      {unavailable ? <span>{action}</span> : action}
    </Tooltip>
  );
});

export default IconAction;
