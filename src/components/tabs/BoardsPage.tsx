import { WorkspaceTabScope } from "@/state/tabScope";
import BoardTabLayout from "./BoardTabLayout";
import { getTabTreeKey, type Tab } from "@/utils/tabs";
import BoardAnalysis from "../boards/BoardAnalysis";
import BoardGame from "../boards/BoardGame";
import { TreeStateProvider } from "../common/TreeStateContext";
import Puzzles from "../puzzles/Puzzles";
import NewTabHome from "./NewTabHome";
import FileFreshnessGate from "./FileFreshnessGate";
import TreeRecoveryGate from "./TreeRecoveryGate";
import { boardTabId, boardTabPanelId } from "./boardTabDom";
import { useTabCommands } from "./TabCommands";
import TimedRunOwner from "@/components/panels/practice/TimedRunOwner";

import "react-mosaic-component/react-mosaic-component.css";

import "@/styles/react-mosaic.css";
import classes from "./BoardsPage.module.css";

export default function BoardsPage() {
  const { tabs, activeTab, closeTab } = useTabCommands();
  const tab = tabs.find((candidate) => candidate.value === activeTab);

  return (
    <div className={classes.tabsContainer}>
      <TimedRunOwner />
      {tab && (
        <div
          key={tab.value}
          role="tabpanel"
          id={boardTabPanelId(tab.value)}
          aria-labelledby={boardTabId(tab.value)}
          className={classes.panel}
        >
          <TabSwitch tab={tab} closeTab={(tabId) => void closeTab(tabId)} />
        </div>
      )}
    </div>
  );
}

function TabSwitch({ tab, closeTab }: { tab: Tab; closeTab: (tabId: string) => void }) {
  if (tab.type === "new") {
    return (
      <WorkspaceTabScope tabId={tab.value}>
        <NewTabHome id={tab.value} />
      </WorkspaceTabScope>
    );
  }
  return (
    <WorkspaceTabScope tabId={tab.value}>
      <TreeStateProvider id={tab.value} treeKey={getTabTreeKey(tab)}>
        <TreeRecoveryGate tabId={tab.value} treeKey={getTabTreeKey(tab)}>
          {tab.type === "analysis" ? (
            <FileFreshnessGate tab={tab} closeTab={closeTab}>
              <BoardTabLayout arrangeable>
                <BoardAnalysis />
              </BoardTabLayout>
            </FileFreshnessGate>
          ) : (
            <BoardTabLayout>
              {tab.type === "play" ? <BoardGame tabId={tab.value} /> : <Puzzles id={tab.value} />}
            </BoardTabLayout>
          )}
        </TreeRecoveryGate>
      </TreeStateProvider>
    </WorkspaceTabScope>
  );
}
