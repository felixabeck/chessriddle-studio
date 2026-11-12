import { Group, Stack, Text } from "@mantine/core";
import { CircleCheckBig, CircleEllipsis, CircleX } from "lucide-react";
import { useAtomValue } from "jotai";
import { match } from "ts-pattern";
import { useTranslation } from "react-i18next";
import { hidePuzzleRatingAtom } from "@/state/atoms";
import type { Completion } from "@/utils/puzzles";
import IconAction from "./IconAction";

type Challenge = {
  completion: Completion;
  label?: string;
};

function ChallengeHistory({
  challenges,
  select,
  current,
}: {
  challenges: Challenge[];
  select: (i: number) => void;
  current: number;
}) {
  const hideRating = useAtomValue(hidePuzzleRatingAtom);
  const { t } = useTranslation();

  return (
    <Group>
      {challenges.map((p, i) => {
        const isCurrent = i === current;
        return match(p.completion)
          .with("correct", () => (
            <Stack key={i} gap={0}>
              <IconAction
                label={t("ChallengeHistory.Correct", {
                  defaultValue: "Challenge {{number}}: correct",
                  number: i + 1,
                })}
                onClick={() => {
                  select(i);
                }}
                variant="light"
                aria-current={isCurrent ? "step" : undefined}
                color="success"
                style={{ border: isCurrent ? "2px solid var(--cf-chart-2)" : "none" }}
              >
                <CircleCheckBig color="var(--cf-chart-2)" />
              </IconAction>
              <Text ta="center" fz="xs" c="success">
                {p.label}
              </Text>
            </Stack>
          ))
          .with("incorrect", () => (
            <Stack key={i} gap={0}>
              <IconAction
                label={t("ChallengeHistory.Incorrect", {
                  defaultValue: "Challenge {{number}}: incorrect",
                  number: i + 1,
                })}
                onClick={() => select(i)}
                variant="light"
                aria-current={isCurrent ? "step" : undefined}
                key={i}
                color="danger"
                style={{ border: isCurrent ? "2px solid var(--cf-destructive)" : "none" }}
              >
                <CircleX color="var(--cf-destructive)" />
              </IconAction>
              <Text ta="center" fz="xs" c="danger">
                {p.label}
              </Text>
            </Stack>
          ))
          .with("incomplete", () => (
            <Stack key={i} gap={0}>
              <IconAction
                label={t("ChallengeHistory.Incomplete", {
                  defaultValue: "Challenge {{number}}: incomplete",
                  number: i + 1,
                })}
                onClick={() => select(i)}
                variant="light"
                aria-current={isCurrent ? "step" : undefined}
                key={i}
                color="warning"
                style={{ border: isCurrent ? "2px solid var(--cf-warning)" : "none" }}
              >
                <CircleEllipsis color="var(--cf-warning)" />
              </IconAction>
              <Text ta="center" fz="xs" c="warning">
                {hideRating ? "?" : p.label}
              </Text>
            </Stack>
          ))
          .exhaustive();
      })}
    </Group>
  );
}

export default ChallengeHistory;
