import type { HTMLAttributes, Ref } from "preact";
import { cn } from "src/utils/cn";

export function Input(
  props: HTMLAttributes<HTMLInputElement> & {
    value: string;
    placeholder?: string;
    type?: string;
    error?: boolean;
    left?: React.ReactNode;
    right?: React.ReactNode;
    disabled?: boolean;
    /** Ref to the native input; a plain `ref` would point at this component. */
    inputRef?: Ref<HTMLInputElement>;
  }
) {
  const {
    class: classProp,
    className,
    error,
    left,
    right,
    disabled,
    inputRef,
    ...rest
  } = props;

  const cls = cn(
    "h-10 w-full rounded-xl border px-3 text-sm font-medium outline-none",
    "text-slate-900 placeholder:text-slate-400",
    disabled ? "cursor-not-allowed opacity-60" : "",
    error
      ? "border-rose-300 bg-rose-50 focus:border-rose-400 focus:ring-2 focus:ring-rose-200/60"
      : "border-slate-300 bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-200/60",
    left ? "pl-10" : "",
    right ? "pr-12" : "",
    classProp,
    className
  );

  if (!left && !right) {
    return (
      <input
        {...rest}
        ref={inputRef}
        autoCapitalize={props.autoCapitalize ?? "off"}
        autoCorrect={props.autoCorrect ?? "off"}
        spellcheck={props.spellcheck ?? false}
        disabled={disabled}
        class={cls}
      />
    );
  }

  return (
    <div class="relative">
      {left ? (
        <div class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">
          {left}
        </div>
      ) : null}

      <input
        {...rest}
        ref={inputRef}
        autoCapitalize={props.autoCapitalize ?? "off"}
        autoCorrect={props.autoCorrect ?? "off"}
        spellcheck={props.spellcheck ?? false}
        disabled={disabled}
        class={cls}
      />

      {right ? (
        <div class="absolute top-1/2 right-2 -translate-y-1/2">{right}</div>
      ) : null}
    </div>
  );
}
