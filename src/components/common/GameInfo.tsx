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
  SimpleGrid,
  Text,
  useCombobox,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import cx from "clsx";
import dayjs from "dayjs";
import { memo, useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createStore, useStore } from "zustand";
import type { Outcome } from "@/bindings";
import { lineTitleOf } from "@/components/files/lineTitle";
import {
  getEffectiveGameEnd,
  getEffectiveTermination,
  type GameHeaders,
} from "@/utils/treeReducer";
import FideInfo from "../databases/FideInfo";
import classes from "./GameInfo.module.css";
import { InlineInput } from "./InlineInput";
import { TreeStateContext } from "./TreeStateContext";

const EMPTY_STORE = createStore(() => ({
  setHeaders: () => {},
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

function GameInfo({ headers, simplified }: { headers: GameHeaders; simplified?: boolean }) {
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
  const [whiteOpened, setWhiteOpened] = useState(false);
  const [blackOpened, setBlackOpened] = useState(false);

  const event = headers.event === "?" ? "" : headers.event;
  const site = headers.site === "?" ? "" : headers.site;
  const round = headers.round === "?" ? "" : (headers.round ?? "");
  // The editable full layout always shows Round, so its Event/Round cluster wraps
  // (without the dash separator) instead of pushing BLACK out of view.
  const editableHeader = !simplified && !disabled;
  const sitePlatform = sitePlatformLabel(headers.site);
  // Keep raw White text so spaces survive typing, using the normalized Event fallback only
  // when White is empty.
  const lineName = lineTitleOf({ white: headers.white }).name
    ? headers.white
    : (lineTitleOf(headers).name ?? "");

  return (
    <Box px="md" pt="md">
      <FideInfo opened={whiteOpened} setOpened={setWhiteOpened} name={headers.white} />
      <FideInfo opened={blackOpened} setOpened={setBlackOpened} name={headers.black} />

      <Group w="100%" wrap="nowrap">
        {!simplified && (
          <Text
            component="button"
            type="button"
            c="dimmed"
            tt="uppercase"
            fw="bold"
            className={classes.colorHover}
            onClick={() => setWhiteOpened(true)}
          >
            {t("Fen.White")}
          </Text>
        )}
        <Group
          wrap={editableHeader ? "wrap" : "nowrap"}
          justify={simplified ? "start" : "center"}
          w="100%"
          style={
            editableHeader
              ? { minWidth: 0, rowGap: 0, columnGap: "var(--mantine-spacing-xs)" }
              : undefined
          }
        >
          {simplified ? (
            <>
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
            </>
          ) : (
            <InlineInput
              disabled={disabled}
              value={event}
              aria-label={t("Databases.Game.Event")}
              placeholder={t("GameInfo.UnknownEvent")}
              className={classes.input}
              onChange={(e) => {
                setHeaders({
                  ...headers,
                  event: e.target.value,
                });
              }}
            />
          )}
          {!simplified && (!disabled || round !== "") && (
            <>
              {!editableHeader && "-"}
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
            </>
          )}
        </Group>
        {!simplified && (
          <Text
            component="button"
            type="button"
            c="dimmed"
            tt="uppercase"
            fw="bold"
            ta="right"
            onClick={() => setBlackOpened(true)}
            className={classes.colorHover}
          >
            {t("Fen.Black")}
          </Text>
        )}
      </Group>
      {simplified && (
        <Group gap={4}>
          <Text size="sm">{t("GameInfo.OpeningFor")}</Text>

          <Select
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
        <SimpleGrid cols={3} spacing={0}>
          <input
            className={classes.textInput}
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
          <Group justify="center">
            {sitePlatform !== null ? (
              <a href={headers.site} target="_blank" rel="noreferrer">
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
              w="4.5rem"
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
              className={classes.dateInput}
            />
          </Group>
          <input
            className={cx(classes.textInput, classes.right)}
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
            className={classes.textInput}
            aria-label={t("GameInfo.WhiteElo")}
            placeholder={t("GameInfo.UnknownElo")}
            value={headers.white_elo === 0 ? t("GameInfo.Unrated") : headers.white_elo || ""}
            onChange={(n) => {
              const val = n.currentTarget.value;
              setHeaders({
                ...headers,
                white_elo:
                  val.toLowerCase() === t("GameInfo.Unrated").toLowerCase() || val === "-"
                    ? 0
                    : val === "" || Number.isNaN(Number.parseInt(val))
                      ? undefined
                      : Number.parseInt(val),
              });
            }}
            disabled={disabled}
          />
          <Box>
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
            className={cx(classes.textInput, classes.right)}
            aria-label={t("GameInfo.BlackElo")}
            placeholder={t("GameInfo.UnknownElo")}
            value={headers.black_elo === 0 ? t("GameInfo.Unrated") : headers.black_elo || ""}
            onChange={(n) => {
              const val = n.currentTarget.value;
              setHeaders({
                ...headers,
                black_elo:
                  val.toLowerCase() === t("GameInfo.Unrated").toLowerCase() || val === "-"
                    ? 0
                    : val === "" || Number.isNaN(Number.parseInt(val))
                      ? undefined
                      : Number.parseInt(val),
              });
            }}
            disabled={disabled}
          />
        </SimpleGrid>
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
/** Six two-line options fit; a shorter window still scrolls the list instead of clipping it. */
const TERMINATION_DROPDOWN_MAX_HEIGHT = 400;

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

export default memo(GameInfo);
