import {
  Autocomplete,
  Box,
  Combobox,
  type ComboboxItem,
  Group,
  InputBase,
  OptionsDropdown,
  type OptionsFilter,
  Select,
  Stack,
  Text,
  TextInput,
  useCombobox,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import cx from "clsx";
import dayjs from "dayjs";
import type { TFunction } from "i18next";
import { memo, useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createStore, useStore } from "zustand";
import type { Outcome } from "@/bindings";
import type { Color } from "chessops";
import { formatTimeControl, parseTimeControl, resolveTimeControl } from "@/utils/clock";
import { lineTitleOf } from "@/utils/lineTitle";
import { externalLinkProps } from "./ExternalLink";
import {
  getEffectiveGameEnd,
  getEffectiveTermination,
  type GameHeaders,
} from "@/utils/treeReducer";
import { FidePlayerDialogs } from "./FidePlayerDialogs";
import classes from "./GameInfo.module.css";
import { InlineInput } from "./InlineInput";
import { TreeStateContext } from "./TreeStateContext";

const EMPTY_STORE = createStore(() => ({
  documentId: 0,
  setHeaders: (_headers: GameHeaders) => {},
}));

const SITE_PLATFORM_LABELS = new Map([
  ["https://lichess.org", "Lichess"],
  ["https://www.chess.com", "Chess.com"],
]);

/** Returns the platform label for an exact trusted origin without credentials. */
function sitePlatformLabel(site: string): string | null {
  try {
    const url = new URL(site);
    if (url.username || url.password) return null;
    return SITE_PLATFORM_LABELS.get(url.origin) ?? null;
  } catch {
    return null;
  }
}

function GameInfo({
  headers,
  simplified,
  timeControlReadOnly = false,
}: {
  headers: GameHeaders;
  simplified?: boolean;
  /** Locks the Time control row in contexts whose setup owns the control (e.g. played games). */
  timeControlReadOnly?: boolean;
}) {
  const { t } = useTranslation();
  const contextStore = useContext(TreeStateContext);
  const store = contextStore || EMPTY_STORE;
  const disabled = store === EMPTY_STORE;
  const setHeaders = useStore(store, (s) => s.setHeaders);

  const date = headers.date
    ? dayjs(headers.date, "YYYY.MM.DD").isValid()
      ? dayjs(headers.date, "YYYY.MM.DD").toDate()
      : null
    : null;
  const partialDate = headers.date && date === null ? headers.date : null;
  const [fideColor, setFideColor] = useState<Color | null>(null);
  const eloInputValue = (elo: number | null | undefined) =>
    elo === 0 ? t("GameInfo.Unrated") : elo || "";
  // "Unrated" (any case) or "-" stores 0; an empty or non-numeric entry clears the rating.
  const parseEloInput = (val: string) =>
    val.toLowerCase() === t("GameInfo.Unrated").toLowerCase() || val === "-"
      ? 0
      : val === "" || Number.isNaN(Number.parseInt(val))
        ? undefined
        : Number.parseInt(val);

  const event = headers.event === "?" ? "" : headers.event;
  const site = headers.site === "?" ? "" : headers.site;
  const round = headers.round === "?" ? "" : (headers.round ?? "");
  const sitePlatform = sitePlatformLabel(headers.site);
  // Keep raw White text so spaces survive typing, using the normalized Event fallback only
  // when White is empty.
  const lineName = lineTitleOf({ white: headers.white }).name
    ? headers.white
    : (lineTitleOf(headers).name ?? "");

  return (
    <Box px="md" pt="md" className={classes.root}>
      <FidePlayerDialogs
        openColor={fideColor}
        setOpenColor={setFideColor}
        names={{ white: headers.white, black: headers.black }}
      />

      {simplified && (
        <Group w="100%" wrap="nowrap">
          <Group wrap="nowrap" justify="start" w="100%">
            <InlineInput
              disabled={disabled}
              value={lineName}
              aria-label={t("GameInfo.LineName")}
              placeholder={t("GameInfo.EnterLineName")}
              className={classes.input}
              onChange={(e) => setHeaders({ ...headers, white: e.target.value })}
            />
            <Text component="span" c="dimmed" size="sm" style={{ minWidth: 0 }}>
              <InlineInput
                disabled={disabled}
                value={headers.black.trim() === "?" ? "" : headers.black}
                aria-label={t("GameInfo.Idea")}
                placeholder={t("GameInfo.EnterIdea")}
                className={classes.input}
                onChange={(e) => setHeaders({ ...headers, black: e.target.value })}
              />
            </Text>
          </Group>
        </Group>
      )}
      {simplified && (
        <Group gap={4}>
          <Text size="sm">{t("GameInfo.OpeningFor")}</Text>

          <Select
            aria-label={t("GameInfo.OpeningFor")}
            allowDeselect={false}
            value={headers.orientation || "white"}
            variant="unstyled"
            rightSection={null}
            rightSectionWidth={0}
            fw="bold"
            styles={{
              input: {
                textDecoration: "underline",
              },
            }}
            onChange={(value) =>
              setHeaders({
                ...headers,
                orientation: value === "white" ? "white" : "black",
              })
            }
            data={[
              {
                value: "white",
                label: t("Fen.White"),
              },
              {
                value: "black",
                label: t("Fen.Black"),
              },
            ]}
          />
        </Group>
      )}
      {!simplified && (
        <div className={classes.grid} data-game-info-fields>
          <div className={classes.header}>
            <Text
              component="button"
              type="button"
              c="dimmed"
              tt="uppercase"
              fw="bold"
              className={cx(classes.colorHover, classes.colorLabel, classes.whiteLabel)}
              onClick={() => setFideColor("white")}
            >
              {t("Fen.White")}
            </Text>
            {/* Event and Round wrap onto two lines instead of pushing BLACK out of view. */}
            <Group
              justify="center"
              className={classes.event}
              style={{ rowGap: 0, columnGap: "var(--mantine-spacing-xs)" }}
            >
              <InlineInput
                disabled={disabled}
                value={event}
                aria-label={t("Databases.Game.Event")}
                placeholder={t("GameInfo.UnknownEvent")}
                className={classes.input}
                style={disabled ? { width: "auto" } : undefined}
                onChange={(e) => {
                  setHeaders({
                    ...headers,
                    event: e.target.value,
                  });
                }}
              />
              {(!disabled || round !== "") && (
                <Group gap={0} wrap="nowrap">
                  <Text c="dimmed" size="sm" mr="xs">
                    {t("GameInfo.Round")}
                  </Text>
                  <input
                    className={classes.roundInput}
                    placeholder="?"
                    aria-label={t("GameInfo.Round")}
                    value={round}
                    onChange={(e) =>
                      setHeaders({
                        ...headers,
                        round: e.currentTarget.value,
                      })
                    }
                    disabled={disabled}
                  />
                </Group>
              )}
            </Group>
            <Text
              component="button"
              type="button"
              c="dimmed"
              tt="uppercase"
              fw="bold"
              onClick={() => setFideColor("black")}
              className={cx(classes.colorHover, classes.colorLabel, classes.blackLabel)}
            >
              {t("Fen.Black")}
            </Text>
          </div>
          <input
            className={cx(classes.textInput, classes.white)}
            placeholder="?"
            aria-label={t("Fen.White")}
            value={headers.white}
            onChange={(e) =>
              setHeaders({
                ...headers,
                white: e.currentTarget.value,
              })
            }
            disabled={disabled}
          />
          <Group justify="center" className={classes.centre}>
            {sitePlatform !== null ? (
              <a {...externalLinkProps(headers.site)}>
                <Text p="sm" w={90}>
                  {sitePlatform}
                </Text>
              </a>
            ) : (
              <InlineInput
                className={classes.input}
                aria-label={t("Databases.Game.Site")}
                placeholder={t("GameInfo.UnknownSite")}
                value={site}
                onFocus={(e) => e.target.select()}
                onChange={(e) =>
                  setHeaders({
                    ...headers,
                    site: e.target.value,
                  })
                }
                disabled={disabled}
              />
            )}
            <DateInput
              variant="unstyled"
              valueFormat="YYYY.MM.DD"
              placeholder={partialDate ?? "????.??.??"}
              aria-label={t("Common.Date")}
              value={date}
              allowDeselect
              onChange={(date) => {
                setHeaders({
                  ...headers,
                  date: date ? dayjs(date).format("YYYY.MM.DD") : undefined,
                });
              }}
              readOnly={disabled}
              classNames={{ input: classes.dateInput }}
            />
          </Group>
          <input
            className={cx(classes.textInput, classes.right, classes.black)}
            placeholder="?"
            aria-label={t("Fen.Black")}
            value={headers.black}
            onChange={(e) =>
              setHeaders({
                ...headers,
                black: e.currentTarget.value,
              })
            }
            disabled={disabled}
          />
          <input
            className={cx(classes.textInput, classes.whiteElo)}
            aria-label={t("GameInfo.WhiteElo")}
            placeholder={t("GameInfo.UnknownElo")}
            value={eloInputValue(headers.white_elo)}
            onChange={(n) =>
              setHeaders({ ...headers, white_elo: parseEloInput(n.currentTarget.value) })
            }
            disabled={disabled}
          />
          <Box className={classes.result}>
            <label className={classes.visuallyHidden} htmlFor="game-result">
              {t("GameInfo.Result")}
            </label>
            <ResultField
              value={headers.result}
              locked={disabled}
              onChange={(result) =>
                setHeaders({
                  ...headers,
                  result,
                })
              }
            />
            {contextStore && (
              <TerminationField store={contextStore} headers={headers} disabled={disabled} />
            )}
          </Box>
          <input
            className={cx(classes.textInput, classes.right, classes.blackElo)}
            aria-label={t("GameInfo.BlackElo")}
            placeholder={t("GameInfo.UnknownElo")}
            value={eloInputValue(headers.black_elo)}
            onChange={(n) =>
              setHeaders({ ...headers, black_elo: parseEloInput(n.currentTarget.value) })
            }
            disabled={disabled}
          />
          <TimeControlField
            store={store}
            headers={headers}
            readOnly={disabled || timeControlReadOnly}
          />
        </div>
      )}
    </Box>
  );
}

const RESULT_OPTIONS = (["1-0", "0-1", "1/2-1/2", "*"] satisfies Outcome[]).map((result) => ({
  value: result,
  label: result,
}));

/**
 * The result picker. Keyboard focus (Tab) opens the list with the current result active, so
 * Enter or the arrow keys pick it; leaving the field closes the list unchanged. Pointer focus
 * keeps the plain click toggle, otherwise a click would open the list on focus and shut it again.
 */
function ResultField({
  value,
  locked,
  onChange,
}: {
  value: Outcome;
  /** Read-only game info: the result shows but never opens. */
  locked: boolean;
  onChange: (result: Outcome) => void;
}) {
  /** Set by pointerdown, read and cleared by the focus that pointerdown causes. */
  const focusFromPointer = useRef(false);
  const combobox = useCombobox({
    onDropdownOpen: () => combobox.updateSelectedOptionIndex("active"),
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  return (
    <Combobox
      store={combobox}
      readOnly={locked}
      onOptionSubmit={(next) => {
        onChange(next as Outcome);
        combobox.closeDropdown();
      }}
    >
      {/* Button semantics, as in Mantine's Select: Enter and Space open the list even after
          Escape closed it. The input itself is never typed into. */}
      <Combobox.Target targetType="button" withExpandedAttribute>
        <InputBase
          id="game-result"
          role="combobox"
          readOnly
          pointer={!locked}
          variant="unstyled"
          classNames={{ input: classes.resultInput }}
          value={value}
          onPointerDown={() => {
            focusFromPointer.current = true;
          }}
          onFocus={() => {
            if (!focusFromPointer.current && !locked) combobox.openDropdown("keyboard");
            focusFromPointer.current = false;
          }}
          onClick={() => {
            if (!locked) combobox.toggleDropdown();
          }}
          onBlur={() => {
            // A press on the already focused field fires no focus event, so clear it here.
            focusFromPointer.current = false;
            combobox.closeDropdown();
          }}
        />
      </Combobox.Target>
      {/* Mantine's own Select list, so it looks exactly like before. The props set to undefined
          are typed `T | undefined` but required; aria-label stays unset because a listbox named
          "Result" would collide with the field's label. */}
      <OptionsDropdown
        data={RESULT_OPTIONS}
        hidden={locked}
        value={value}
        withCheckIcon
        checkIconPosition="left"
        withScrollArea={false}
        filter={undefined}
        search={undefined}
        limit={undefined}
        maxDropdownHeight={undefined}
        unstyled={undefined}
        labelId={undefined}
        aria-label={undefined}
        scrollAreaProps={undefined}
      />
    </Combobox>
  );
}

function TerminationField({
  store,
  headers,
  disabled,
}: {
  store: NonNullable<React.ContextType<typeof TreeStateContext>>;
  headers: GameHeaders;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const hasGameEnd = useStore(store, (state) => !!getEffectiveGameEnd(state.root));
  const termination = useStore(store, (state) =>
    getEffectiveTermination({ root: state.root, headers }),
  );
  const setTermination = useStore(store, (state) => state.setTermination);
  if (!hasGameEnd) return null;
  // Literal keys, one per suggestion, so i18n extraction keeps every hint.
  const hints: Record<TerminationSuggestion, string> = {
    Normal: t("GameInfo.TerminationHint.Normal"),
    "Time forfeit": t("GameInfo.TerminationHint.TimeForfeit"),
    Abandoned: t("GameInfo.TerminationHint.Abandoned"),
    Adjudication: t("GameInfo.TerminationHint.Adjudication"),
    "Rules infraction": t("GameInfo.TerminationHint.RulesInfraction"),
    Unterminated: t("GameInfo.TerminationHint.Unterminated"),
  };
  return (
    <Autocomplete
      variant="unstyled"
      w="100%"
      classNames={{ input: classes.input }}
      aria-label={t("GameInfo.Termination")}
      placeholder={t("GameInfo.Termination")}
      readOnly={disabled}
      value={termination ?? ""}
      onChange={setTermination}
      data={TERMINATION_SUGGESTIONS}
      filter={filterTerminationSuggestions}
      // As wide as the hints need and tall enough for all six, so none wraps or scrolls away.
      comboboxProps={{ width: "max-content" }}
      maxDropdownHeight={TERMINATION_DROPDOWN_MAX_HEIGHT}
      renderOption={({ option }) => (
        <div>
          <Text size="sm">{option.value}</Text>
          <Text size="xs" c="dimmed">
            {hints[option.value as TerminationSuggestion]}
          </Text>
        </div>
      )}
    />
  );
}

/** PGN-standard Termination values, offered as suggestions and stored exactly as written. */
const TERMINATION_SUGGESTIONS = [
  "Normal",
  "Time forfeit",
  "Abandoned",
  "Adjudication",
  "Rules infraction",
  "Unterminated",
] as const;
type TerminationSuggestion = (typeof TERMINATION_SUGGESTIONS)[number];
/** Six two-line options at the shared Combobox option padding (411px measured in WebKit) fit;
 *  a shorter window still scrolls the list instead of clipping it. */
const TERMINATION_DROPDOWN_MAX_HEIGHT = 440;

/**
 * Lists every suggestion while the field is empty or holds one of them, so switching from one
 * value to another needs no clearing; otherwise only those containing the typed text.
 */
const filterTerminationSuggestions: OptionsFilter = ({ options, search }) => {
  const query = search.trim().toLowerCase();
  const items = options as ComboboxItem[];
  if (query === "" || items.some((item) => item.value.toLowerCase() === query)) return options;
  return items.filter((item) => item.value.toLowerCase().includes(query));
};

const TIME_CONTROL_PRESETS = [
  "5400+30",
  "40/5400+30:1800+30",
  "40/5400+30:900+30",
  "3600+30",
] as const;

const MIN_TIME_CONTROL_MINUTES = 1;
const MAX_TIME_CONTROL_MINUTES = 600;
const MIN_TIME_CONTROL_INCREMENT = 0;
const MAX_TIME_CONTROL_INCREMENT = 600;
const MIN_TIME_CONTROL_AFTER_MOVE = 1;
const MAX_TIME_CONTROL_AFTER_MOVE = 200;

type CustomTimeControlDraft = {
  minutes: string;
  increment: string;
  afterMove: string;
  addMinutes: string;
};

type CustomTimeControlTouched = {
  minutes: boolean;
  increment: boolean;
};

const EMPTY_CUSTOM_DRAFT: CustomTimeControlDraft = {
  minutes: "",
  increment: "",
  afterMove: "",
  addMinutes: "",
};

const EMPTY_CUSTOM_TOUCHED: CustomTimeControlTouched = {
  minutes: false,
  increment: false,
};

function isPresetTimeControl(tag: string | null | undefined): boolean {
  return !!tag && (TIME_CONTROL_PRESETS as readonly string[]).includes(tag);
}

function isWholeInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function formatCustomTimeControlTag({
  minutes,
  increment,
  afterMove,
  addMinutes,
}: {
  minutes: number;
  increment: number;
  afterMove?: number;
  addMinutes?: number;
}): string {
  const firstPeriod = `${minutes * 60}+${increment}`;
  if (afterMove === undefined || addMinutes === undefined) {
    return firstPeriod;
  }
  return `${afterMove}/${firstPeriod}:${addMinutes * 60}+${increment}`;
}

/**
 * Extracts Custom-form field strings when `tag` matches `S+I` or `N/S+I:T+I` exactly
 * with whole minutes (1-600), shared increment (0-600), and optional moves (1-200).
 */
function parseRepresentableCustom(tag: string): CustomTimeControlDraft | null {
  const fields = parseTimeControl(tag);
  if (!fields) return null;

  if (fields.length === 1) {
    const [first] = fields;
    if (first.moves !== undefined || first.increment === undefined) return null;
    const minutes = first.seconds / 60_000;
    const increment = first.increment / 1000;
    if (
      !isWholeInRange(minutes, MIN_TIME_CONTROL_MINUTES, MAX_TIME_CONTROL_MINUTES) ||
      !isWholeInRange(increment, MIN_TIME_CONTROL_INCREMENT, MAX_TIME_CONTROL_INCREMENT)
    ) {
      return null;
    }
    if (formatCustomTimeControlTag({ minutes, increment }) !== tag) return null;
    return {
      minutes: String(minutes),
      increment: String(increment),
      afterMove: "",
      addMinutes: "",
    };
  }

  if (fields.length === 2) {
    const [first, second] = fields;
    if (
      first.moves === undefined ||
      second.moves !== undefined ||
      first.increment === undefined ||
      second.increment === undefined ||
      first.increment !== second.increment
    ) {
      return null;
    }
    const minutes = first.seconds / 60_000;
    const addMinutes = second.seconds / 60_000;
    const increment = first.increment / 1000;
    if (
      !isWholeInRange(first.moves, MIN_TIME_CONTROL_AFTER_MOVE, MAX_TIME_CONTROL_AFTER_MOVE) ||
      !isWholeInRange(minutes, MIN_TIME_CONTROL_MINUTES, MAX_TIME_CONTROL_MINUTES) ||
      !isWholeInRange(addMinutes, MIN_TIME_CONTROL_MINUTES, MAX_TIME_CONTROL_MINUTES) ||
      !isWholeInRange(increment, MIN_TIME_CONTROL_INCREMENT, MAX_TIME_CONTROL_INCREMENT)
    ) {
      return null;
    }
    if (
      formatCustomTimeControlTag({
        minutes,
        increment,
        afterMove: first.moves,
        addMinutes,
      }) !== tag
    ) {
      return null;
    }
    return {
      minutes: String(minutes),
      increment: String(increment),
      afterMove: String(first.moves),
      addMinutes: String(addMinutes),
    };
  }

  return null;
}

function initialCustomState(headers: GameHeaders): {
  customOpen: boolean;
  draft: CustomTimeControlDraft;
} {
  const hasSideTags = Boolean(headers.white_time_control || headers.black_time_control);
  if (hasSideTags || !headers.time_control || isPresetTimeControl(headers.time_control)) {
    return { customOpen: false, draft: EMPTY_CUSTOM_DRAFT };
  }
  const representable = parseRepresentableCustom(headers.time_control);
  if (!representable) {
    return { customOpen: false, draft: EMPTY_CUSTOM_DRAFT };
  }
  return { customOpen: true, draft: representable };
}

function parseWholeInt(raw: string, min: number, max: number): "empty" | "invalid" | number {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty";
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || !isWholeInRange(parsed, min, max)) return "invalid";
  return parsed;
}

function validateCustomDraft(
  draft: CustomTimeControlDraft,
  touched: CustomTimeControlTouched,
  t: TFunction,
): {
  pgn: string | null;
  errors: {
    minutes?: string;
    increment?: string;
    afterMove?: string;
    addMinutes?: string;
  };
} {
  const minutes = parseWholeInt(draft.minutes, MIN_TIME_CONTROL_MINUTES, MAX_TIME_CONTROL_MINUTES);
  const increment = parseWholeInt(
    draft.increment,
    MIN_TIME_CONTROL_INCREMENT,
    MAX_TIME_CONTROL_INCREMENT,
  );
  const afterMove = parseWholeInt(
    draft.afterMove,
    MIN_TIME_CONTROL_AFTER_MOVE,
    MAX_TIME_CONTROL_AFTER_MOVE,
  );
  const addMinutes = parseWholeInt(
    draft.addMinutes,
    MIN_TIME_CONTROL_MINUTES,
    MAX_TIME_CONTROL_MINUTES,
  );

  const errors = {
    minutes:
      minutes === "invalid" || (minutes === "empty" && touched.minutes)
        ? t("GameInfo.TimeControlRangeError", {
            min: MIN_TIME_CONTROL_MINUTES,
            max: MAX_TIME_CONTROL_MINUTES,
          })
        : undefined,
    increment:
      increment === "invalid" || (increment === "empty" && touched.increment)
        ? t("GameInfo.TimeControlRangeError", {
            min: MIN_TIME_CONTROL_INCREMENT,
            max: MAX_TIME_CONTROL_INCREMENT,
          })
        : undefined,
    afterMove:
      afterMove === "invalid" || (afterMove === "empty" && addMinutes !== "empty")
        ? t("GameInfo.TimeControlRangeError", {
            min: MIN_TIME_CONTROL_AFTER_MOVE,
            max: MAX_TIME_CONTROL_AFTER_MOVE,
          })
        : undefined,
    addMinutes:
      addMinutes === "invalid" || (addMinutes === "empty" && afterMove !== "empty")
        ? t("GameInfo.TimeControlRangeError", {
            min: MIN_TIME_CONTROL_MINUTES,
            max: MAX_TIME_CONTROL_MINUTES,
          })
        : undefined,
  };

  if (typeof minutes !== "number" || typeof increment !== "number") {
    return { pgn: null, errors };
  }
  if (afterMove === "empty" && addMinutes === "empty") {
    return { pgn: formatCustomTimeControlTag({ minutes, increment }), errors };
  }
  if (typeof afterMove === "number" && typeof addMinutes === "number") {
    return {
      pgn: formatCustomTimeControlTag({ minutes, increment, afterMove, addMinutes }),
      errors,
    };
  }
  return { pgn: null, errors };
}

function sideDisplayText(
  headers: GameHeaders,
  side: "white" | "black",
  t: TFunction,
  resolvedOnly: boolean,
): string {
  const resolved = resolveTimeControl(headers, side);
  if (resolved) return formatTimeControl(resolved, t);
  if (resolvedOnly) return t("GameInfo.TimeControlUnknown");
  const sideTag = side === "white" ? headers.white_time_control : headers.black_time_control;
  return sideTag || headers.time_control || t("GameInfo.TimeControlUnknown");
}

function formatTimeControlSummary(
  headers: GameHeaders,
  t: TFunction,
  resolvedOnly: boolean,
): string | null {
  if (resolvedOnly) {
    const whiteResolved = resolveTimeControl(headers, "white");
    const blackResolved = resolveTimeControl(headers, "black");
    if (!whiteResolved && !blackResolved) return null;
  } else if (!headers.time_control && !headers.white_time_control && !headers.black_time_control) {
    return null;
  }

  const whiteText = sideDisplayText(headers, "white", t, resolvedOnly);
  const blackText = sideDisplayText(headers, "black", t, resolvedOnly);
  if (whiteText === blackText) return whiteText;
  return t("GameInfo.TimeControlSides", { white: whiteText, black: blackText });
}

function timeControlTagKey(documentId: number, headers: GameHeaders): string {
  return `${documentId}\0${headers.time_control ?? ""}\0${headers.white_time_control ?? ""}\0${headers.black_time_control ?? ""}`;
}

function TimeControlField({
  store,
  headers,
  readOnly,
}: {
  store: typeof EMPTY_STORE | NonNullable<React.ContextType<typeof TreeStateContext>>;
  headers: GameHeaders;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const documentId = useStore(store, (s) => s.documentId);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const tagKey = timeControlTagKey(documentId, headers);

  const [prevTagKey, setPrevTagKey] = useState(tagKey);
  const [lastWrittenTagKey, setLastWrittenTagKey] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(() => initialCustomState(headers).customOpen);
  const [draft, setDraft] = useState<CustomTimeControlDraft>(
    () => initialCustomState(headers).draft,
  );
  const [touched, setTouched] = useState<CustomTimeControlTouched>(EMPTY_CUSTOM_TOUCHED);

  if (prevTagKey !== tagKey) {
    setPrevTagKey(tagKey);
    // Consume the echo marker once so later undo/redo or external updates to that same tag re-sync.
    setLastWrittenTagKey(null);
    if (lastWrittenTagKey !== tagKey) {
      const initial = initialCustomState(headers);
      setCustomOpen(initial.customOpen);
      setDraft(initial.draft);
      setTouched(EMPTY_CUSTOM_TOUCHED);
    }
  }

  if (readOnly) {
    const readOnlySummary = formatTimeControlSummary(headers, t, true);
    if (!readOnlySummary) return null;
    return (
      <Box className={classes.timeControl}>
        <Text size="xs" c="dimmed" className={classes.timeControlSummary}>
          {t("GameInfo.TimeControlSummary", { value: readOnlySummary })}
        </Text>
      </Box>
    );
  }

  const hasSideTags = Boolean(headers.white_time_control || headers.black_time_control);
  const hasSharedPreset = !hasSideTags && isPresetTimeControl(headers.time_control);
  const selectValue = customOpen
    ? "custom"
    : hasSideTags
      ? null
      : !headers.time_control
        ? "none"
        : hasSharedPreset
          ? headers.time_control
          : null;
  const placeholder = hasSideTags
    ? t("GameInfo.TimeControlPerSide")
    : headers.time_control && !hasSharedPreset
      ? t("GameInfo.TimeControlUnlisted")
      : undefined;

  const commitTimeControl = (nextTag: string | undefined) => {
    const nextHeaders: GameHeaders = {
      ...headers,
      time_control: nextTag,
      white_time_control: undefined,
      black_time_control: undefined,
    };
    const nextTagKey = timeControlTagKey(documentId, nextHeaders);
    setLastWrittenTagKey(nextTagKey);
    setHeaders(nextHeaders);
  };

  const handleSelectChange = (value: string | null) => {
    if (!value) return;
    if (value === "custom") {
      setCustomOpen(true);
      setDraft(EMPTY_CUSTOM_DRAFT);
      setTouched(EMPTY_CUSTOM_TOUCHED);
      return;
    }
    setCustomOpen(false);
    setDraft(EMPTY_CUSTOM_DRAFT);
    setTouched(EMPTY_CUSTOM_TOUCHED);
    commitTimeControl(value === "none" ? undefined : value);
  };

  const handleDraftChange = (field: keyof CustomTimeControlDraft, value: string) => {
    const nextDraft = { ...draft, [field]: value };
    const nextTouched: CustomTimeControlTouched =
      field === "minutes" || field === "increment" ? { ...touched, [field]: true } : touched;
    setDraft(nextDraft);
    setTouched(nextTouched);
    const { pgn } = validateCustomDraft(nextDraft, nextTouched, t);
    if (pgn !== null) {
      commitTimeControl(pgn);
    }
  };

  const { errors } = validateCustomDraft(draft, touched, t);
  const summary = formatTimeControlSummary(headers, t, false);
  const selectData = [
    { value: "none", label: t("GameInfo.TimeControlNone") },
    ...TIME_CONTROL_PRESETS.map((preset) => ({
      value: preset,
      label: formatTimeControl(preset, t),
    })),
    { value: "custom", label: t("GameInfo.TimeControlCustom") },
  ];

  return (
    <Stack gap="xs" className={classes.timeControl}>
      <Select
        size="xs"
        w="100%"
        label={t("GameInfo.TimeControl")}
        allowDeselect={false}
        withCheckIcon
        value={selectValue}
        placeholder={placeholder}
        data={selectData}
        onChange={handleSelectChange}
      />
      {summary && (customOpen || !hasSharedPreset) && (
        <Text size="xs" c="dimmed" className={classes.timeControlSummary}>
          {summary}
        </Text>
      )}
      {customOpen && (
        <div className={classes.timeControlFields}>
          <TextInput
            size="xs"
            inputMode="numeric"
            label={t("GameInfo.TimeControlMinutes")}
            value={draft.minutes}
            error={errors.minutes}
            onChange={(e) => handleDraftChange("minutes", e.currentTarget.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, minutes: true }))}
          />
          <TextInput
            size="xs"
            inputMode="numeric"
            label={t("GameInfo.TimeControlIncrement")}
            value={draft.increment}
            error={errors.increment}
            onChange={(e) => handleDraftChange("increment", e.currentTarget.value)}
            onBlur={() => setTouched((prev) => ({ ...prev, increment: true }))}
          />
          <TextInput
            size="xs"
            inputMode="numeric"
            label={t("GameInfo.TimeControlAfterMove")}
            value={draft.afterMove}
            error={errors.afterMove}
            onChange={(e) => handleDraftChange("afterMove", e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            inputMode="numeric"
            label={t("GameInfo.TimeControlAddMinutes")}
            value={draft.addMinutes}
            error={errors.addMinutes}
            onChange={(e) => handleDraftChange("addMinutes", e.currentTarget.value)}
          />
        </div>
      )}
    </Stack>
  );
}

export default memo(GameInfo);
