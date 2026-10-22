import { create } from "zustand";
import type {
  ConnectionSortMode,
  KeychainSortMode,
  NavId,
  ViewMode,
} from "src/types";
import type { ConnectionLogStatusFilter } from "src/utils/connectionLog";

/**
 * How the home screen was left: page, search, sort, layout, group, History
 * filters and scroll position. The home screen unmounts while a connection tab
 * is open, so this lives here (in memory, for the session) and is restored when
 * coming back.
 */
type MainViewState = {
  activeNav: NavId;
  searchQuery: string;
  viewMode: ViewMode;
  connectionSortMode: ConnectionSortMode;
  keychainSortMode: KeychainSortMode;
  selectedGroupId: string | undefined;
  historyStatusFilter: ConnectionLogStatusFilter;
  historyProfileFilter: string;
  /** Scroll offset of each page's content. */
  scrollTopByNav: Partial<Record<NavId, number>>;

  setActiveNav: (nav: NavId) => void;
  setSearchQuery: (query: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setConnectionSortMode: (mode: ConnectionSortMode) => void;
  setKeychainSortMode: (mode: KeychainSortMode) => void;
  setSelectedGroupId: (id: string | undefined) => void;
  setHistoryStatusFilter: (filter: ConnectionLogStatusFilter) => void;
  setHistoryProfileFilter: (profileId: string) => void;
  setScrollTop: (nav: NavId, top: number) => void;
};

export const MAIN_VIEW_DEFAULTS = {
  activeNav: "connections" as NavId,
  searchQuery: "",
  viewMode: "grid" as ViewMode,
  connectionSortMode: "created-desc" as ConnectionSortMode,
  keychainSortMode: "label-asc" as KeychainSortMode,
  selectedGroupId: undefined,
  historyStatusFilter: "all" as ConnectionLogStatusFilter,
  historyProfileFilter: "all",
  scrollTopByNav: {},
};

export const useMainViewStore = create<MainViewState>((set) => ({
  ...MAIN_VIEW_DEFAULTS,
  setActiveNav: (activeNav) => set({ activeNav }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setViewMode: (viewMode) => set({ viewMode }),
  setConnectionSortMode: (connectionSortMode) => set({ connectionSortMode }),
  setKeychainSortMode: (keychainSortMode) => set({ keychainSortMode }),
  setSelectedGroupId: (selectedGroupId) => set({ selectedGroupId }),
  setHistoryStatusFilter: (historyStatusFilter) => set({ historyStatusFilter }),
  setHistoryProfileFilter: (historyProfileFilter) =>
    set({ historyProfileFilter }),
  setScrollTop: (nav, top) =>
    set((s) => ({ scrollTopByNav: { ...s.scrollTopByNav, [nav]: top } })),
}));
