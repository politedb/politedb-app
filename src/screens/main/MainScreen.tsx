import { useEffect, useMemo, useState } from "preact/hooks";

import { ConnectionModal } from "src/components/ConnectionModal";
import { ConnectionFormDialog } from "src/components/ConnectionFormDialog";
import { Tab, useScreenStore } from "src/stores/screen";
import {
  ConnectionCreateInput,
  ConnectionProfile,
  profileList,
} from "src/lib/tauri";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { GroupsSection } from "./GroupsSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { filterConnections, groupConnections } from "src/utils/connection";
import type { NavId, ViewMode } from "src/types";
import { OverlayModal } from "src/components/modal/OverlayModal";

export function MainScreen() {
  const { tabs, setTabs, setActiveScreen } = useScreenStore();

  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [selectedConnectionData, setSelectedConnectionData] =
    useState<ConnectionProfile | null>(null);

  const [showNewConnection, setShowNewConnection] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [showDatabaseForm, setShowDatabaseForm] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState<NavId>("connections");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  useEffect(() => {
    void reloadProfiles();
  }, []);

  async function reloadProfiles() {
    try {
      const list = await profileList();
      setConnections(list);
    } catch (err) {
      console.error("Failed to load profiles", err);
    }
  }

  const filtered = useMemo(
    () => filterConnections(connections, searchQuery),
    [connections, searchQuery]
  );
  const groups = useMemo(() => groupConnections(filtered), [filtered]);

  function resetSelection() {
    setSelectedConnectionId(null);
    setSelectedConnectionData(null);
  }

  function handleNewConnection() {
    setShowNewConnection(true);
    setShowDatabaseForm(false);
    resetSelection();
  }

  function handleConnectionSaved() {
    void reloadProfiles();
    setShowNewConnection(false);
    setShowConnectionModal(false);
    setShowDatabaseForm(false);
    resetSelection();
  }

  function handleEditConnection(id: string) {
    const found = connections.find((c) => c.id === id) ?? null;
    if (!found) return;

    setSelectedConnectionId(id);
    setSelectedConnectionData(found);
    setShowConnectionModal(true);
    setShowNewConnection(false);
  }

  function openConnectionInTab(profileId: string) {
    const found = connections.find((c) => c.id === profileId);
    if (!found) return;

    const existing = tabs.find((t) => t.connectionId === profileId);
    if (existing) {
      setActiveScreen(existing.id);
      return;
    }

    const connectionData = found.input as unknown as ConnectionCreateInput;

    const newTab: Tab = {
      id: `tab-${Date.now()}-conn#${profileId}`,
      label: found.label || "Unnamed Connection",
      connectionId: profileId,
      connectionData,
    };

    setTabs([...tabs, newTab]);
    setActiveScreen(newTab.id);
    setShowConnectionModal(false);
  }

  return (
    <div class="h-full flex flex-col bg-neutral-50">
      <div class="flex-1 flex overflow-hidden">
        <LeftNav active={activeNav} onChange={setActiveNav} />

        <div class="flex-1 flex flex-col overflow-hidden">
          <TopBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onNew={handleNewConnection}
            viewMode={viewMode}
            onViewMode={setViewMode}
          />

          <div class="flex-1 overflow-y-auto bg-neutral-100">
            {activeNav === "connections" ? (
              <div class="p-6">
                <GroupsSection
                  groups={groups}
                  viewMode={viewMode}
                  onPickTag={(tag) => setSearchQuery(tag)}
                />

                <ConnectionsSection
                  connections={filtered}
                  selectedId={selectedConnectionId}
                  viewMode={viewMode}
                  searchQuery={searchQuery}
                  onCreate={handleNewConnection}
                  onOpen={openConnectionInTab}
                  onEdit={handleEditConnection}
                />
              </div>
            ) : (
              <div class="p-6">
                <div class="text-center py-12">
                  <p class="text-slate-500">Keychain feature coming soon</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {showNewConnection ? (
          <ConnectionModal
            onSaved={handleConnectionSaved}
            onClose={() => {
              setShowNewConnection(false);
              resetSelection();
              setShowDatabaseForm(false);
            }}
            showDatabaseForm={showDatabaseForm}
            setShowDatabaseForm={setShowDatabaseForm}
          />
        ) : null}

        <OverlayModal
          open={!!(showConnectionModal && selectedConnectionData)}
          onClose={() => {
            setShowConnectionModal(false);
            resetSelection();
          }}
        >
          <ConnectionFormDialog
            onSaved={handleConnectionSaved}
            onClose={() => {
              setShowConnectionModal(false);
              resetSelection();
            }}
            initialData={selectedConnectionData as any}
          />
        </OverlayModal>
      </div>
    </div>
  );
}
