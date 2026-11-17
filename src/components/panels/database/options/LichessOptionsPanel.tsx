import { InputWrapper, SegmentedControl, SimpleGrid, Stack, TextInput } from "@mantine/core";
import { MonthPickerInput } from "@mantine/dates";
import { ChevronRight, ChevronsRight, Clock4, Flame, Hourglass, Send } from "lucide-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import ToggleButtonGroup, {
  type ToggleButtonGroupOption,
} from "@/components/common/ToggleButtonGroup";
import { lichessOptionsAtom } from "@/state/atoms";
import { capitalize } from "@/utils/format";
import { MIN_DATE } from "@/utils/lichess/api";
import {
  formatExplorerDate,
  type LichessGameSpeed,
  type LichessRating,
} from "@/utils/lichess/explorer";
import { FILTER_LABEL_PROPS, YearPresetButtons } from "./filterControls";

const LichessOptionsPanel = () => {
  const { t } = useTranslation();

  const [options, setOptions] = useAtom(lichessOptionsAtom);

  const timeControls: LichessGameSpeed[] = [
    "ultraBullet",
    "bullet",
    "blitz",
    "rapid",
    "classical",
    "correspondence",
  ];
  const ratings: LichessRating[] = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

  function mapTimeControl(speed: LichessGameSpeed): ToggleButtonGroupOption<LichessGameSpeed> {
    const name = `${speed.charAt(0).toUpperCase()}${speed.slice(1)}`;
    const icon = match(speed)
      .with("ultraBullet", () => <ChevronsRight />)
      .with("bullet", () => <ChevronRight />)
      .with("blitz", () => <Flame />)
      .with("rapid", () => <Hourglass />)
      .with("classical", () => <Clock4 />)
      .with("correspondence", () => <Send />)
      .exhaustive();
    return {
      content: icon,
      name: t(`TimeControl.${capitalize(name)}`),
      value: speed,
      isToggled: (options.speeds ?? []).some((s) => s === speed),
    };
  }

  function mapRatingOption(rating: LichessRating): ToggleButtonGroupOption<LichessRating> {
    const name = rating === 0 ? "400" : rating.toString();
    return {
      content: <span>{name}</span>,
      name: name,
      value: rating,
      isToggled: (options.ratings ?? []).some((r) => r === rating),
    };
  }

  function toggleTimeControl(speed: LichessGameSpeed) {
    const selected = options.speeds ?? [];
    const newSelected = [...selected];
    const index = newSelected.indexOf(speed);
    if (index >= 0) {
      if (newSelected.length > 1) {
        newSelected.splice(index, 1);
      }
    } else {
      newSelected.push(speed);
    }
    setOptions({ ...options, speeds: newSelected });
  }

  function toggleRating(rating: LichessRating) {
    const selected = options.ratings ?? [];
    const newSelected = [...selected];
    const index = newSelected.indexOf(rating);
    if (index >= 0) {
      if (newSelected.length > 1) {
        newSelected.splice(index, 1);
      }
    } else {
      newSelected.push(rating);
    }
    setOptions({ ...options, ratings: newSelected });
  }

  const hasPlayer = (options.player ?? "").trim() !== "";

  return (
    <Stack justify="flex-start">
      <SimpleGrid cols={2}>
        <TextInput
          label={t("Board.Database.Local.Player")}
          labelProps={FILTER_LABEL_PROPS}
          placeholder={t("Home.Accounts.Username")}
          value={options.player ?? ""}
          onChange={(e) => setOptions({ ...options, player: e.currentTarget.value })}
        />
        <InputWrapper label={t("Board.Database.Local.PlaysAs")} labelProps={FILTER_LABEL_PROPS}>
          <SegmentedControl
            fullWidth
            // The colour only says which side the named player has.
            disabled={!hasPlayer}
            data={[
              { value: "white", label: t("Fen.White") },
              { value: "black", label: t("Fen.Black") },
            ]}
            value={options.color}
            onChange={(v) => setOptions({ ...options, color: v as "white" | "black" })}
          />
        </InputWrapper>
        <Stack gap={4}>
          <MonthPickerInput
            label={t("Common.From")}
            labelProps={FILTER_LABEL_PROPS}
            placeholder={t("Common.StartDate")}
            value={options.since ? formatExplorerDate(options.since) : null}
            minDate={MIN_DATE}
            maxDate={new Date()}
            onChange={(value) =>
              setOptions({
                ...options,
                since: value ? new Date(value) : undefined,
              })
            }
            clearable
          />
          <YearPresetButtons
            onPick={(start) => setOptions({ ...options, since: start.toDate() })}
          />
        </Stack>
        <MonthPickerInput
          label={t("Common.To")}
          labelProps={FILTER_LABEL_PROPS}
          placeholder={t("Common.EndDate")}
          value={options.until ? formatExplorerDate(options.until) : null}
          minDate={MIN_DATE}
          maxDate={new Date()}
          onChange={(value) =>
            setOptions({
              ...options,
              until: value ? new Date(value) : undefined,
            })
          }
          clearable
        />
      </SimpleGrid>
      <ToggleButtonGroup
        label={t("Board.Database.AverageRating")}
        labelProps={FILTER_LABEL_PROPS}
        options={ratings.map(mapRatingOption)}
        toggleOption={toggleRating}
        minButtonWidth="9ch"
      />
      <ToggleButtonGroup
        label={t("Board.Database.TimeControl")}
        labelProps={FILTER_LABEL_PROPS}
        options={timeControls.map(mapTimeControl)}
        toggleOption={toggleTimeControl}
        minButtonWidth="9ch"
        includeTooltips
      />
    </Stack>
  );
};

export default LichessOptionsPanel;
