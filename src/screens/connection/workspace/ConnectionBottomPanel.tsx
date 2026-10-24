import { useState } from "preact/hooks";
import { QueryHistory } from "../sql/QueryHistory";
import { SnippetEditorDialog } from "src/components/modal/SnippetEditorDialog";

type Props = {
  activeProfileScreen: string;
  connectionProfileId: string | null;
  onInsertSql?: (sql: string) => void | Promise<void>;
};

export function ConnectionBottomPanel({
  activeProfileScreen,
  connectionProfileId,
  onInsertSql,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSql, setDraftSql] = useState("");

  return (
    <div class="flex h-full flex-col overflow-hidden bg-white">
      <div class="min-h-0 flex-1 overflow-hidden">
        <QueryHistory
          activeProfileId={activeProfileScreen}
          onInsertSql={onInsertSql}
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
