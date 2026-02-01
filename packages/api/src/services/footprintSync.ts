/*
 * © 2023 Thoughtworks, Inc.
 */

import {
  App,
  createValidFootprintRequest,
  FootprintEstimatesRawRequest,
} from "@cloud-carbon-footprint/app";

import {
  CCFConfig,
  configLoader,
  getDatabase,
  Logger,
  setConfig,
} from "@cloud-carbon-footprint/common";
import { randomUUID } from "crypto";

const syncLogger = new Logger("FootprintSync");

/**
 * Deep merges two objects, with source values taking precedence over target values.
 */
function deepMerge(target: CCFConfig, source: Partial<CCFConfig>): CCFConfig {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
        );
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

/**
 * Syncs footprint data for a single cloud connection
 */
export async function syncCloudConnectionFootprint(
  cloudConnectionId: string,
  startDate: string,
  endDate: string,
  organizationId: string,
  config?: Partial<CCFConfig>,
): Promise<number> {
  const rawRequest: FootprintEstimatesRawRequest = {
    startDate,
    endDate,
    ignoreCache: "true",
    groupBy: "day",
  };

  // Get the default config and merge with any override config
  const defaultConfig = configLoader();
  const overrideConfig: Partial<CCFConfig> = config || {};
  const mergedConfig = deepMerge(defaultConfig, overrideConfig);

  // Apply the merged config
  setConfig(mergedConfig);

  const footprintApp = new App();

  try {
    const estimationRequest = createValidFootprintRequest(rawRequest);
    const estimationResults = await footprintApp.getCostAndEstimates(
      estimationRequest,
      cloudConnectionId,
    );

    // console.log(
    //   "estimationResults",
    //   JSON.stringify(estimationResults, null, 2),
    // );

    const db = getDatabase();
    // Update lastSync on CloudConnection
    await db
      .updateTable("CloudConnection")
      .set({ lastSync: new Date(), updatedAt: new Date() })
      .where("id", "=", cloudConnectionId)
      .execute();

    // Create audit log entry
    await db
      .insertInto("AuditLog")
      .values({
        id: randomUUID(),
        action: "CLOUD_FOOTPRINT_DATA_SYNCED",
        entity: "CLOUD_CONNECTION",
        entityId: cloudConnectionId,
        details: JSON.stringify({
          startDate,
          endDate,
        }),
        cloudConnectionId,
        userId: null,
        kpiId: null,
        kpiResultId: null,
        organizationId: organizationId,
      })
      .execute();

    return (
      estimationResults.estimates.length +
      estimationResults.embodiedMetrics.length
    );
  } finally {
    // Reset config back to default
    setConfig(defaultConfig);
  }
}

/**
 * Syncs footprint data for all active cloud connections
 * Runs for yesterday's data (current date - 1 day)
 */
export async function syncAllCloudFootprints(): Promise<{
  totalRecordsSaved: number;
  totalConnectionsProcessed: number;
  failed: Array<{ id: string; error: string }>;
}> {
  // Calculate yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  // AWS Cost Explorer expects YYYY-MM-DD format (date only)
  // End date should be the day AFTER the period you want (exclusive)
  const startDate = yesterday.toISOString().split("T")[0]; // "YYYY-MM-DD"

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = today.toISOString().split("T")[0]; // "YYYY-MM-DD" (today, exclusive)

  syncLogger.info(
    `Starting sync for all active cloud connections for date: ${startDate} to ${endDate}`,
  );

  const db = getDatabase();

  // Fetch all active cloud connections
  const connections = await db
    .selectFrom("CloudConnection")
    .selectAll()
    .where("isActive", "=", true)
    .execute();

  syncLogger.info(`Found ${connections.length} active cloud connections`);

  let totalRecordsSaved = 0;
  let totalConnectionsProcessed = 0;
  const failed: Array<{ id: string; error: string }> = [];

  for (const connection of connections) {
    try {
      syncLogger.info(
        `Syncing connection ${connection.id} (${connection.provider})...`,
      );

      // Build config based on provider
      const config: Partial<CCFConfig> = {};

      if (connection.provider === "AWS" && connection.accountId) {
        config.AWS = {
          INCLUDE_ESTIMATES: true,
          INCLUDE_EMBODIED_METRICS: true,
          INCLUDE_OPERATIONAL_METRICS: true,
          USE_BILLING_DATA: false,
          accounts: [{ id: connection.accountId }],
          authentication: {
            mode: "AWS",
            options: {
              ...(connection.externalId && {
                externalId: connection.externalId,
              }),
            },
          },
        };
      }
      // Add GCP, Azure config as needed
      // else if (connection.provider === "GCP") { ... }

      const result = await syncCloudConnectionFootprint(
        connection.id,
        startDate,
        endDate,
        connection.organizationId,
        config,
      );

      totalRecordsSaved += result;
      totalConnectionsProcessed++;

      syncLogger.info(
        `Successfully synced connection ${connection.id}: ${result} records`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      syncLogger.error(
        `Failed to sync connection ${connection.id}: ${errorMessage}`,
        error,
      );
      failed.push({ id: connection.id, error: errorMessage });
    }
  }

  syncLogger.info(
    `Sync completed: ${totalConnectionsProcessed}/${connections.length} connections processed, ${totalRecordsSaved} total records saved, ${failed.length} failed`,
  );

  return {
    totalRecordsSaved,
    totalConnectionsProcessed,
    failed,
  };
}
