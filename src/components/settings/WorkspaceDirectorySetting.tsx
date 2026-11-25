import { useEffect, useRef, useState } from "react";
import { DirectorySetting } from "./DirectorySetting";

type WorkspaceDirectorySettingProps = {
  load: () => Promise<{ displayName: string }>;
  issue: () => Promise<{ displayName: string }>;
  onShowInFolder?: () => Promise<void> | void;
  onSelected?: (name: string) => void;
  onError: (error: unknown) => void;
  /** Forward a rejection from the initial `load` call to `onError` instead of swallowing it. */
  reportLoadError?: boolean;
};

export function WorkspaceDirectorySetting({
  load,
  issue,
  onShowInFolder,
  onSelected,
  onError,
  reportLoadError = false,
}: WorkspaceDirectorySettingProps) {
  const [name, setName] = useState<string | null | undefined>(undefined);
  const initialLoad = useRef(load);
  const reportLoadErrorRef = useRef(reportLoadError);
  const onErrorRef = useRef(onError);
  const generation = useRef(0);
  const mounted = useRef(false);
  reportLoadErrorRef.current = reportLoadError;
  onErrorRef.current = onError;

  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    void initialLoad.current().then(
      (workspace) => {
        if (generation.current === current) setName(workspace.displayName);
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

  return (
    <DirectorySetting
      value={name}
      issueWorkspace={async () => (await issue()).displayName}
      onShowInFolder={onShowInFolder}
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
