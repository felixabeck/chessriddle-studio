import { useRouterState } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantContext } from "@/bindings";
import { AiComposer } from "@/components/panels/coach/AiComposer";
import {
  AiConnectionGate,
  AiModelControls,
  aiSelectionHint,
  useAiModelSelection,
} from "@/components/panels/coach/AiModelSelection";
import { AiNoticeModal } from "@/components/panels/coach/AiNoticeModal";
import { AiTranscriptFrame } from "@/components/panels/coach/AiTranscriptFrame";
import coachClasses from "@/components/panels/coach/CoachPanel.module.css";
import { useAssistantErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import {
  assistantConversationAtom,
  assistantNoticeAcceptedAtom,
  assistantRunningTurnAtom,
  withAssistantNoticeAccepted,
} from "@/state/assistant";
import {
  sendAssistantMessage,
  startNewAssistantConversation,
  stopAssistantTurn,
} from "@/state/assistantTurns";
import { currentTabAtom, enginesAtom, referenceDbAtom } from "@/state/atoms";
import { coachEnabledAtom } from "@/state/coach";
import { AssistantTranscript } from "./AssistantTranscript";
import { assistantLinkTargets, assistantSettingsPayload, buildAssistantTargets } from "./targets";
import { useAssistantTargetActions } from "./useAssistantTargetActions";

const MAX_ASSISTANT_ENGINES = 64;
const MAX_ASSISTANT_ENGINE_NAME_CHARS = 128;

/**
 * Sanitizes installed engine names to match the native `plain(name, 128)` bound:
 * strips control characters, trims whitespace, truncates to 128 Unicode characters, drops empties,
 * and caps the count at `MAX_ASSISTANT_ENGINES`. `undefined` stays `undefined` ("not known").
 */
export function sanitizeInstalledEngines(
  engines: readonly { name: string }[] | undefined,
): string[] | undefined {
  if (engines === undefined) return undefined;
  const sanitized: string[] = [];
  for (const engine of engines) {
    const cleaned = Array.from(engine.name.replace(/\p{Cc}/gu, "").trim())
      .slice(0, MAX_ASSISTANT_ENGINE_NAME_CHARS)
      .join("");
    if (cleaned.length > 0) {
      sanitized.push(cleaned);
      if (sanitized.length === MAX_ASSISTANT_ENGINES) break;
    }
  }
  return sanitized;
}

export type AssistantPanelProps = {
  createNewTab: () => void | Promise<unknown>;
  openAccounts: () => void | Promise<unknown>;
  openEngines: () => void | Promise<unknown>;
  openSettings: () => void | Promise<unknown>;
};

function pageKindOf(pathname: string): string {
  if (pathname === "/") return "board";
  if (pathname === "/library" || pathname.startsWith("/databases/")) return "library";
  if (pathname === "/engines") return "engines";
  if (pathname === "/accounts") return "accounts";
  if (pathname === "/settings") return "settings";
  if (pathname === "/guide" || pathname.startsWith("/guide/")) return "guide";
  return "other";
}

function AssistantPanel({
  createNewTab,
  openAccounts,
  openEngines,
  openSettings,
}: AssistantPanelProps) {
  const { t, i18n } = useTranslation();
  const errors = useAssistantErrorMessages();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const atoms = useAtomStore();

  const coachEnabled = useAtomValue(coachEnabledAtom);
  const conversation = useAtomValue(assistantConversationAtom);
  const running = useAtomValue(assistantRunningTurnAtom);
  const engines = useAtomValue(enginesAtom);
  const referenceDb = useAtomValue(referenceDbAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const [accepted, setAccepted] = useAtom(assistantNoticeAcceptedAtom);

  const modelSelection = useAiModelSelection();
  const { connectionsState, reloadConnections, connections, chosen } = modelSelection;

  const buildFacts = useMemo(
    () => ({
      platform: import.meta.env.VITE_PLATFORM as string | undefined,
      coachEnabled,
    }),
    [coachEnabled],
  );
  const targets = useMemo(() => buildAssistantTargets(t, buildFacts), [t, buildFacts]);
  const targetActions = useAssistantTargetActions({
    createNewTab,
    openAccounts,
    openEngines,
    openSettings,
  });

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { messages } = conversation;
  const shownTurn = running && !running.orphaned ? running : null;

  // An answer that ended because the sign-in is over: refresh the connections list.
  const last = messages.at(-1);
  const signInEnded = last?.role === "assistant" && last.error === "signInAgain" ? last.id : null;
  useEffect(() => {
    if (signInEnded) void reloadConnections();
  }, [signInEnded, reloadConnections]);

  const question = draft.trim();
  const ready = Boolean(chosen.connection && chosen.model);

  const send = (text: string) => {
    if (!chosen.connection || !chosen.model) return;
    setDraft("");
    const page = pageKindOf(pathname);
    const context: AssistantContext = {
      page,
      boardTabKind: page === "board" ? (currentTab?.type ?? null) : null,
      language: i18n.language,
      installedEngines: sanitizeInstalledEngines(engines),
      referenceDatabase: referenceDb !== null,
    };
    void sendAssistantMessage(atoms, {
      question: text,
      connection: chosen.connection.handle,
      model: chosen.model.id,
      effort: chosen.effort,
      context,
      settings: assistantSettingsPayload(t, buildFacts),
      targets: assistantLinkTargets(targets),
      t,
    });
  };

  const submit = () => {
    if (!ready || running || question === "" || !chosen.connection) return;
    // Nothing leaves this computer for a connection before the Assistant's own notice is accepted.
    if (!accepted.includes(chosen.connection.handle)) setNotice(question);
    else send(question);
  };

  const missingChoice = aiSelectionHint(modelSelection, errors, t);

  return (
    <AiConnectionGate
      connectionsState={connectionsState}
      readyConnections={connections}
      errors={errors}
      noConnectionText={t("Assistant.NoConnection")}
      onReload={() => void reloadConnections()}
      onOpenSettings={() => void openSettings()}
    >
      <div className={coachClasses.panel}>
        <AiTranscriptFrame
          isEmpty={messages.length === 0 && !shownTurn}
          emptyText={t("Assistant.Empty")}
          scrollKey={`${messages.length}:${shownTurn?.text.length ?? 0}:${shownTurn?.readingTopics?.join(",") ?? ""}`}
        >
          <AssistantTranscript
            messages={messages}
            running={shownTurn}
            targets={targets}
            targetActions={targetActions}
          />
        </AiTranscriptFrame>
        <AiComposer
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          onStop={() => stopAssistantTurn(atoms)}
          running={Boolean(running)}
          stopping={running?.stopping ?? false}
          canSend={ready && question !== ""}
          placeholder={t("Assistant.Ask")}
          ariaLabel={t("Assistant.Ask")}
          missingChoice={missingChoice}
          onRetryModels={modelSelection.retryModels}
          controls={
            <AiModelControls
              state={modelSelection}
              errors={errors}
              newConversationDisabled={messages.length === 0 && !running}
              onNewConversation={() => startNewAssistantConversation(atoms)}
            />
          }
        />
        {notice !== null && chosen.connection && (
          <AiNoticeModal
            title={t("Assistant.Notice.Title")}
            body={t("Assistant.Notice.Body", { provider: chosen.connection.label })}
            acceptLabel={t("Coach.Notice.Accept")}
            onCancel={() => setNotice(null)}
            onAccept={() => {
              if (!chosen.connection) return;
              setAccepted(withAssistantNoticeAccepted(accepted, chosen.connection.handle));
              setNotice(null);
              send(notice);
            }}
          />
        )}
      </div>
    </AiConnectionGate>
  );
}

export default AssistantPanel;
