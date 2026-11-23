import { Modal, type ModalProps } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { isPlainEscape } from "@/utils/keyboardOwnership";

type AppModalProps = Omit<
  ModalProps,
  "closeButtonProps" | "closeOnClickOutside" | "closeOnEscape"
> & {
  pending?: boolean;
};

/**
 * Shared dialog contract: every close button is named, pending work cannot be dismissed, and
 * Escape closes in the window bubble phase so inner layers can consume it first.
 */
export function AppModal({ pending = false, ...props }: AppModalProps) {
  const { t } = useTranslation();
  const { opened, onClose } = props;

  useEffect(() => {
    if (!opened || pending) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscape(event) || event.defaultPrevented) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.getAttribute("data-mantine-stop-propagation") === "true"
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [opened, pending, onClose]);

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
