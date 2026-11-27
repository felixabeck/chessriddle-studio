import {
  Box,
  Collapse,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  useMantineTheme,
} from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { atom, useAtom } from "jotai";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { ANNOTATION_INFO, type Annotation, isBasicAnnotation, nagGlyphs } from "@/utils/annotation";
import { formatClockInput, parseClockInput } from "@/utils/clock";
import { isPlainEscape } from "@/utils/keyboardOwnership";
import { getNodeAtPath } from "@/utils/treeReducer";
import AnnotationEditor from "./AnnotationEditor";

const SymbolButton = memo(function SymbolButton({
  curAnnotations,
  annotation,
}: {
  curAnnotations: Annotation[];
  annotation: Annotation;
}) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const setAnnotation = useStore(store, (s) => s.setAnnotation);
  const atRoot = useStore(store, (s) => s.position.length === 0);
  const { translationKey, name, color } = ANNOTATION_INFO[annotation];
  const isActive = curAnnotations.includes(annotation);
  const theme = useMantineTheme();
  return (
    <IconAction
      label={translationKey ? t(`Annotate.${translationKey}`) : name}
      onClick={() => setAnnotation(annotation)}
      variant={isActive ? "filled" : "default"}
      pressed={isActive}
      disabled={atRoot}
      color={isBasicAnnotation(annotation) ? color : theme.primaryColor}
    >
      <Text>{annotation}</Text>
    </IconAction>
  );
});

const showMoreSymbolsAtom = atom(false);

const BASIC = ["!!", "!", "!?", "?!", "?", "??"] as const;
const ADVANTAGE = ["+-", "±", "⩲", "=", "∞", "⩱", "∓", "-+"] as const;
const EXTRA = ["N", "↑↑", "↑", "→", "⇆", "=∞", "⊕", "∆", "□", "⨀", "⊗"] as const;

function ClockInput() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const documentId = useStore(store, (s) => s.documentId);
  const setClock = useStore(store, (s) => s.setClock);

  const atRoot = position.length === 0;
  const currentNode = getNodeAtPath(root, position);
  const storedValue =
    atRoot || currentNode.clock === undefined ? "" : formatClockInput(currentNode.clock);
  const positionKey = position.join();
  const syncKey = `${documentId}:${positionKey}:${currentNode.fen}:${storedValue}`;

  const [prevSyncKey, setPrevSyncKey] = useState(syncKey);
  const [draft, setDraft] = useState(storedValue);
  const [error, setError] = useState(false);

  if (prevSyncKey !== syncKey) {
    setPrevSyncKey(syncKey);
    setDraft(storedValue);
    setError(false);
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const focusDestinationRef = useRef<string | null>(null);
  const revertedByEscapeRef = useRef(false);

  useEffect(() => {
    if (focusDestinationRef.current !== positionKey) return;
    focusDestinationRef.current = null;
    const input = inputRef.current;
    if (!input || input.disabled) return;
    input.focus();
    input.select();
  }, [positionKey]);

  const commitDraft = (): boolean => {
    if (atRoot) return true;
    if (draft === storedValue) {
      setError(false);
      return true;
    }
    const parsed = parseClockInput(draft);
    if (parsed.kind === "invalid") {
      setError(true);
      return false;
    }
    if (parsed.kind === "empty") {
      if (currentNode.clock !== undefined) setClock(undefined);
      setDraft("");
      setError(false);
      return true;
    }
    setClock(parsed.seconds);
    setDraft(formatClockInput(parsed.seconds));
    setError(false);
    return true;
  };

  const commitAndNavigate = (direction: "forward" | "backward") => {
    if (!commitDraft()) return;
    const state = store.getState();
    // Guard against transposition fallback on a final repeated position and against stepping to root.
    if (direction === "forward" && state.currentNode().children.length === 0) return;
    if (direction === "backward" && state.position.length <= 1) return;
    const previous = state.position.join();
    if (direction === "forward") state.goToNext();
    else state.goToPrevious();
    const destination = store.getState().position.join();
    if (destination !== previous) {
      focusDestinationRef.current = destination;
    }
  };

  return (
    <Box px="sm" pb="xs">
      <TextInput
        ref={inputRef}
        size="xs"
        label={t("Board.Annotate.Clock")}
        disabled={atRoot}
        value={draft}
        error={error ? t("Board.Annotate.InvalidClock") : undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          if (error) setError(false);
        }}
        onBlur={() => {
          if (revertedByEscapeRef.current) {
            revertedByEscapeRef.current = false;
            return;
          }
          if (!commitDraft()) {
            setDraft(storedValue);
            setError(false);
          }
        }}
        onKeyDown={(event) => {
          if (isPlainEscape(event.nativeEvent)) {
            event.preventDefault();
            revertedByEscapeRef.current = true;
            setDraft(storedValue);
            setError(false);
            event.currentTarget.blur();
            return;
          }
          if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commitAndNavigate("forward");
          } else if (event.key === "Tab") {
            event.preventDefault();
            commitAndNavigate(event.shiftKey ? "backward" : "forward");
          }
        }}
      />
    </Box>
  );
}

function AnnotationPanel() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const currentNode = getNodeAtPath(root, position);
  const annotations = nagGlyphs(currentNode.nags);
  const [showMoreSymbols, setShowMoreSymbols] = useAtom(showMoreSymbolsAtom);

  return (
    <Stack h="100%" gap={0} py="sm">
      <Stack gap={0}>
        <Group grow px="sm">
          {BASIC.map((annotation) => {
            return (
              <SymbolButton key={annotation} curAnnotations={annotations} annotation={annotation} />
            );
          })}
        </Group>
        {/* The button sits between two rules, not inside a separator's label (nested-interactive). */}
        <Group gap="xs" wrap="nowrap" align="center">
          <Divider flex={1} />
          <IconAction
            label={showMoreSymbols ? t("Annotate.ShowLess") : t("Annotate.ShowMore")}
            pressed={showMoreSymbols}
            onClick={() => setShowMoreSymbols(!showMoreSymbols)}
            color="dimmed"
            style={{
              transition: "transform 0.2s",
              transform: showMoreSymbols ? "rotate(180deg)" : "rotate(0deg)",
            }}
          >
            <ChevronDown size="1rem" />
          </IconAction>
          <Divider flex={1} />
        </Group>
      </Stack>

      <Collapse in={showMoreSymbols} px="sm">
        <Stack mb="md">
          <Group grow>
            {ADVANTAGE.map((annotation) => (
              <SymbolButton key={annotation} curAnnotations={annotations} annotation={annotation} />
            ))}
          </Group>
          <Group grow>
            {EXTRA.map((annotation) => (
              <SymbolButton key={annotation} curAnnotations={annotations} annotation={annotation} />
            ))}
          </Group>
        </Stack>
      </Collapse>

      <ClockInput />

      <ScrollArea offsetScrollbars pl="sm">
        <AnnotationEditor />
      </ScrollArea>
    </Stack>
  );
}

export default AnnotationPanel;
