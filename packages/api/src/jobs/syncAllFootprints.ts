/*
 * © 2023 Thoughtworks, Inc.
 */

import { Logger } from "@cloud-carbon-footprint/common";
import { syncAllCloudFootprints } from "../services/footprintSync";

const logger = new Logger("SyncCronJob");

/**
 * Cron job to sync all active cloud connections
 * Runs for yesterday's data
 */
async function runSync() {
  logger.info("=".repeat(60));
  logger.info("Starting scheduled footprint sync for all connections");
  logger.info("=".repeat(60));

  try {
    const result = await syncAllCloudFootprints();

    logger.info("Sync job completed successfully");
    logger.info(
      `Total connections processed: ${result.totalConnectionsProcessed}`
    );
    logger.info(`Total records saved: ${result.totalRecordsSaved}`);

    if (result.failed.length > 0) {
      logger.warn(`Failed connections: ${result.failed.length}`);
      result.failed.forEach((fail) => {
        logger.error(
          `  - Connection ${fail.id}: ${fail.error}`,
          new Error(fail.error)
        );
      });
    }

    logger.info("=".repeat(60));

    // Exit with appropriate code
    process.exit(result.failed.length > 0 ? 1 : 0);
  } catch (error) {
    logger.error(
      "Fatal error in sync job:",
      error instanceof Error ? error : new Error(String(error))
    );
    logger.info("=".repeat(60));
    process.exit(1);
  }
}

// Run the sync
runSync();
