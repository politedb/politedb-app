import { JSX } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { ConnectionFormDialog } from "../components/ConnectionFormDialog";
import { Edit, Grid, Console, List, Search, Database, Key, Plus } from "../components/icons";
import { ConnectionModal } from "../components/ConnectionModal";
import { ReactNode } from "preact/compat";
import { Tab, useScreenStore } from "../stores/screen";
import { Button } from "../components/common/Button";

type Connection = {
  id: string;
  name: string;
  tag: string;
  statusColor: string;
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  storeKeychain?: boolean;
  sslMode?: string;
  sslKey?: string;
  sslCert?: string;
  sslCA?: string;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshKeyPath?: string;
  connected?: boolean;
};

type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { id: "connections", label: "Connections", icon: <Database className="size-4" /> },
  { id: "keychain", label: "Keychain", icon: <Key className="size-4" /> },
];

export function MainScreen() {
  const { tabs, setTabs, setActiveScreen } = useScreenStore();

  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [showDatabaseForm, setShowDatabaseForm] = useState(false);
  const [selectedConnectionData, setSelectedConnectionData] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState("connections");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  useEffect(() => {
    loadConnections();
  }, []);

  function loadConnections() {
    const keys = Object.keys(localStorage);
    const connKeys = keys.filter((k) => k.startsWith("politedb:conn:"));
    const loaded: Connection[] = [];

    for (const key of connKeys) {
      try {
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          loaded.push({
            id: key,
            name: parsed.name || "Unnamed",
            tag: parsed.tag || "local",
            statusColor: parsed.statusColor || "",
            host: parsed.host || "",
            port: parsed.port || 5432,
            database: parsed.database || "",
            user: parsed.user,
            password: parsed.password.value,
            storeKeychain: parsed.storeKeychain,
            sslMode: parsed.sslMode,
            sslKey: parsed.sslKey,
            sslCert: parsed.sslCert,
            sslCA: parsed.sslCA,
            sshEnabled: parsed.sshEnabled,
            sshHost: parsed.sshHost,
            sshPort: parsed.sshPort,
            sshUser: parsed.sshUser,
            sshKeyPath: parsed.sshKeyPath,
            connected: false,
          });
        }
      } catch (e) {
        console.error("Failed to parse connection:", key, e);
      }
    }

    setConnections(loaded);
  }

  const filteredConnections = useMemo(() => {
    if (!searchQuery.trim()) return connections;

    const query = searchQuery.toLowerCase();
    return connections.filter(
      (conn) =>
        conn.name.toLowerCase().includes(query) ||
        conn.host.toLowerCase().includes(query) ||
        conn.database.toLowerCase().includes(query) ||
        conn.tag.toLowerCase().includes(query) ||
        `${conn.user}@${conn.host}`.toLowerCase().includes(query)
    );
  }, [connections, searchQuery]);

  const groupedConnections = useMemo(() => {
    const grouped = new Map<string, Connection[]>();
    for (const conn of filteredConnections) {
      const tag = conn.tag || "local";
      if (!grouped.has(tag)) {
        grouped.set(tag, []);
      }
      grouped.get(tag)!.push(conn);
    }

    return Array.from(grouped.entries())
      .map(([tag, conns]) => ({
        tag,
        connections: conns.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [filteredConnections]);

  function handleNewConnection() {
    setShowNewConnection(true);
    setSelectedConnectionId(null);
    setSelectedConnectionData(null);
    setShowDatabaseForm(false);
  }

  function handleConnectionSaved() {
    loadConnections();
    setShowNewConnection(false);
    setShowConnectionModal(false);
    setShowDatabaseForm(false);
    setSelectedConnectionId(null);
    setSelectedConnectionData(null);
  }

  function handleSelectConnection(connId: string) {
    setSelectedConnectionId(connId);
    setShowNewConnection(false);

    try {
      const data = localStorage.getItem(connId);
      if (data) {
        const parsed = JSON.parse(data);
        setSelectedConnectionData({ ...parsed, password: parsed.password.value, key: connId });
        setShowConnectionModal(true);
      }
    } catch (e) {
      console.error("Failed to load connection data:", e);
      setSelectedConnectionData(null);
    }
  }

  function openConnectionInTab(connectionId: string) {
    // Check if tab already exists
    const existingTab = tabs.find((tab) => tab.connectionId === connectionId);
    if (existingTab) {
      setActiveScreen(existingTab.id);
      return;
    }

    const payload = JSON.parse(localStorage.getItem(connectionId) || "{}");
    const connectionData = {
      engine: "postgres",
      label: payload.name,
      postgres: {
        host: payload.host,
        port: payload.port,
        database: payload.database,
        user: payload.user,
        password: payload.password,
        ssl_mode: payload.sslMode,
        ssl_key_path: payload.sslKey,
        ssl_cert_path: payload.sslCert,
        ssl_ca_path: payload.sslCA,
      },
    };

    // Create new tab
    const newTab: Tab = {
      id: `tab-${Date.now()}-conn#${connectionId}`,
      label: connectionData.label || "Unnamed Connection",
      connectionId: payload.id,
      connectionData,
    };

    setTabs([...tabs, newTab]);
    setActiveScreen(newTab.id);
    setShowConnectionModal(false);
  }

  return (
    <div class="h-full flex flex-col bg-neutral-50">
      <div class="flex-1 flex overflow-hidden">
        {/* Left Navigation Sidebar */}
        <div class="w-60 bg-neutral-50 border-r border-neutral-200 flex flex-col shrink-0">
          <div class="p-2">
            <nav class="space-y-1">
              {NAV_ITEMS.map((item) => (
                <Button
                  variant={activeNav === item.id ? "default" : "ghost"}
                  key={item.id}
                  onClick={() => setActiveNav(item.id)}
                  class={`w-full p-2 justify-start gap-3`}
                >
                  {item.icon}
                  <span class="text-[13px] font-medium">{item.label}</span>
                </Button>
              ))}
            </nav>
          </div>
        </div>

        {/* Main Content Area */}
        <div class="flex-1 flex flex-col overflow-hidden">
          {/* Top Bar with Search and Actions */}
          <div class="bg-neutral-50 shadow-md shrink-0">
            {/* Search Bar */}
            <div class="p-2">
              <div class="relative">
                <input
                  type="text"
                  placeholder="Find a connection or postgres://user@hostname..."
                  value={searchQuery}
                  onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
                    setSearchQuery(e.currentTarget.value)
                  }
                  class="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                />
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              </div>
            </div>

            {/* Action Buttons */}
            <div class="p-2 rounded-t-sm bg-slate-200 flex items-center justify-between shadow-sm">
              <div class="flex items-center gap-2">
                <Button
                  variant="default"
                  onClick={handleNewConnection}
                  class="p-1.5 px-2 rounded-md"
                >
                  <Plus className="size-3" />
                  <span class="text-[11px] font-medium">NEW CONNECTION</span>
                </Button>
                <Button class="p-1.5 px-2 rounded-md">
                  <Console className="size-3.5" />
                  <span class="text-[11px] font-medium">QUERY</span>
                </Button>
              </div>

              {/* View Options */}
              <div class="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setViewMode("grid")}
                  class={`p-2 rounded-lg bg-white ${
                    viewMode === "grid"
                      ? "border-blue-600 text-blue-600"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                  title="Grid View"
                >
                  <Grid className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setViewMode("list")}
                  class={`p-2 rounded-lg bg-white ${
                    viewMode === "list"
                      ? "border-blue-600 text-blue-600"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                  title="List View"
                >
                  <List className="size-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Content Area */}

          <div class="flex-1 overflow-y-auto bg-neutral-100">
            {activeNav === "connections" ? (
              <div class="p-6">
                {/* Groups Section */}
                {groupedConnections.length > 0 && (
                  <div class="mb-6">
                    <h2 class="text-sm font-semibold text-slate-800 tracking-wide mb-3">Groups</h2>
                    <div
                      class={
                        viewMode === "grid"
                          ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
                          : "space-y-2"
                      }
                    >
                      {groupedConnections.map((group) => (
                        <Button
                          key={group.tag}
                          variant="ghost"
                          onClick={() => {
                            setSearchQuery(group.tag);
                          }}
                          class="w-full p-3 rounded-xl justify-start text-left bg-white shadow-sm hover:bg-neutral-50"
                        >
                          <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                              <Grid className="size-5 text-blue-500" />
                            </div>
                            <div class="flex-1 flex flex-col min-w-0">
                              <div class="font-semibold text-slate-900 truncate">{group.tag}</div>
                              <div class="text-xs text-slate-500">
                                {group.connections.length} Connection
                                {group.connections.length !== 1 ? "s" : ""}
                              </div>
                            </div>
                          </div>
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Connections Section */}
                <div>
                  <h2 class="text-sm font-semibold text-slate-800 tracking-wide mb-3">
                    Connections
                  </h2>
                  {filteredConnections.length === 0 ? (
                    <div class="text-center py-12">
                      <p class="text-sm text-slate-500 mb-2">
                        {searchQuery ? "No connections found" : "No connections yet"}
                      </p>
                      {!searchQuery && (
                        <Button
                          variant="ghost"
                          onClick={handleNewConnection}
                          class="text-blue-600 mx-auto hover:text-blue-700 hover:bg-transparent text-sm font-medium"
                        >
                          Create your first connection
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div
                      class={
                        viewMode === "grid"
                          ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
                          : "space-y-2"
                      }
                    >
                      {filteredConnections.map((conn, index) => (
                        <div
                          key={index}
                          class={`border-transparent shadow-sm bg-white hover:bg-neutral-50 text-left cursor-pointer flex items-center justify-between gap-3 px-3 py-2 rounded-xl border transition-all ${
                            selectedConnectionId === conn.id
                              ? "border-blue-600 bg-blue-50"
                              : "border-slate-200 bg-white"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openConnectionInTab(conn.id);
                          }}
                        >
                          <div class="flex items-center gap-3 flex-1 min-w-0">
                            <div class="relative">
                              <div
                                class={`p-2 rounded-full bg-blue-500 flex items-center justify-center text-white`}
                              >
                                <Database className="size-6" />
                              </div>
                            </div>
                            <div class="flex-1 min-w-0">
                              <div class="font-semibold text-xs text-slate-900 truncate mb-1">
                                {conn.name} <span class="text-xs text-green-500">({conn.tag})</span>
                              </div>
                              <div class="flex items-center gap-2">
                                {conn.statusColor && (
                                  <div
                                    class="w-3 h-3 rounded-full shrink-0"
                                    style={{ background: conn.statusColor }}
                                  />
                                )}
                                <div class="text-xs text-slate-400 truncate flex-1">
                                  {conn.host} : {conn.database}
                                </div>
                                {conn.connected && (
                                  <div class="w-2 h-2 rounded-full bg-green-500 shrink-0"></div>
                                )}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectConnection(conn.id);
                            }}
                            class="p-2 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
                            title="Edit connection"
                          >
                            <Edit className="size-5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div class="p-6">
                <div class="text-center py-12">
                  <p class="text-slate-500">
                    {NAV_ITEMS.find((n) => n.id === activeNav)?.label} feature coming soon
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* New Connection Modal */}
        {showNewConnection && (
          <ConnectionModal
            onSaved={handleConnectionSaved}
            onClose={() => {
              setShowNewConnection(false);
              setSelectedConnectionId(null);
              setSelectedConnectionData(null);
              setShowDatabaseForm(false);
            }}
            showDatabaseForm={showDatabaseForm}
            setShowDatabaseForm={setShowDatabaseForm}
          />
        )}

        {/* Connection Edit Modal */}
        {showConnectionModal && selectedConnectionData && (
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div class="flex-1 overflow-y-auto">
              <ConnectionFormDialog
                onSaved={handleConnectionSaved}
                onClose={() => {
                  setShowConnectionModal(false);
                  setSelectedConnectionId(null);
                  setSelectedConnectionData(null);
                }}
                initialData={selectedConnectionData}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
