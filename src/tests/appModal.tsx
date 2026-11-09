import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Test double of AppModal's pending contract: no close control while pending. */
export function PendingAppModal({
  children,
  pending = false,
  onClose,
}: {
  children: ReactNode;
  pending?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="dialog" data-pending={pending}>
      {!pending && (
        <button
          type="button"
          aria-label={t("Common.Close", { defaultValue: "Close dialog" })}
          onClick={onClose}
        />
      )}
      {children}
    </div>
  );
}
