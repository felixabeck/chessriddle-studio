import { Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ScoreValue } from "@/bindings";
import { ANNOTATION_INFO } from "@/utils/annotation";
import { positionAssessment } from "@/utils/score";

/** The engine score as an advantage symbol (⩲, ∓, …), named in words on hover. */
function AssessmentSymbol({ score, fz }: { score: ScoreValue; fz: string }) {
  const { t } = useTranslation();
  const symbol = positionAssessment(score);
  const { translationKey, name } = ANNOTATION_INFO[symbol];
  const label = translationKey ? t(`Annotate.${translationKey}`) : name;
  return (
    <Tooltip label={label}>
      <Text fw="bold" fz={fz} lh={1} aria-label={label} data-testid="assessment-symbol">
        {symbol}
      </Text>
    </Tooltip>
  );
}

export default AssessmentSymbol;
