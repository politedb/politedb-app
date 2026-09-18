import type { ComponentChildren } from "preact";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
} from "src/components/common/Dialog";
import { cn } from "src/utils/cn";
import {
  SparklesIcon,
  ShieldAnalyticsIcon,
  TableIcon,
  DatabaseIcon,
  PoliteDbIcon,
} from "src/components/icons";

type WelcomeFeature = {
  title: string;
  description: string;
  icon: ComponentChildren;
};

const FEATURES: WelcomeFeature[] = [
  {
    title: "One client, many engines",
    description:
      "PostgreSQL, MySQL, SQLite, Redis, MongoDB, ClickHouse, and more — browse and query from one native desktop app.",
    icon: <DatabaseIcon className="size-8" />,
  },
  {
    title: "Safe table editing",
    description:
      "Edit cells in place, preview the SQL, then save in a transaction. Risky updates without a clear row identity stay blocked.",
    icon: <TableIcon className="size-6" />,
  },
  {
    title: "Local AI for SQL",
    description:
      "Ask PoliteDB AI to suggest, explain, and summarize queries. Optional local runtime keeps sensitive work on your machine.",
    icon: <SparklesIcon className="size-6" />,
  },
  {
    title: "Private by default",
    description:
      "Passwords stay in your Keychain. Use SSH and SSL when you need them, and import connections from TablePlus or DBeaver.",
    icon: <ShieldAnalyticsIcon className="size-8" />,
  },
];

export function WelcomeDialog(props: {
  open: boolean;
  onContinue: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      size="lg"
      showCloseButton={false}
      closeOnEsc={false}
      closeOnOutsideClick={false}
      className="overflow-hidden border-neutral-200"
    >
      <DialogContent className="gap-8 px-8 pt-10 pb-2">
        <div class="flex flex-col items-center text-center">
          <PoliteDbIcon class="size-16 rounded-2xl shadow-sm" />
          <h1 class="mt-5 text-2xl font-bold tracking-tight text-neutral-900">
            Welcome to PoliteDB
          </h1>
          <p class="mt-2 max-w-sm text-sm leading-5 text-neutral-500">
            Modern database client for massive datasets — fast, private, and
            built for daily SQL work.
          </p>
        </div>

        <ul class="flex flex-col gap-6">
          {FEATURES.map((feature) => (
            <li key={feature.title} class="flex items-start gap-4">
              <div
                class={cn(
                  "mt-0.5 flex size-10 shrink-0 items-center justify-center",
                  "text-blue-500"
                )}
              >
                {feature.icon}
              </div>
              <div class="min-w-0 text-left">
                <div class="text-base font-semibold text-neutral-900">
                  {feature.title}
                </div>
                <p class="mt-1 text-sm leading-5 text-neutral-500">
                  {feature.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>

      <DialogFooter className="justify-center px-8 pt-4 pb-8">
        <Button
          type="button"
          onClick={props.onContinue}
          className="h-11 rounded-full px-10 text-base font-semibold"
        >
          Get Started
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
