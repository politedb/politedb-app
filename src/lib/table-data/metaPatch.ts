import { useConnectionStore } from "src/stores/connection";

export function patchMeta(
  setMeta: (key: string, patch: any) => void,
  key: string,
  prev: any,
  patch: any
) {
  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, { ...cur, ...patch });
}
