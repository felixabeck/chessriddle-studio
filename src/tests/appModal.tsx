import type { ReactNode } from "react";

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
  return (
    <div role="dialog" data-pending={pending}>
      {!pending && <button type="button" aria-label="Close dialog" onClick={onClose} />}
      {children}
    </div>
  );
}
