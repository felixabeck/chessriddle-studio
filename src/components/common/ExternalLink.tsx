import { Anchor, type AnchorProps, type ElementProps } from "@mantine/core";
import type { MouseEvent, MouseEventHandler, ReactNode } from "react";
import { safeFailureContext, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";

type ExternalLinkHandlers = {
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  onAuxClick?: MouseEventHandler<HTMLAnchorElement>;
};

export type ExternalLinkAnchorProps = {
  href: string;
  target: "_blank";
  rel: "noreferrer";
  onClick: MouseEventHandler<HTMLAnchorElement>;
  onAuxClick: MouseEventHandler<HTMLAnchorElement>;
};

function openExternalUrl(href: string): void {
  void tauri.openExternalUrl(href).catch((cause: unknown) => {
    warnSafely(`Failed to open external link: ${safeFailureContext(cause).message}`);
  });
}

/**
 * Anchor attributes and activation handlers for any external link.
 *
 * Keeps `href` and `target="_blank"` as defence in depth while routing every primary click
 * (including modifier-key clicks and keyboard Enter) and middle click through the native
 * `open_external_url` command.
 */
export function externalLinkProps(
  href: string,
  handlers?: ExternalLinkHandlers,
): ExternalLinkAnchorProps {
  const onClick: MouseEventHandler<HTMLAnchorElement> = (event: MouseEvent<HTMLAnchorElement>) => {
    handlers?.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    openExternalUrl(href);
  };

  const onAuxClick: MouseEventHandler<HTMLAnchorElement> = (
    event: MouseEvent<HTMLAnchorElement>,
  ) => {
    handlers?.onAuxClick?.(event);
    if (event.defaultPrevented || event.button !== 1) return;
    event.preventDefault();
    openExternalUrl(href);
  };

  return {
    href,
    target: "_blank",
    rel: "noreferrer",
    onClick,
    onAuxClick,
  };
}

export type ExternalLinkProps = Omit<
  AnchorProps & ElementProps<"a", keyof AnchorProps>,
  "href" | "target" | "rel"
> & {
  href: string;
  children?: ReactNode;
};

/**
 * Mantine Anchor that opens external URLs through the native `open_external_url` command.
 */
export function ExternalLink({ href, onClick, onAuxClick, ...props }: ExternalLinkProps) {
  return <Anchor {...props} {...externalLinkProps(href, { onClick, onAuxClick })} />;
}

export default ExternalLink;
