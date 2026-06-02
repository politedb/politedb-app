export const inflightLoadBySignature = new Map<string, Promise<void>>();
export const inflightLoadByTableKey = new Map<string, Promise<void>>();
export const latestLoadSignatureByKey = new Map<string, string>();
export const rowsInflightByQueryKey = new Map<string, Promise<void>>();
export const inflightRowCountByKey = new Map<
  string,
  Promise<{ value: number; estimated: boolean }>
>();
export const inflightSizeInfoByKey = new Map<string, Promise<unknown>>();
export const inflightForeignKeysByKey = new Map<string, Promise<unknown[]>>();
