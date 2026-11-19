import {
  Accordion,
  Alert,
  RangeSlider,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { TriangleAlert } from "lucide-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import {
  hidePuzzleRatingAtom,
  jumpToNextPuzzleAtom,
  progressivePuzzlesAtom,
  puzzleRatingRangeAtom,
  trackPuzzleTimeAtom,
} from "@/state/atoms";
import { formatThemeLabel } from "@/utils/format";

const puzzleRatingMarks = [600, 1700, 2800] as const;

function PuzzleSettingsPanel({
  opened,
  onOpenedChange,
  themesTableMissing,
  availableThemes,
  selectedTheme,
  onSelectedThemeChange,
  onTrackTimeDisabled,
}: {
  opened: boolean;
  onOpenedChange: (opened: boolean) => void;
  themesTableMissing: boolean;
  availableThemes: string[];
  selectedTheme: string | null;
  onSelectedThemeChange: (theme: string | null) => void;
  onTrackTimeDisabled: () => void;
}) {
  const { t } = useTranslation();
  const [ratingRange, setRatingRange] = useAtom(puzzleRatingRangeAtom);
  const [progressive, setProgressive] = useAtom(progressivePuzzlesAtom);
  const [hideRating, setHideRating] = useAtom(hidePuzzleRatingAtom);
  const [jumpToNextPuzzleImmediately, setJumpToNextPuzzleImmediately] =
    useAtom(jumpToNextPuzzleAtom);
  const [trackTime, setTrackTime] = useAtom(trackPuzzleTimeAtom);

  return (
    <Accordion
      value={opened ? "settings" : null}
      onChange={(v) => onOpenedChange(v === "settings")}
      mb="sm"
    >
      <Accordion.Item value="settings">
        <Accordion.Panel>
          <Stack gap="md">
            {themesTableMissing && (
              <Alert icon={<TriangleAlert />} title={t("Puzzle.DatabaseOutdated")} color="warning">
                {t("Puzzle.DatabaseOutdatedDesc")}
              </Alert>
            )}
            <div>
              <Text size="sm" fw={500} mb={4}>
                {t("Puzzle.RatingRange")}
              </Text>
              <RangeSlider
                min={600}
                my="md"
                max={2800}
                value={ratingRange}
                onChange={setRatingRange}
                disabled={progressive}
                marks={puzzleRatingMarks.map((value) => ({ value, label: String(value) }))}
              />
            </div>
            <Select
              label={t("Puzzle.Theme")}
              placeholder={t("Puzzle.AllThemes")}
              data={availableThemes.map((theme) => ({
                label: formatThemeLabel(theme),
                value: theme,
              }))}
              value={selectedTheme}
              onChange={onSelectedThemeChange}
              clearable
              searchable
            />
            <SimpleGrid cols={2} spacing="sm">
              <Switch
                label={t("Puzzle.Progressive")}
                description={t("Puzzle.Progressive.Desc")}
                checked={progressive}
                onChange={(event) => setProgressive(event.currentTarget.checked)}
              />
              <Switch
                label={t("Puzzle.HideRating")}
                description={t("Puzzle.HideRating.Desc")}
                checked={hideRating}
                onChange={(event) => setHideRating(event.currentTarget.checked)}
              />
              <Switch
                label={t("Puzzle.JumpToNextPuzzleImmediately")}
                description={t("Puzzle.JumpToNextPuzzleImmediately.Desc")}
                checked={jumpToNextPuzzleImmediately}
                onChange={(event) => setJumpToNextPuzzleImmediately(event.currentTarget.checked)}
              />
              <Switch
                label={t("Puzzle.TrackPuzzleTime")}
                description={t("Puzzle.TrackPuzzleTime.Desc")}
                checked={trackTime}
                onChange={(event) => {
                  if (!event.currentTarget.checked) {
                    onTrackTimeDisabled();
                    setTrackTime(false);
                  } else {
                    setTrackTime(true);
                  }
                }}
              />
            </SimpleGrid>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export default PuzzleSettingsPanel;
