import type { JSX } from "preact";

export type NavId = "connections" | "keychain";
export type ViewMode = "grid" | "list";

export type NavItem = {
  id: NavId;
  label: string;
  icon: JSX.Element;
};
