import { Button, Card, Divider, Group, ScrollArea, Stack, Tabs, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTopic } from "@/bindings";
import {
  GroupedSidebarTabs,
  type GroupedSidebarGroup,
  type GroupedSidebarTab,
} from "@/components/common/GroupedSidebarTabs";
import { emojiOf } from "@/components/common/iconCatalog";
import shellClasses from "@/components/common/SidebarTabsPage.module.css";
import { wrappingButton } from "@/components/common/wrappingButton";
import { useTabCommands } from "@/components/tabs/TabCommands";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { resolveSupportedLocale } from "@/i18n";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import { openPageFromMenu } from "@/routes/-appMenu";
import { coachEnabledAtom } from "@/state/coach";
import { buildAssistantTargets } from "../targets";
import {
  HELP_TOPIC_GROUPS,
  loadHelpTopics,
  type HelpTopicAccent,
  type HelpTopicGroupId,
} from "../topics";
import { useAssistantTargetActions } from "../useAssistantTargetActions";
import classes from "./GuidePage.module.css";
import { GuideTopicBody } from "./GuideTopicBody";

const COMPACT_GUIDE_WIDTH_EM = 50;

const TOPIC_VISUALS = new Map<string, { emoji: string; accent: HelpTopicAccent }>(
  HELP_TOPIC_GROUPS.flatMap((group) =>
    group.topics.map((topic) => [topic.id, { emoji: topic.emoji, accent: group.accent }] as const),
  ),
);

function getTopicVisuals(topicId: string): { emoji: string; accentVar: string } {
  const entry = TOPIC_VISUALS.get(topicId);
  const accent: HelpTopicAccent = entry?.accent ?? "chart-6";
  return {
    emoji: entry?.emoji ?? emojiOf("guideTopic"),
    accentVar: `var(--cf-${accent})`,
  };
}

function groupTitle(t: (key: string) => string, groupId: HelpTopicGroupId): string {
  switch (groupId) {
    case "basics":
      return t("Guide.Group.Basics");
    case "databases":
      return t("Guide.Group.Databases");
    case "training":
      return t("Guide.Group.Training");
    case "accounts":
      return t("Guide.Group.Accounts");
    case "app":
      return t("Guide.Group.App");
  }
}

type GuideLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; topics: AssistantTopic[] };

/**
 * In-app Guide page available to every user from the Help menu without requiring an AI connection.
 * Loads the shared help topics for the active interface language and renders each topic with
 * closed-registry navigation links.
 */
