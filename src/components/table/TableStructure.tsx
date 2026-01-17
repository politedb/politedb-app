import { useMemo } from "preact/hooks";
import { Box } from "src/components/common/Box";
import { TableStructureRow } from "./TableStructureRow";
import type { TableStructure } from "src/types";

interface Props {
  structure: TableStructure[] | null;
  busy: boolean;
  error: string | null;
}

function LoadingState() {
  return (
    <Box className="text-center">
      <div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
      <p class="text-neutral-500">Loading table structure...</p>
    </Box>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <Box className="text-center">
      <p class="mb-2 text-red-600">Error loading table structure</p>
      <p class="text-sm text-neutral-500">{error}</p>
    </Box>
  );
}

function EmptyState() {
  return (
    <Box className="text-center">
      <p class="text-neutral-500">No structure data available</p>
    </Box>
  );
}

export function TableStructure({ structure, busy, error }: Props) {
  const hasData = useMemo(() => {
    return structure && structure.length > 0;
  }, [structure]);

  if (busy) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!hasData) return <EmptyState />;

  return (
    <div class="flex h-full flex-col overflow-hidden bg-white">
      <div class="flex-1 overflow-auto">
        <table class="w-full border-collapse">
          <thead class="sticky top-0 z-10 bg-neutral-100 shadow-sm">
            <tr>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Column Name
              </th>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Data Type
              </th>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Nullable
              </th>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Default
              </th>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Foreign Key
              </th>
              <th class="border-b border-neutral-200 bg-neutral-100 px-4 py-3 text-left text-xs font-semibold text-neutral-700">
                Comment
              </th>
            </tr>
          </thead>
          <tbody>
            {structure!.map((row, index) => (
              <TableStructureRow key={index} structure={row} index={index} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
