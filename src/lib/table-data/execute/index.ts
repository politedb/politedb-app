import { executeCassandraLoad } from "./cassandraExecute";
import { executeMongoLoad } from "./mongoExecute";
import { executeRedisLoad } from "./redisExecute";
import { executeSqlLoad } from "./sqlExecute";
import { executeGoogleSheetsLoad } from "./googleSheetsExecute";
import type { LoadExecutionContext, LoadExecutionResult } from "./types";

export type { LoadExecutionContext, LoadExecutionResult } from "./types";

export async function executeEngineLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  switch (ctx.engine) {
    case "mongo":
      return executeMongoLoad(ctx);
    case "cassandra":
      return executeCassandraLoad(ctx);
    case "redis":
      return executeRedisLoad(ctx);
    case "google_sheets":
      return executeGoogleSheetsLoad(ctx);
    default:
      return executeSqlLoad(ctx);
  }
}

export { supportsTableMeta } from "src/lib/engines";
