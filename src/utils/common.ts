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
