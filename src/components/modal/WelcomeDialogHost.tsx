import { useState } from "preact/hooks";
import { WelcomeDialog } from "src/components/modal/WelcomeDialog";
import { hasSeenWelcome, markWelcomeSeen } from "src/lib/welcome";

export function WelcomeDialogHost() {
  const [open, setOpen] = useState(() => !hasSeenWelcome());

  function handleContinue() {
    markWelcomeSeen();
    setOpen(false);
  }

  return <WelcomeDialog open={open} onContinue={handleContinue} />;
}
