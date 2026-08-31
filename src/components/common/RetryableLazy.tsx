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

export function createRetryableLazy<Props extends object>(
  loader: () => Promise<{ default: FunctionComponent<Props> }>,
  options: RetryableLazyOptions
) {
  return function RetryableLazyComponent(props: Props) {
    const [error, resetError] = useErrorBoundary();
    const [LazyComponent, setLazyComponent] = useState(() =>
      lazy<FunctionComponent<Props>>(loader)
    );

    if (error) {
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
              setLazyComponent(() => lazy<FunctionComponent<Props>>(loader));
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
