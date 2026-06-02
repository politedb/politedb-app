export function AiAssistantThinkingCard() {
  return (
    <div class="rounded-xl border border-neutral-200 bg-white p-3">
      <div class="mb-1 text-xs font-bold tracking-wide text-neutral-500 uppercase">
        PoliteDB AI
      </div>

      <div class="flex items-center gap-2 text-xs text-neutral-700">
        <span class="gradient-to-r animate-pulse from-neutral-300 to-neutral-600 font-medium">
          Thinking...
        </span>
      </div>
    </div>
  );
}
