export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number
) {
  let t: any;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryOptions<TError = unknown> = {
  attempts: number;
  delayMs?: number | ((attempt: number, error: TError) => number);
  shouldRetry?: (error: TError, attempt: number) => boolean | Promise<boolean>;
  onRetry?: (error: TError, attempt: number) => void | Promise<void>;
};

export async function retryAsync<TResult, TError = unknown>(
  task: () => Promise<TResult>,
  options: RetryOptions<TError>
): Promise<TResult> {
  const { attempts, delayMs = 0, shouldRetry, onRetry } = options;
  let lastError: TError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (e) {
      lastError = e as TError;

      if (attempt >= attempts) break;

      const canRetry = shouldRetry
        ? await shouldRetry(lastError, attempt)
        : true;
      if (!canRetry) throw lastError;

      if (onRetry) {
        await onRetry(lastError, attempt);
      }

      const waitMs =
        typeof delayMs === "function" ? delayMs(attempt, lastError) : delayMs;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }

  throw lastError;
}
