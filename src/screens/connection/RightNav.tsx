import { Box } from "../../components/common/Box";
import { TableSizeInfo } from "../../types";

interface Props {
  sizeInfo: TableSizeInfo | null;
}

export function RightNav({ sizeInfo }: Props) {
  if (!sizeInfo) {
    return (
      <Box className="p-4 text-center">
        <p class="text-sm text-neutral-500">No table selected</p>
      </Box>
    );
  }

  return (
    <div class="flex h-full flex-col gap-2 overflow-y-auto bg-white px-3 py-2">
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">Total Size</div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.totalSize || "0 KB"}
        </div>
      </div>
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">Table Size</div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.dataSize || "0 KB"}
        </div>
      </div>
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">
          Indexes Size
        </div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.indexSize || "0 KB"}
        </div>
      </div>
    </div>
  );
}
