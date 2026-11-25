import { Button, Stack, Text } from "@mantine/core";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { FileMetadata } from "@/components/files/file";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { libraryFileMetadata, type LibraryRow } from "@/components/library/libraryData";
import { deckCountable, dueTotalLabel } from "@/components/library/useLibraryDueCounts";
import AppPopover from "@/components/common/AppPopover";
import {
  deckAtomFamily,
  practiceNewPerSessionAtom,
  practiceTrainMinutesAtom,
  timedRunLaunchAtom,
  type TimedRunChapter,
} from "@/state/atoms";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import { prepareTimedRunWeights } from "./prepareTimedRun";
import { collectRunCandidates } from "./runPlanner";
import TrainMinutesControl from "./TrainMinutesControl";
import { useReferenceResolution } from "./useReferenceResolution";

type FileRow = Extract<LibraryRow, { kind: "file" }>;

export type TrainOpeningsDue = {
  rows: { file: FileRow; count: number | null; failed: boolean }[];
  total: number;
  incomplete: boolean;
  inventoryFailed: boolean;
  discoveryPending: boolean;
  decks: ReadonlyMap<string, ReadonlyMap<number, PracticeDeckValue>>;
};

export function trainOpeningsHasEligible(
  decks: TrainOpeningsDue["decks"],
  now: Date,
  newPerSession: number,
): boolean {
  for (const [file, chapters] of decks) {
    for (const [game, deck] of chapters) {
      if (!deckCountable(deck)) continue;
      if (
        collectRunCandidates([{ file, game, positions: deck.positions }], now, newPerSession)
          .length > 0
      )
        return true;
    }
  }
  return false;
}

export default function TrainOpeningsPopover({
  newTabId,
  due,
  listingInFlight,
  discoveryFailed,
  trigger,
}: {
  newTabId: string;
  due: TrainOpeningsDue;
  listingInFlight: boolean;
  discoveryFailed: boolean;
  trigger: ReactNode;
}) {
  const { t } = useTranslation();
  const jotaiStore = useStore();
  const minutes = useAtomValue(practiceTrainMinutesAtom);
  const newPerSession = useAtomValue(practiceNewPerSessionAtom);
  const setLaunch = useSetAtom(timedRunLaunchAtom);
  const resolution = useReferenceResolution();
  const [opened, setOpened] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const prepRef = useRef<AbortController | null>(null);

  const abortPrep = () => {
    prepRef.current?.abort();
    prepRef.current = null;
    setPreparing(false);
  };

  const setOpen = (next: boolean) => {
    setOpened(next);
    if (!next) abortPrep();
  };

  useEffect(() => () => abortPrep(), []);

  const inFlight = listingInFlight || due.discoveryPending;
  const hasEligible = trainOpeningsHasEligible(due.decks, new Date(), newPerSession);
  const nothingDue = !inFlight && !hasEligible;
  const startDisabled = inFlight || nothingDue || preparing;
  const incomplete = due.incomplete || discoveryFailed;
  const noReference = !resolution.selectedReference;
  const referenceUnusable = !!resolution.selectedReference && !resolution.referenceDb;

  const start = async () => {
    if (startDisabled) return;
    abortPrep();
    const controller = new AbortController();
    prepRef.current = controller;
    setPreparing(true);
    const errorTitle = t("Common.Error");
    try {
      const rowsByKey = new Map(due.rows.map((row) => [row.file.key, row.file]));
      const chapters: {
        file: string;
        game: number;
        positions: PracticeDeckValue["positions"];
        handle: FileMetadata["handle"];
        metadata: FileMetadata;
      }[] = [];
      for (const [file, games] of due.decks) {
        const row = rowsByKey.get(file);
        if (!row) continue;
        const metadata = libraryFileMetadata(row.file);
        for (const [game, deck] of games) {
          if (!deckCountable(deck)) continue;
          chapters.push({
            file,
            game,
            positions: deck.positions,
            handle: metadata.handle,
            metadata,
          });
        }
      }

      if (resolution.referenceDb) {
        const prepared = await prepareTimedRunWeights({
          chapters,
          referenceDb: resolution.referenceDb,
          signal: controller.signal,
          deps: {
            writeDeck: async (file, game, positions) => {
              await jotaiStore.set(deckAtomFamily({ file, game }), {
                type: "sync",
                positions,
              });
            },
          },
        });
        if (prepared.status === "aborted" || controller.signal.aborted) return;
        if (prepared.statsFailed) {
          notifyUnlessCancelled(errorTitle, prepared.statsError ?? new Error(errorTitle));
        }
      } else if (controller.signal.aborted) {
        return;
      }

      const snapshotChapters: TimedRunChapter[] = [];
      const snapshotSources: {
        file: string;
        game: number;
        positions: PracticeDeckValue["positions"];
      }[] = [];
      for (const chapter of chapters) {
        const deck = jotaiStore.get(deckAtomFamily({ file: chapter.file, game: chapter.game }));
        if (!deckCountable(deck)) continue;
        snapshotSources.push({
          file: chapter.file,
          game: chapter.game,
          positions: deck.positions,
        });
        snapshotChapters.push({
          file: chapter.file,
          game: chapter.game,
          metadata: chapter.metadata,
        });
      }
      if (controller.signal.aborted) return;
      const candidates = collectRunCandidates(snapshotSources, new Date(), newPerSession);
      setLaunch({
        id: crypto.randomUUID(),
        deadline: Date.now() + minutes * 60 * 1000,
        startedAt: Date.now(),
        newTabId,
        candidates,
        chapters: snapshotChapters,
      });
      setOpened(false);
    } catch (error) {
      if (!controller.signal.aborted) notifyUnlessCancelled(errorTitle, error);
    } finally {
      if (prepRef.current === controller) {
        prepRef.current = null;
        setPreparing(false);
      }
    }
  };

  return (
    <AppPopover
      opened={opened}
      onChange={setOpen}
      position="bottom-start"
      shadow="md"
      width="22rem"
    >
      <AppPopover.Target>
        {isValidElement(trigger)
          ? cloneElement(trigger as ReactElement<{ onClick?: () => void }>, {
              onClick: () => setOpen(!opened),
            })
          : trigger}
      </AppPopover.Target>
      <AppPopover.Dropdown>
        <Stack gap="sm" data-train-openings>
          <TrainMinutesControl fullWidth />
          <Text size="sm" c="dimmed">
            {dueTotalLabel(t, due.total, due.rows.filter((row) => row.count !== null).length)}
            {incomplete && <> · {t("Home.DuePractice.Incomplete")}</>}
          </Text>
          {nothingDue && (
            <Text size="sm" c="dimmed">
              {t("Home.DuePractice.NothingDue")}
            </Text>
          )}
          {noReference && (
            <Text size="sm" c="dimmed">
              {t("Home.TrainOpenings.NoReference")}
            </Text>
          )}
          {referenceUnusable && (
            <Text size="sm" c="dimmed">
              {t("Collections.Unavailable")}
            </Text>
          )}
          <Button
            fullWidth
            loading={preparing}
            disabled={startDisabled}
            onClick={() => void start()}
          >
            {t("Home.TrainOpenings.Start")}
          </Button>
        </Stack>
      </AppPopover.Dropdown>
    </AppPopover>
  );
}
