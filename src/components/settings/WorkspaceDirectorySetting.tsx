import { useEffect, useRef, useState } from "react";
import { DirectorySetting } from "./DirectorySetting";

type WorkspaceDirectorySettingProps = {
  load: () => Promise<{ displayName: string }>;
  issue: () => Promise<{ displayName: string }>;
  onSelected?: (name: string) => void;
  onError: (error: unknown) => void;
};

export function WorkspaceDirectorySetting({
  load,
  issue,
  onSelected,
  onError,
}: WorkspaceDirectorySettingProps) {
  const [name, setName] = useState<string | null | undefined>(undefined);
  const initialLoad = useRef(load);
  const generation = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    void initialLoad.current().then(
      (workspace) => {
        if (generation.current === current) setName(workspace.displayName);
      },
      () => {
        if (generation.current === current) setName(null);
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
