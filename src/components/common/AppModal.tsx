import { Modal, type ModalProps } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isPlainEscape } from "@/utils/keyboardOwnership";

type AppModalProps = Omit<
  ModalProps,
  "closeButtonProps" | "closeOnClickOutside" | "closeOnEscape"
> & {
  pending?: boolean;
};

type EscapeStackEntry = {
  token: symbol;
  openSeq: number;
};

/**
 * Every currently open `AppModal` instance (pending or dismissible), ordered by the render-time
 * `openSeq` recorded when `opened` became true. Parent renders before child, so a parent and child
 * opening in the same commit still order the child on top; a later root-level modal gets a higher
 * `openSeq` and sits above earlier nested modals.
 */
const openEscapeStack: EscapeStackEntry[] = [];
let nextOpenSeq = 1;

function isTopmostEscapeModal(token: symbol): boolean {
  let top: EscapeStackEntry | undefined;
  for (const entry of openEscapeStack) {
    if (!top || entry.openSeq > top.openSeq) {
      top = entry;
    }
  }
  return top?.token === token;
}

/**
 * Shared dialog contract: every close button is named, pending work cannot be dismissed, and
 * Escape acts only on the topmost open modal in the window bubble phase (doing nothing if the
 * topmost modal is pending so modals beneath are never dismissed).
 */
export function AppModal({ pending = false, ...props }: AppModalProps) {
  const { t } = useTranslation();
  const { opened, onClose } = props;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const openSeqRef = useRef<number | null>(null);
  if (opened) {
    if (openSeqRef.current === null) {
      openSeqRef.current = nextOpenSeq++;
    }
  } else {
    openSeqRef.current = null;
  }

  useEffect(() => {
    if (!opened) {
      return;
    }
    const token = Symbol("AppModal");
    const openSeq = openSeqRef.current ?? nextOpenSeq++;
    openEscapeStack.push({ token, openSeq });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostEscapeModal(token)) {
        return;
      }
      if (!isPlainEscape(event) || event.defaultPrevented) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.getAttribute("data-mantine-stop-propagation") === "true"
      ) {
        return;
      }
      event.preventDefault();
      if (pendingRef.current) {
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const index = openEscapeStack.findIndex((entry) => entry.token === token);
      if (index >= 0) {
        openEscapeStack.splice(index, 1);
      }
    };
  }, [opened]);

  return (
    <Modal
      {...props}
      withCloseButton={pending ? false : props.withCloseButton}
      closeButtonProps={{ "aria-label": t("Common.Close", { defaultValue: "Close dialog" }) }}
      closeOnClickOutside={!pending}
      closeOnEscape={false}
    />
  );
}

export default AppModal;
