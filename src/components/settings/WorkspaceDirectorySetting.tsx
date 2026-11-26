import { useEffect, useRef, useState } from "react";
import { DirectorySetting } from "./DirectorySetting";

type WorkspaceFolderState = {
  displayName: string;
  isDefault?: boolean;
};

type WorkspaceDirectorySettingProps = {
  load: () => Promise<WorkspaceFolderState>;
  issue: () => Promise<WorkspaceFolderState | null>;
  restoreDefault?: () => Promise<WorkspaceFolderState | null>;
  onShowInFolder?: () => Promise<void> | void;
  onSelected?: (name: string) => void;
  onError: (error: unknown) => void;
  /** Forward a rejection from the initial `load` call to `onError` instead of swallowing it. */
  reportLoadError?: boolean;
};

export function WorkspaceDirectorySetting({
  load,
  issue,
  restoreDefault,
  onShowInFolder,
  onSelected,
  onError,
  reportLoadError = false,
}: WorkspaceDirectorySettingProps) {
  const [name, setName] = useState<string | null | undefined>(undefined);
  const [isDefault, setIsDefault] = useState<boolean>(true);
  const loadRef = useRef(load);
  const reportLoadErrorRef = useRef(reportLoadError);
  const onErrorRef = useRef(onError);
  const generation = useRef(0);
  const mounted = useRef(false);
  loadRef.current = load;
  reportLoadErrorRef.current = reportLoadError;
  onErrorRef.current = onError;

  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    void loadRef.current().then(
      (workspace) => {
        if (generation.current === current) {
          setName(workspace.displayName);
          setIsDefault(workspace.isDefault ?? true);
        }
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        setName(null);
        if (reportLoadErrorRef.current) onErrorRef.current(error);
      },
    );
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  async function applySelection(
    action: () => Promise<WorkspaceFolderState | null>,
  ): Promise<string | null> {
    const result = await action();
    if (!result) return null;
    if (mounted.current) {
      generation.current += 1;
      setName(result.displayName);
      setIsDefault(result.isDefault ?? true);
    }
    return result.displayName;
  }

  return (
    <DirectorySetting
      value={name}
      issueWorkspace={() => applySelection(issue)}
      onShowInFolder={onShowInFolder}
      onRestoreDefault={restoreDefault ? () => applySelection(restoreDefault) : undefined}
      showRestoreDefault={Boolean(restoreDefault) && name !== undefined && !isDefault}
      onSelect={(selected) => {
        // The native root is already switched, so consumers hear about it even after unmount.
        onSelected?.(selected);
        if (!mounted.current) return;
        generation.current += 1;
        setName(selected);
      }}
      onError={onError}
    />
  );
}
