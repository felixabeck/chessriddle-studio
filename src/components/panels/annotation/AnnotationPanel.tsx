import { Collapse, Divider, Group, ScrollArea, Stack, Text, useMantineTheme } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { atom, useAtom } from "jotai";
import { memo, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { ANNOTATION_INFO, type Annotation, isBasicAnnotation, nagGlyphs } from "@/utils/annotation";
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

      <ScrollArea offsetScrollbars pl="sm">
        <AnnotationEditor />
      </ScrollArea>
    </Stack>
  );
}

export default AnnotationPanel;
