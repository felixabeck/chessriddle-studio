import { Button, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useCoachErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import { coachTurnFamily, enginesAtom, fileWorkspaceAtom, referenceDbAtom } from "@/state/atoms";
import {
  coachEngineAtom,
  coachNoticeAcceptedAtom,
  effectiveCoachEngine,
  withCoachNoticeAccepted,
} from "@/state/coach";
import { sendCoachMessage, startNewCoachConversation, stopCoachTurn } from "@/state/coachTurns";
import { currentCollectionDatabase, useCollectionCurrency } from "@/state/linkedCollections";
import { refreshRepertoireIndex } from "@/state/repertoireIndex";
import { useOwnerTabId, useTabAtom } from "@/state/tabScope";
import { AiComposer } from "./AiComposer";
import {
  AiConnectionGate,
  AiModelControls,
  aiSelectionHint,
  useAiModelSelection,
} from "./AiModelSelection";
import { AiNoticeModal } from "./AiNoticeModal";
import { AiTranscriptFrame } from "./AiTranscriptFrame";
import { CoachTranscript } from "./CoachTranscript";
import classes from "./CoachPanel.module.css";

function CoachPanel() {
  const { t } = useTranslation();
  const errors = useCoachErrorMessages();
  const navigate = useNavigate();
  const atoms = useAtomStore();
  const tab = useOwnerTabId();
  const tree = useContext(TreeStateContext)!;
  const session = useStore(tree, (state) => state.coachSession);
  const running = useAtomValue(useTabAtom(coachTurnFamily));

  const modelSelection = useAiModelSelection();
  const { connectionsState, reloadConnections, connections, chosen } = modelSelection;
  const engines = useAtomValue(enginesAtom);
  const engine = effectiveCoachEngine(engines, useAtomValue(coachEngineAtom));
  const [accepted, setAccepted] = useAtom(coachNoticeAcceptedAtom);
  // Opening statistics come from the reference database the explorer uses, as it stands now.
  const selectedReference = useAtomValue(referenceDbAtom);
  const referenceDb = currentCollectionDatabase(
    selectedReference,
    useCollectionCurrency(selectedReference),
  );
  // The repertoire files are indexed while the panel is open, so a question finds them ready.
  const workspace = useAtomValue(fileWorkspaceAtom);
  useEffect(() => {
    void refreshRepertoireIndex(workspace);
  }, [workspace]);

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const messages = session?.messages ?? [];
  const shownTurn = running && !running.orphaned ? running : null;
  // An answer that ended because the sign-in is over: the connection list says so from now on.
  const last = messages.at(-1);
  const signInEnded = last?.role === "coach" && last.error === "signInAgain" ? last.id : null;
  useEffect(() => {
    if (signInEnded) void reloadConnections();
  }, [signInEnded, reloadConnections]);

  const question = draft.trim();
  const ready = chosen.connection && chosen.model && engine;
  const send = (text: string) => {
    if (!chosen.connection || !chosen.model || !engine) return;
    setDraft("");
    void sendCoachMessage(atoms, {
      tab,
      tree,
      question: text,
      connection: chosen.connection.handle,
      model: chosen.model.id,
      effort: chosen.effort,
      engine,
      referenceDb,
    });
    // The context of this question is read already; the index is brought up to date for the next.
    void refreshRepertoireIndex(workspace);
  };
  const submit = () => {
    if (!ready || running || question === "" || !chosen.connection) return;
    // Nothing leaves this computer for a connection before its notice was accepted.
    if (!accepted.includes(chosen.connection.handle)) setNotice(question);
    else send(question);
  };

  // Send stays disabled until both are chosen; this says why, or why the model list is missing.
  const missingChoice = aiSelectionHint(modelSelection, errors, t);

  return (
    <AiConnectionGate
      connectionsState={connectionsState}
      readyConnections={connections}
      errors={errors}
      noConnectionText={t("Coach.NoConnection")}
      onReload={() => void reloadConnections()}
      onOpenSettings={() => void navigate({ to: "/settings" })}
    >
      {engines !== undefined && !engine ? (
        <Stack className={classes.empty} align="flex-start" gap="sm">
          <Text>{t("Coach.NoEngine")}</Text>
          <Button variant="default" onClick={() => void navigate({ to: "/engines" })}>
            {t("Coach.OpenEngines")}
          </Button>
        </Stack>
      ) : (
        <div className={classes.panel}>
          <AiTranscriptFrame
            isEmpty={messages.length === 0 && !shownTurn}
            emptyText={t("Coach.Empty")}
            scrollKey={`${messages.length}:${shownTurn?.text.length ?? 0}:${shownTurn?.checking?.source ?? ""}:${shownTurn?.checking?.line.join(",") ?? ""}`}
          >
            <CoachTranscript messages={messages} running={shownTurn} />
          </AiTranscriptFrame>
          <AiComposer
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={submit}
            onStop={() => stopCoachTurn(atoms, tab)}
            running={Boolean(running)}
            stopping={running?.stopping ?? false}
            canSend={Boolean(ready) && question !== ""}
            placeholder={t("Coach.Ask")}
            ariaLabel={t("Coach.Ask")}
            missingChoice={missingChoice}
            controls={
              <AiModelControls
                state={modelSelection}
                errors={errors}
                newConversationDisabled={messages.length === 0 && !running}
                onNewConversation={() => startNewCoachConversation(atoms, tab, tree)}
              />
            }
          />
          {notice !== null && chosen.connection && (
            <AiNoticeModal
              title={t("Coach.Notice.Title")}
              body={t("Coach.Notice.Body", { provider: chosen.connection.label })}
              acceptLabel={t("Coach.Notice.Accept")}
              onCancel={() => setNotice(null)}
              onAccept={() => {
                if (!chosen.connection) return;
                setAccepted(withCoachNoticeAccepted(accepted, chosen.connection.handle));
                setNotice(null);
                send(notice);
              }}
            />
          )}
        </div>
      )}
    </AiConnectionGate>
  );
}

export default CoachPanel;
