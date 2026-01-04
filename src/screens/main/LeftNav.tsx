import { Database, Key } from "src/components/icons";
import { Button } from "src/components/common/Button";
import type { NavId, NavItem } from "src/types";

const NAV_ITEMS: NavItem[] = [
  {
    id: "connections",
    label: "Connections",
    icon: <Database className="size-4" />,
  },
  { id: "keychain", label: "Keychain", icon: <Key className="size-4" /> },
];

export function LeftNav(props: {
  active: NavId;
  onChange: (id: NavId) => void;
}) {
  const { active, onChange } = props;

  return (
    <div class="w-60 bg-neutral-50 border-r border-neutral-200 flex flex-col shrink-0">
      <div class="p-2">
        <nav class="space-y-1">
          {NAV_ITEMS.map((item) => (
            <Button
              key={item.id}
              variant={active === item.id ? "default" : "ghost"}
              onClick={() => onChange(item.id)}
              class="w-full p-2 justify-start gap-3"
            >
              {item.icon}
              <span class="text-[13px] font-medium">{item.label}</span>
            </Button>
          ))}
        </nav>
      </div>
    </div>
  );
}
