import { lazy, Suspense } from "react";

const FeedbackModal = lazy(() => import("./FeedbackModal"));

export default function LazyFeedbackModal({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <FeedbackModal opened={opened} onClose={onClose} />
    </Suspense>
  );
}
