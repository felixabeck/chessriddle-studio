import { Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TrainingSettings } from "@/bindings";

export default function TrainingTimer({
  start,
  settings,
}: {
  start: number;
  settings: TrainingSettings;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(interval);
  }, [start]);
  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  const seconds =
    settings.timerMode === "down" ? Math.max(0, settings.timerDuration - elapsed) : elapsed;
  return (
    <Text
      size="sm"
      fw={600}
      c={settings.timerMode === "down" && seconds === 0 ? "warning" : undefined}
      role="timer"
      aria-label={t("Training.Settings.ShowTimer")}
    >
      {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
    </Text>
  );
}
