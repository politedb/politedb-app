import { useEffect, useMemo, useState } from "preact/hooks";
import { readTextFile } from "src/lib/system-fs";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/modal/ConnectionModal";
import { ConnectionFormDialog } from "src/components/connection/ConnectionFormDialog";
import { NewConnectionGroupDialog } from "src/components/modal/NewConnectionGroupDialog";
import { ImportConnectionPasswordDialog } from "src/components/modal/ImportConnectionPasswordDialog";
import {
  ImportConnectionSourceDialog,
  type ImportConnectionSource,
} from "src/components/modal/ImportConnectionSourceDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

import { ProfileTab, useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import { useConnectionGroupsStore } from "src/stores/connectionGroups";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { normalizeGroupIds } from "src/stores/connectionGroups";
import { useLicenseStore } from "src/stores/license";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { ConnectionsSection } from "./ConnectionsSection";
import { GroupsSection } from "./GroupsSection";
import { KeychainSection } from "./KeychainSection";
import { ConnectionLogsSection } from "./ConnectionLogsSection";

import { filterConnections } from "src/utils/connection";
import {
  formatExportPasswordError,
  formatSharingImportSuccessMessage,
  isEncryptedExportFile,
  CONNECTION_EXPORT_EXTENSION,
  isSharingExport,
  parseProfileExportMeta,
} from "src/utils/profileSharing";
import {
  formatExternalImportError,
  formatExternalImportSuccessMessage,
  isTablePlusEncryptedPath,
} from "src/utils/profileImport";
import type {
  ConnectionSortMode,
  DatabaseEngine,
  KeychainSortMode,
  NavId,
  ViewMode,
} from "src/types";
import {
  duplicateProfile,
  profileDecryptExport,
  profileImport,
  profileImportExternal,
  profileSaveAndConnect,
  type ConnectionProfile,
  type SaveAndConnectAction,
  type SaveAndConnectInput,
} from "src/lib/tauri";
import { pickOpenFile, showMessage } from "src/lib/system-dialog";
import { trackEvent } from "src/lib/analytics";
import { seedSqliteTemplateDemo } from "src/lib/sqliteTemplateSeed";

export function MainScreen() {
  const { addTab, setActiveProfileScreen } = useScreenStore();

  const {
    loadProfiles,
    saveProfile,

    selectedProfileId,
    selectProfile,

    showNewConnection,
    showEditProfile,
    showDatabaseForm,
    setShowDatabaseForm,

    openNew,
    closeNew,
    openEdit,
    closeEdit,
  } = useProfileStore();

  const profiles = useProfileStore((s) => s.profiles);
  const ensureGroupsLoaded = useConnectionGroupsStore((s) => s.ensureLoaded);
  const groups = useConnectionGroupsStore((s) => s.groups);
  const assignments = useConnectionGroupsStore((s) => s.assignments);
  const createGroup = useConnectionGroupsStore((s) => s.createGroup);
  const deleteGroup = useConnectionGroupsStore((s) => s.deleteGroup);
  const assignGroup = useConnectionGroupsStore((s) => s.assignGroup);
  const assignGroups = useConnectionGroupsStore((s) => s.assignGroups);
  const ensurePinnedLoaded = usePinnedConnectionsStore((s) => s.ensureLoaded);
  const pinnedIds = usePinnedConnectionsStore((s) => s.pinnedIds);
  const loadLicense = useLicenseStore((s) => s.load);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState<NavId>("connections");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [connectionSortMode, setConnectionSortMode] =
    useState<ConnectionSortMode>("created-desc");
  const [keychainSortMode, setKeychainSortMode] =
    useState<KeychainSortMode>("label-asc");
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [keychainNewSignal, setKeychainNewSignal] = useState(0);
  const [keychainEditorOpen, setKeychainEditorOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [importSourceDialogOpen, setImportSourceDialogOpen] = useState(false);
  const [importPasswordDialog, setImportPasswordDialog] = useState<
    | { kind: "tableplus"; path: string }
    | { kind: "politedb"; json: string }
    | null
  >(null);
  const [importPasswordError, setImportPasswordError] = useState<string | null>(
    null
  );
  const [importBusy, setImportBusy] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    ensureGroupsLoaded();
  }, [ensureGroupsLoaded]);

  useEffect(() => {
    ensurePinnedLoaded();
  }, [ensurePinnedLoaded]);

  useEffect(() => {
    void loadLicense();
  }, [loadLicense]);

  const selectedProfile = useMemo(() => {
    if (!selectedProfileId) return undefined;
    return profiles.find((p) => p.id === selectedProfileId);
  }, [profiles, selectedProfileId]);

  const groupIdsByProfile = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const profile of profiles) {
      next[profile.id] = normalizeGroupIds(assignments[profile.id]);
    }
    return next;
  }, [profiles, assignments]);

  const groupedProfiles = useMemo(
    () =>
      groups.map((group) => ({
        group,
        count: profiles.filter((profile) =>
          (groupIdsByProfile[profile.id] ?? []).includes(group.id)
        ).length,
      })),
    [groups, profiles, groupIdsByProfile]
  );

  const filteredProfiles = useMemo(() => {
    const searched = filterConnections(
      profiles,
      searchQuery,
      connectionSortMode,
      pinnedIds
    );
    if (!selectedGroupId) return searched;
    return searched.filter((profile) =>
      (groupIdsByProfile[profile.id] ?? []).includes(selectedGroupId)
    );
  }, [
    profiles,
    searchQuery,
    selectedGroupId,
    groupIdsByProfile,
    connectionSortMode,
    pinnedIds,
  ]);

  useEffect(() => {
    if (!selectedGroupId) return;
    const stillExists = groupedProfiles.some(
      ({ group }) => group.id === selectedGroupId
    );
    if (!stillExists) setSelectedGroupId(undefined);
  }, [groupedProfiles, selectedGroupId]);

  function assignSelectedGroupToProfile(profileId: string) {
    if (showNewConnection && selectedGroupId) {
      assignGroup(profileId, selectedGroupId);
    }
  }

  async function handleProfileSaved(v?: ConnectionProfile) {
    if (!v) return;

    await saveProfile(v);

    assignSelectedGroupToProfile(v.id);
    closeNew();
    closeEdit();
    setShowDatabaseForm(undefined);
    selectProfile(undefined);
  }

  async function handleNewProfile(v?: ConnectionProfile) {
    if (v) assignSelectedGroupToProfile(v.id);

    await loadProfiles();
    closeNew();
    closeEdit();
    setShowDatabaseForm(undefined);
    selectProfile(undefined);
  }

  function openProfileInTab(profileId: string) {
    const found = profiles.find((p) => p.id === profileId);
    if (!found) return;

    const newTab: ProfileTab = {
      id: `tab-${uuid()}`,
      label: found.label || "Unnamed Connection",
      profileId,
      engine: found.engine,
      runtimeConnectionId: undefined,
      profileTags: found.input?.tags ?? [],
    };

    addTab(newTab);
    setActiveProfileScreen(newTab.id);
  }

  async function finishExternalImport(path: string, password?: string) {
    const result = await profileImportExternal(path, password);
    await loadProfiles();
    await showMessage(formatExternalImportSuccessMessage(result), {
      title: "Import complete",
      kind: "info",
    });
  }

  async function finishPoliteDbImport(json: string) {
    const result = await profileImport(json);
    await loadProfiles();

    const meta = parseProfileExportMeta(json);
    const body = isSharingExport(meta)
      ? formatSharingImportSuccessMessage(result, meta)
      : `Imported ${result.created + result.updated} connection(s).\nCreated: ${result.created}\nUpdated: ${result.updated}\n\nProfiles using keychain secrets may need passwords to be re-entered on this device.`;

    await showMessage(body, { title: "Import complete", kind: "info" });
  }

  function handleImportConnections() {
    setImportSourceDialogOpen(true);
  }

  async function handleImportSourceSelected(source: ImportConnectionSource) {
    setImportSourceDialogOpen(false);

    try {
      const path = await pickOpenFile(
        source === "env"
          ? {
              title: "Select environment file",
            }
          : source === "dbeaver"
            ? {
                title: "Select DBeaver data-sources.json",
                filters: [{ name: "DBeaver", extensions: ["json"] }],
              }
            : source === "tableplus"
              ? {
                  title: "Select TablePlus export",
                  filters: [
                    {
                      name: "TablePlus",
                      extensions: ["tableplusconnection", "plist"],
                    },
                  ],
                }
              : {
                  title: "Select PoliteDB export",
                  filters: [
                    {
                      name: "PoliteDB Connection",
                      extensions: [CONNECTION_EXPORT_EXTENSION],
                    },
                  ],
                }
      );
      if (!path || typeof path !== "string") return;

      if (source === "politedb") {
        const json = await readTextFile(path);
        if (isEncryptedExportFile(json)) {
          setImportPasswordError(null);
          setImportPasswordDialog({ kind: "politedb", json });
          return;
        }
        await finishPoliteDbImport(json);
        return;
      }

      if (source === "tableplus" && isTablePlusEncryptedPath(path)) {
        setImportPasswordError(null);
        setImportPasswordDialog({ kind: "tableplus", path });
        return;
      }

      await finishExternalImport(path);
    } catch (err) {
      await showMessage(
        source === "politedb" ? String(err) : formatExternalImportError(err),
        { title: "Import failed", kind: "error" }
      );
    }
  }

  async function handleImportPasswordSubmit(password: string) {
    if (!importPasswordDialog) return;

    const dialog = importPasswordDialog;
    setImportBusy(true);
    setImportPasswordError(null);
    try {
      if (dialog.kind === "politedb") {
        const json = await profileDecryptExport(dialog.json, password);
        setImportPasswordDialog(null);
        await finishPoliteDbImport(json);
      } else {
        const path = dialog.path;
        setImportPasswordDialog(null);
        await finishExternalImport(path, password);
      }
    } catch (err) {
      setImportPasswordError(
        dialog.kind === "politedb"
          ? formatExportPasswordError(err)
          : formatExternalImportError(err)
      );
    } finally {
      setImportBusy(false);
    }
  }

  async function handleCreateGroup(name: string) {
    createGroup(name);
  }

  async function handleUseSqliteTemplate() {
    setTemplateSaving(true);
    try {
      const saved = await profileSaveAndConnect({
        mode: "create",
        engine: "sqlite",
        label: "Hello World",
        tags: ["local"],
        indicator_color: "",
        storeKeychain: false,
        sqlite: {
          path: ":memory:",
          statement_timeout_ms: 60_000,
        },
      } as SaveAndConnectInput & SaveAndConnectAction);

      try {
        await seedSqliteTemplateDemo(saved.connection.id);
      } catch (seedErr) {
        console.warn("[sqlite template] demo seed failed:", seedErr);
      }

      if (selectedGroupId) {
        assignGroup(saved.profile.id, selectedGroupId);
      }

      await loadProfiles();

      const newTab: ProfileTab = {
        id: `tab-${uuid()}`,
        label: saved.profile.label || "Hello World",
        profileId: saved.profile.id,
        engine: saved.profile.engine,
        runtimeConnectionId: saved.connection.id,
        profileTags: saved.profile.input?.tags ?? [],
      };
      addTab(newTab);
      setActiveProfileScreen(newTab.id);
      void import("src/stores/connectionLog").then(
        ({ recordConnectionSessionOpened }) =>
          recordConnectionSessionOpened(newTab)
      );

      trackEvent("connection_sqlite_template_created", { engine: "sqlite" });
    } catch (err) {
      const msg = String(err);
      await showMessage(msg, {
        title: "Could not create template",
        kind: "error",
      });
      trackEvent("connection_sqlite_template_error", {
        error: msg.slice(0, 240),
      });
    } finally {
      setTemplateSaving(false);
    }
  }

  async function handleDuplicate(profileId: string) {
    const found = profiles.find((p) => p.id === profileId);
    if (!found) return;

    try {
      const created = await duplicateProfile(found);
      const groupIds = normalizeGroupIds(assignments[found.id]);
      if (groupIds.length) assignGroups(created.id, groupIds);
      await loadProfiles();

      trackEvent("connection_duplicate_success", {
        engine: created.engine,
      });
    } catch (err) {
      const msg = String(err);
      await showMessage(msg, {
        title: "Could not duplicate connection",
        kind: "error",
      });
      trackEvent("connection_duplicate_error", {
        engine: found.engine,
        error: msg.slice(0, 240),
      });
    }
  }

  function handleTopBarCreate() {
    if (activeNav === "logs") {
      return;
    }
    if (activeNav === "connections") {
      openNew();
      return;
    }
    setKeychainEditorOpen(true);
    setKeychainNewSignal((n) => n + 1);
  }

  function handleDeleteGroup(groupId: string) {
    if (selectedGroupId === groupId) {
      setSelectedGroupId(undefined);
    }
    deleteGroup(groupId);
  }

  return (
    <div class="flex h-full flex-col bg-slate-50 dark:bg-slate-950">
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <LeftNav active={activeNav} onChange={setActiveNav} />

        {/* Main column */}
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* TopBar: pinned */}
          <div class="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <TopBar
              mode={activeNav}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onNewConnection={handleTopBarCreate}
              onNewGroup={() => setNewGroupOpen(true)}
              onImportConnections={handleImportConnections}
              viewMode={viewMode}
              onViewMode={setViewMode}
              connectionSortMode={connectionSortMode}
              onConnectionSortModeChange={setConnectionSortMode}
              keychainSortMode={keychainSortMode}
              onKeychainSortModeChange={setKeychainSortMode}
            />
          </div>

          {/* Content canvas (scroll only here) */}
          <OverlayScrollArea
            className="min-h-0 flex-1 bg-slate-50 dark:bg-slate-950"
            dataScrollRoot
          >
            {activeNav === "logs" ? (
              <ConnectionLogsSection
                searchQuery={searchQuery}
                onShowConnection={(profileId) => {
                  setActiveNav("connections");
                  selectProfile(profileId);
                }}
              />
            ) : activeNav === "connections" ? (
              <div class="px-6 py-5">
                {/* Centered canvas */}
                <div class="mx-auto w-full max-w-400">
                  <GroupsSection
                    groups={groupedProfiles}
                    selectedGroupId={selectedGroupId}
                    onPickGroup={setSelectedGroupId}
                    onDeleteGroup={handleDeleteGroup}
                  />
                  <ConnectionsSection
                    profiles={filteredProfiles}
                    pinnedIds={pinnedIds}
                    selectedId={selectedProfileId}
                    viewMode={viewMode}
                    searchQuery={searchQuery}
                    groups={groups}
                    groupIdsByProfile={groupIdsByProfile}
                    onCreate={openNew}
                    onUseSqliteTemplate={handleUseSqliteTemplate}
                    templateSaving={templateSaving}
                    onAssignGroups={assignGroups}
                    onOpen={(id) => {
                      // optional: keep selection in sync when opening
                      // selectProfile(id);
                      openProfileInTab(id);
                      closeEdit();
                    }}
                    onEdit={(id) => {
                      selectProfile(id);
                      openEdit(id);
                    }}
                    onDuplicate={handleDuplicate}
                    onSelectProfile={selectProfile}
                  />
                </div>
              </div>
            ) : (
              <KeychainSection
                searchQuery={searchQuery}
                viewMode={viewMode}
                sortMode={keychainSortMode}
                newSignal={keychainNewSignal}
                editorOpen={keychainEditorOpen}
                onEditorOpenChange={setKeychainEditorOpen}
              />
            )}
          </OverlayScrollArea>
        </div>

        {/* Modals */}
        {showNewConnection ? (
          <ConnectionModal
            onSaved={handleNewProfile}
            onClose={closeNew}
            showDatabaseForm={showDatabaseForm}
            setShowDatabaseForm={setShowDatabaseForm}
          />
        ) : null}

        <OverlayModal
          open={!!(showEditProfile && selectedProfile)}
          onClose={closeEdit}
        >
          <ConnectionFormDialog
            onSaved={selectedProfile ? handleProfileSaved : handleNewProfile}
            onClose={closeEdit}
            initialData={selectedProfile}
            engine={
              selectedProfile
                ? selectedProfile.engine
                : (showDatabaseForm as DatabaseEngine)
            }
          />
        </OverlayModal>

        <NewConnectionGroupDialog
          open={newGroupOpen}
          onClose={() => setNewGroupOpen(false)}
          onCreate={handleCreateGroup}
        />

        <ImportConnectionSourceDialog
          open={importSourceDialogOpen}
          onClose={() => setImportSourceDialogOpen(false)}
          onSelect={(source) => void handleImportSourceSelected(source)}
        />

        <ImportConnectionPasswordDialog
          open={importPasswordDialog !== null}
          busy={importBusy}
          error={importPasswordError}
          title={
            importPasswordDialog?.kind === "tableplus"
              ? "TablePlus export file"
              : undefined
          }
          description={
            importPasswordDialog?.kind === "tableplus"
              ? "Enter the password you set when exporting connections from TablePlus."
              : undefined
          }
          onClose={() => {
            if (importBusy) return;
            setImportPasswordDialog(null);
            setImportPasswordError(null);
          }}
          onSubmit={(password) => void handleImportPasswordSubmit(password)}
        />
      </div>
    </div>
  );
}
