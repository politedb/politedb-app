import { useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  parseMarkdown,
  type Block,
  type Inline,
} from "src/lib/ai-assistant/markdown";
import { cn } from "src/utils/cn";

function renderInline(nodes: Inline[]): ComponentChildren {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "break":
        return <br key={index} />;
      case "strong":
        return (
          <strong key={index} class="font-semibold">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code
            key={index}
            class="rounded bg-neutral-200/70 px-1 py-px font-mono text-[0.9em] wrap-break-word"
          >
            {node.text}
          </code>
        );
      case "link":
        // Plain text plus its domain: no clickable remote links (plan ai-agent R5).
        return (
          <span key={index}>
            {node.text}
            {node.domain ? (
              <span class="text-neutral-500"> ({node.domain})</span>
            ) : null}
          </span>
        );
    }
  });
}

function renderBlock(block: Block, index: number) {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "heading":
      return (
        <p
          key={index}
          class={cn("font-semibold", block.level <= 2 && "text-[1.05em]")}
        >
          {renderInline(block.children)}
        </p>
      );
    case "list": {
      if (block.ordered) {
        const start = block.start ?? 1;
        // Room for the widest marker ("10." needs more than "9."), else it is cut off.
        const digits = String(start + block.items.length - 1).length;
        return (
          <ol
            key={index}
            start={start}
            class="list-decimal space-y-1 tabular-nums"
            style={{ paddingLeft: `calc(${digits}ch + 1rem)` }}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderInline(item)}</li>
            ))}
          </ol>
        );
      }
      return (
        <ul key={index} class="list-disc space-y-1 pl-5">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    }
    case "code":
      return (
        <pre
          key={index}
          class="overflow-x-auto rounded-lg bg-neutral-100 p-2 font-mono text-xs"
        >
          {block.text}
        </pre>
      );
    case "quote":
      return (
        <blockquote
          key={index}
          class="border-l-2 border-neutral-300 pl-3 text-neutral-600"
        >
          {renderInline(block.children)}
        </blockquote>
      );
  }
}

/** Assistant text with Markdown formatting, rendered as elements (never HTML). */
export function MarkdownText(props: { text: string; class?: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return (
    <div class={cn("space-y-2 wrap-break-word", props.class)}>
      {blocks.map(renderBlock)}
    </div>
  );
}
