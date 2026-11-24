import { lazy, Suspense } from "react";
import type { FeedbackModalProps } from "./FeedbackModal";

const FeedbackModal = lazy(() => import("./FeedbackModal"));

export default function LazyFeedbackModal({
  opened,
  onClose,
  initialType,
  initialMessage,
}: FeedbackModalProps) {
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <FeedbackModal
        opened={opened}
        onClose={onClose}
        initialType={initialType}
        initialMessage={initialMessage}
      />
    </Suspense>
  );
}
