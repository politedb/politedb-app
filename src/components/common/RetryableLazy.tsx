import {
  createElement,
  type ComponentChildren,
  type FunctionComponent,
} from "preact";
import { lazy, Suspense } from "preact/compat";
import { useErrorBoundary, useState } from "preact/hooks";
import { Button } from "./Button";

type RetryableLazyOptions = {
  label: string;
  renderFallback?: () => ComponentChildren;
};

class LazyImportError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error ?? ""));
    this.name = "LazyImportError";
    this.originalError = error;
  }
}

export function createRetryableLazy<Props extends object>(
  loader: () => Promise<{ default: FunctionComponent<Props> }>,
  options: RetryableLazyOptions
) {
  const load = () =>
    loader().catch((error: unknown) => {
      throw new LazyImportError(error);
    });

  return function RetryableLazyComponent(props: Props) {
    const [error, resetError] = useErrorBoundary();
    const [LazyComponent, setLazyComponent] = useState(() =>
      lazy<FunctionComponent<Props>>(load)
    );

    if (error) {
      if (!(error instanceof LazyImportError)) throw error;

      return (
        <div
          role="alert"
          class="flex h-full min-h-24 flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <p class="text-sm text-neutral-600">
            Failed to load {options.label}.
          </p>
          <Button
            type="button"
            variant="shadow"
            onClick={() => {
              setLazyComponent(() => lazy<FunctionComponent<Props>>(load));
              resetError();
            }}
          >
            Retry
          </Button>
        </div>
      );
    }

    return (
      <Suspense fallback={options.renderFallback?.() ?? null}>
        {createElement(LazyComponent, props)}
      </Suspense>
    );
  };
}
