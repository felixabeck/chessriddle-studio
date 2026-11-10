import { Box, Group, Select, SimpleGrid, Text } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import cx from "clsx";
import dayjs from "dayjs";
import { memo, useContext, useState } from "react";
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
  const [whiteOpened, setWhiteOpened] = useState(false);
  const [blackOpened, setBlackOpened] = useState(false);

  const event = headers.event === "?" ? "" : headers.event;
  const site = headers.site === "?" ? "" : headers.site;
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
        <Group wrap="nowrap" justify={simplified ? "start" : "center"} w="100%">
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
          {!simplified && headers.round && headers.round !== "?" && (
            <>
              {"-"}
              <Group gap={0} wrap="nowrap">
                <Text c="dimmed" size="sm" mr="xs">
                  {t("GameInfo.Round")}
                </Text>
                <input
                  className={classes.roundInput}
                  placeholder="?"
                  value={headers.round}
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
              placeholder="????.??.??"
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
            <Select
              id="game-result"
              readOnly={disabled}
              allowDeselect={false}
              data={["1-0", "0-1", "1/2-1/2", "*"]}
              value={headers.result}
              variant="unstyled"
              rightSection={null}
              rightSectionWidth={0}
              styles={{
                input: { textAlign: "center" },
              }}
              onChange={(result) =>
                setHeaders({
                  ...headers,
                  result: result as Outcome,
                })
              }
            />
            {contextStore && (
              <TerminationField store={contextStore} headers={headers} disabled={disabled} />
            )}
          </Box>
          <input
            className={cx(classes.textInput, classes.right)}
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
  return (
    <InlineInput
      className={classes.input}
      style={{ width: "100%" }}
      aria-label={t("GameInfo.Termination")}
      placeholder={t("GameInfo.Termination")}
      disabled={disabled}
      value={termination ?? ""}
      onChange={(event) => setTermination(event.currentTarget.value)}
    />
  );
}

export default memo(GameInfo);
