import { Progress, Text } from "@mantine/core";
import { useProgress } from "@/hooks/useProgress";

/**
 * A running search's status line and bar, mounted only while that search runs. Until the search
 * reports a percentage, the bar fills and animates instead.
 */
function DatabaseLoader({ progressId, label }: { progressId: string; label: string }) {
  const { progress, isActive } = useProgress(progressId);
  const reported = isActive && progress > 0;

  return (
    <>
      <Text role="status" aria-live="polite" size="sm" className="wrap-anywhere">
        {label}
        {reported ? ` ${Math.round(progress)}%` : ""}
      </Text>
      <Progress
        animated={!reported}
        value={reported ? progress : 100}
        size="xs"
        mt="xs"
        aria-label={label}
      />
    </>
  );
}

export default DatabaseLoader;
