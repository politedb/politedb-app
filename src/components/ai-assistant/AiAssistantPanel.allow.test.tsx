import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  submitQuestion: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("src/lib/tauri/aiAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri/aiAgent")>()),
  aiAgentDataAccessGrant: (...a: unknown[]) => mocks.grant(...a),
}));
vi.mock("src/components/ai-assistant/hooks/useAiAssistantSubmit", () => ({
  useAiAssistantSubmit: () => ({
    canSubmit: false,
    handleSubmit: vi.fn(),
    submitQuestion: mocks.submitQuestion,
    handleCancelSubmit: mocks.cancel,
  }),
}));
vi.mock("src/lib/tauri/ai", () => ({
  aiChatCancel: vi.fn(),
  aiLegacyModelInfo: vi.fn().mockResolvedValue({ files: [] }),
}));
vi.mock("@root/src/lib/ai-assistant/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/ai-assistant/providers")>()),
  aiProviderList: vi.fn().mockResolvedValue([
    {
      id: "p1",
      kind: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt",
      models: ["gpt"],
      enabled: true,
    },
  ]),
  getSelectedAiProviderId: () => "p1",
  setSelectedAiProviderId: vi.fn(),
}));
// Card stand-in: one button that answers "Allow".
vi.mock("src/components/ai-assistant/AiAssistantMessageCard", () => ({
  AiAssistantMessageCard: ({ message, onAllowDataAccess }: any) =>
    message.role === "assistant" ? (
      <button onClick={() => void onAllowDataAccess?.("top customers?")}>
        allow-{message.id}
      </button>
    ) : null,
}));

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

vi.mock("src/components/common/Button", () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
}));

vi.mock("src/components/icons", () => ({
  ArrowDown: () => <span>arrow-down</span>,
  ArrowRightIcon: () => <span>arrow-right</span>,
  BackupIcon: () => <span>backup</span>,
  ChatPlusIcon: () => <span>new-chat</span>,
  ChevronDownIcon: () => <span>chevron-down</span>,
  DownloadIcon: () => <span>download</span>,
  MinusIcon: () => <span>minus</span>,
  MoreVerticalIcon: () => <span>more</span>,
  VaultIcon: () => <span>vault</span>,
  PlayIcon: () => <span>play</span>,
  RefreshCwIcon: () => <span>refresh</span>,
  StopIcon: () => <span>stop</span>,
  Settings: () => <span>settings</span>,
  SettingsIcon: () => <span>settings</span>,
  ShareIcon: () => <span>share</span>,
  SparklesIcon: () => <span>sparkles</span>,
  XIcon: () => <span>x</span>,
}));

import { AiAssistantPanel } from "./AiAssistantPanel";

function seedChat(scope: string) {
  localStorage.setItem(
    `politedb.ai.chat.${scope}`,
    JSON.stringify({
      activeSessionId: "s",
      sessions: [
        {
          id: "s",
          title: "t",
          createdAt: 1,
          updatedAt: 1,
          providerId: "p1",
          messages: [{ id: "m", role: "assistant", text: "allow?" }],
        },
      ],
    })
  );
}

function panel(scope: string, mode: string) {
  return (
    <AiAssistantPanel
      chatSessionKey={scope}
      engine="postgres"
      tables={[]}
      columnsByTable={{}}
      runtimeConnectionId="conn-1"
      querySafetyMode={mode as any}
    />
  );
}

/** A grant that finishes only when the test says so. */
function pendingGrant() {
  let finish: () => void = () => {};
  mocks.grant.mockImplementation(
    () => new Promise<void>((resolve) => (finish = resolve))
  );
  return () => finish();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("a pending Allow", () => {
  it("asks again when nothing changed meanwhile", async () => {
    seedChat("a");
    const finish = pendingGrant();
    render(panel("a", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    finish();
    await waitFor(() =>
      expect(mocks.submitQuestion).toHaveBeenCalledWith("top customers?")
    );
  });

  for (const next of ["lock", "production"]) {
    it(`does not ask again after the safety mode changed to ${next}`, async () => {
      seedChat("b");
      const finish = pendingGrant();
      const view = render(panel("b", "default"));
      fireEvent.click(await screen.findByText("allow-m"));
      view.rerender(panel("b", next));
      finish();
      await waitFor(() => expect(mocks.grant).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.submitQuestion).not.toHaveBeenCalled();
    });
  }

  it("does not ask again after the panel closed", async () => {
    seedChat("c");
    const finish = pendingGrant();
    const view = render(panel("c", "default"));
    fireEvent.click(await screen.findByText("allow-m"));
    view.unmount();
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.submitQuestion).not.toHaveBeenCalled();
  });
});
