import { Button, Card, Group, ScrollArea, Stack, Tabs, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantTopic } from "@/bindings";
import shellClasses from "@/components/common/SidebarTabsPage.module.css";
import { useTabCommands } from "@/components/tabs/TabCommands";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { resolveSupportedLocale } from "@/i18n";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import { openPageFromMenu } from "@/routes/-appMenu";
import { coachEnabledAtom } from "@/state/coach";
import { buildAssistantTargets } from "../targets";
import { loadHelpTopics } from "../topics";
import { useAssistantTargetActions } from "../useAssistantTargetActions";
import classes from "./GuidePage.module.css";
import { GuideTopicBody } from "./GuideTopicBody";

const COMPACT_GUIDE_WIDTH_EM = 50;

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

  const topics = loadState.status === "loaded" ? loadState.topics : [];
  const effectiveTopic = topics.find((topic) => topic.id === selectedTopicId) ?? topics[0] ?? null;

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
            if (value) setSelectedTopicId(value);
          }}
          orientation={compact ? "horizontal" : "vertical"}
          flex={1}
          className={shellClasses.tabs}
          classNames={{
            list: `${shellClasses.list} ${classes.topicList}`,
            tab: `${shellClasses.tab} ${classes.topicTab}`,
          }}
          styles={{
            tabLabel: {
              textAlign: "left",
            },
          }}
        >
          <Tabs.List h={compact ? undefined : "100%"} aria-label={t("Guide.Topics")}>
            {topics.map((topic) => (
              <Tabs.Tab key={topic.id} value={topic.id} data-topic-id={topic.id}>
                {topic.title}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Stack flex={1} className={`${shellClasses.content} ${classes.guideContent}`}>
            <ScrollArea className={shellClasses.scroll}>
              <Card withBorder className={`${shellClasses.card} wrap-anywhere`} w="100%">
                {topics.map((topic) => (
                  <Tabs.Panel key={topic.id} value={topic.id} data-topic-panel={topic.id}>
                    <Title order={2} size="h4" className={classes.topicTitle}>
                      {topic.title}
                    </Title>
                    <Text size="sm" c="dimmed" mt={4} mb="md">
                      {topic.summary}
                    </Text>
                    <GuideTopicBody
                      body={topic.body}
                      targets={targets}
                      fallbackTargets={fallbackTargets}
                      targetActions={targetActions}
                    />
                  </Tabs.Panel>
                ))}
              </Card>
            </ScrollArea>
          </Stack>
        </Tabs>
      )}
    </Stack>
  );
}