export default function GuidePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { newTab } = useTabCommands();
  const compact = useScaledMaxWidth(COMPACT_GUIDE_WIDTH_EM);
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const resolvedLocale = resolveSupportedLocale(i18n.resolvedLanguage || i18n.language);

  const tRef = useRef(t);
  tRef.current = t;
  const requestCounterRef = useRef(0);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<GuideLoadState>({ status: "loading" });

  useEffect(() => {
    const requestId = ++requestCounterRef.current;
    let active = true;
    const isCurrent = () => active && requestCounterRef.current === requestId;

    setLoadState({ status: "loading" });

    void loadHelpTopics((key) => tRef.current(key), resolvedLocale).then(
      (topics) => {
        if (!isCurrent()) return;
        setLoadState({
          status: "loaded",
          topics,
        });
      },
      (cause: unknown) => {
        if (!isCurrent()) return;
        const primaryFailure = safeFailureContext(cause);
        void logFailureSafely(
          `Guide help topics failed to load for ${resolvedLocale}: ${primaryFailure.message}`,
          { operation: "guide-topics-load", item: resolvedLocale, primaryFailure },
          "guide-topics-load",
        );
        setLoadState({ status: "error" });
      },
    );

    return () => {
      active = false;
    };
  }, [resolvedLocale, retryCount]);

  const platform = import.meta.env.VITE_PLATFORM as string | undefined;
  const targets = useMemo(
    () => buildAssistantTargets(t, { platform, coachEnabled }),
    [coachEnabled, platform, t],
  );
  const fallbackTargets = useMemo(
    () => buildAssistantTargets(t, { platform, coachEnabled: true }),
    [platform, t],
  );

  const openAccounts = useCallback(
    () => openPageFromMenu({ navigate, to: "/accounts" }),
    [navigate],
  );
  const openEngines = useCallback(() => openPageFromMenu({ navigate, to: "/engines" }), [navigate]);
  const openSettings = useCallback(
    () => openPageFromMenu({ navigate, to: "/settings" }),
    [navigate],
  );
  const targetActions = useAssistantTargetActions({
    createNewTab: newTab,
    openAccounts,
    openEngines,
    openSettings,
  });

  const topics = useMemo(
    () => (loadState.status === "loaded" ? loadState.topics : []),
    [loadState],
  );
  const effectiveTopic = topics.find((topic) => topic.id === selectedTopicId) ?? topics[0] ?? null;

  const groupedTopics = useMemo(() => {
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    return HELP_TOPIC_GROUPS.map((group) => ({
      group,
      items: group.topics
        .map(({ id }) => byId.get(id))
        .filter((topic): topic is AssistantTopic => topic !== undefined),
    })).filter(({ items }) => items.length > 0);
  }, [topics]);

  const ungroupedTopics = useMemo(
    () => topics.filter((topic) => !TOPIC_VISUALS.has(topic.id)),
    [topics],
  );

  const selectTopic = useCallback((topicId: string) => {
    setSelectedTopicId(topicId);
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = 0;
    }
  }, []);

  const sidebarGroups = useMemo((): GroupedSidebarGroup[] => {
    return groupedTopics.map(({ group, items }) => ({
      id: group.id,
      title: groupTitle(t, group.id),
      headingProps: { "data-guide-group": group.id },
      tabs: items.map((topic) => {
        const { emoji, accentVar } = getTopicVisuals(topic.id);
        return {
          value: topic.id,
          label: topic.title,
          emoji,
          accent: accentVar,
          tabProps: { "data-topic-id": topic.id },
        } satisfies GroupedSidebarTab;
      }),
    }));
  }, [groupedTopics, t]);

  const extraTabs = useMemo(
    (): GroupedSidebarTab[] =>
      ungroupedTopics.map((topic) => {
        const { emoji, accentVar } = getTopicVisuals(topic.id);
        return {
          value: topic.id,
          label: topic.title,
          emoji,
          accent: accentVar,
          tabProps: { "data-topic-id": topic.id },
        };
      }),
    [ungroupedTopics],
  );

  return (
    <Stack h="100%" gap={0} data-compact={compact || undefined}>
      <Group px="md" pt="md" pb="sm" className={shellClasses.headerRow}>
        <Title order={1} size="h3" className="wrap-anywhere" miw={0}>
          {t("Guide.Title")}
        </Title>
      </Group>

      {loadState.status === "loading" && (
        <Text c="dimmed" px="md" py="sm">
          {t("Common.Loading")}
        </Text>
      )}

      {loadState.status === "error" && (
        <Stack px="md" py="sm" align="flex-start" gap="sm" role="alert">
          <Text c="danger">{t("Guide.LoadFailed")}</Text>
          <Button variant="default" onClick={() => setRetryCount((count) => count + 1)}>
            {t("Common.Retry")}
          </Button>
        </Stack>
      )}

      {loadState.status === "loaded" && effectiveTopic && (
        <Tabs
          value={effectiveTopic.id}
          onChange={(value) => {
            if (value) selectTopic(value);
          }}
          orientation={compact ? "horizontal" : "vertical"}
          flex={1}
          className={shellClasses.tabs}
          classNames={{
            list: shellClasses.list,
            tab: shellClasses.tab,
          }}
          styles={{
            tabLabel: {
              textAlign: "left",
            },
          }}
        >
          <GroupedSidebarTabs
            groups={sidebarGroups}
            extraTabs={extraTabs}
            compact={compact}
            aria-label={t("Guide.Topics")}
          />
          <Stack flex={1} className={`${shellClasses.content} ${classes.guideContent}`}>
            <ScrollArea className={shellClasses.scroll} viewportRef={scrollViewportRef}>
              <Card
                withBorder
                className={`${shellClasses.card} ${classes.guideCard} wrap-anywhere`}
                w="100%"
              >
                {topics.map((topic, index) => {
                  const { emoji } = getTopicVisuals(topic.id);
                  const nextTopic = index < topics.length - 1 ? topics[index + 1] : null;
                  return (
                    <Tabs.Panel key={topic.id} value={topic.id} data-topic-panel={topic.id}>
                      <div className={classes.panelInner}>
                        <Group gap="md" align="center" wrap="nowrap">
                          <span aria-hidden="true" className={classes.topicEmoji}>
                            {emoji}
                          </span>
                          <Title order={2} size="h4" className={classes.topicTitle}>
                            {topic.title}
                          </Title>
                        </Group>
                        <Text size="md" c="dimmed" mt="sm" className={classes.topicSummary}>
                          {topic.summary}
                        </Text>
                        <Divider my="md" color="var(--cf-border)" />
                        <GuideTopicBody
                          body={topic.body}
                          targets={targets}
                          fallbackTargets={fallbackTargets}
                          targetActions={targetActions}
                        />
                        {nextTopic && (
                          <div className={classes.nextRow}>
                            <Button
                              variant="light"
                              rightSection={
                                <ArrowRight
                                  size="1rem"
                                  strokeWidth={2}
                                  aria-hidden="true"
                                  className={classes.nextArrow}
                                />
                              }
                              styles={wrappingButton}
                              onClick={() => selectTopic(nextTopic.id)}
                            >
                              {t("Guide.Next", { topic: nextTopic.title })}
                            </Button>
                          </div>
                        )}
                      </div>
                    </Tabs.Panel>
                  );
                })}
              </Card>
            </ScrollArea>
          </Stack>
        </Tabs>
      )}
    </Stack>
  );
}
