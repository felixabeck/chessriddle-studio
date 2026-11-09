import { Button } from "@mantine/core";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { wrappingButton } from "@/components/common/wrappingButton";
import { chessBaseGuideAtom } from "./chessBaseGuideState";

export function ChessBaseGuideLink() {
  const { t } = useTranslation();
  const setGuide = useSetAtom(chessBaseGuideAtom);
  return (
    <Button
      variant="subtle"
      size="compact-sm"
      h="auto"
      py="xs"
      styles={wrappingButton}
      onClick={() => setGuide("link")}
    >
      {t("ChessBaseGuide.Title")}
    </Button>
  );
}
