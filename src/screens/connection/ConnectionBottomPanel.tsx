import { useState } from "preact/hooks";
import { QueryHistory } from "./QueryHistory";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";

type Props = {
  activeProfileScreen: string;
  connectionProfileId: string | null;
};

export function ConnectionBottomPanel({
  activeProfileScreen,
  connectionProfileId,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSql, setDraftSql] = useState("");

  return (
    <div class="flex h-full flex-col overflow-hidden bg-white">
      <div class="min-h-0 flex-1 overflow-hidden">
        <QueryHistory
          activeProfileId={activeProfileScreen}
          onSaveAsSnippet={(sql) => {
            setDraftSql(sql);
            setEditorOpen(true);
          }}
        />
      </div>

      <SnippetEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        profileId={connectionProfileId}
        initial={{
          sql: draftSql,
          scope: connectionProfileId ? "profile" : "global",
        }}
        title="Save as snippet"
      />
    </div>
  );
}
