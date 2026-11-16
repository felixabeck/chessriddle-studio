import { wrappingButton } from "@/components/common/wrappingButton";
import { Button } from "@mantine/core";
import { ScanSearch } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

// The surface owns one admission lock, shared by its button and every row gesture.
// Capture the target before awaiting. Selection may change while this operation finishes.
export function useGameOpen<T>(
  open: (target: T) => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function activate(target: T) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await open(target);
    } catch (error) {
      onError(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return { activate, pending };
}

export function gameRowActivation<T>(target: T, activate: (target: T) => void | Promise<void>) {
  return {
    tabIndex: 0,
    onDoubleClick: (event: MouseEvent<HTMLElement>) => {
      // Text and cells belong to the row, nested interactive controls own their gestures.
      const control = (event.target as Element).closest("button, a, input, select, textarea");
      if (control && control !== event.currentTarget) return;
      void activate(target);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" || event.repeat || event.target !== event.currentTarget) return;
      event.preventDefault();
      void activate(target);
    },
  };
}

export function OpenGameButton({
  onOpen,
  pending = false,
  disabled = false,
  fullWidth = false,
}: {
  onOpen: () => void | Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="light"
      leftSection={<ScanSearch size="1.2rem" />}
      disabled={disabled || pending}
      aria-busy={pending}
      onClick={() => void onOpen()}
      miw={0}
      maw="100%"
      fullWidth={fullWidth}
      // A stretched button also takes wrap-button so its label keeps word-wrapping padding at
      // full width (see src/styles/global.css .wrap-button); wrappingButton alone does not.
      className={fullWidth ? "wrap-button" : undefined}
      styles={{
        ...wrappingButton,
        root: { ...wrappingButton.root, flexShrink: 0 },
      }}
    >
      {t("Common.OpenGame", { defaultValue: "Open game" })}
    </Button>
  );
}
