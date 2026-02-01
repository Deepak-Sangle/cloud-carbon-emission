import { EmbodiedMetricsAggregatedResult } from "@cloud-carbon-footprint/aws/src/application/AWSAccount";
import { randomUUID } from "crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { EstimationResult } from "../EstimationResult";
import Logger from "../Logger";
import configLoader from "../ConfigLoader";
import type { Database, NewCloudFootprint } from "./types";

/**
 * Configuration options for the database connection
 */
export interface DatabaseConfig {
  /**
   * PostgreSQL connection URL
   * Can be provided directly or via DATABASE_URL env variable
   */
  connectionString?: string;
  /**
   * Maximum number of connections in the pool
   * @default 10
   */
  maxConnections?: number;
  /**
   * Connection timeout in milliseconds
   * @default 30000
   */
  connectionTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds
   * @default 10000
   */
  idleTimeoutMillis?: number;
}

// Singleton instance - lazily initialized
let db: Kysely<Database> | null = null;

/**
 * Creates and returns a Kysely database instance
 * Uses singleton pattern - subsequent calls return the same instance
 *
 * @param config - Optional database configuration
 * @returns Kysely database instance
 * @throws Error if DATABASE_URL is not set and no connectionString provided
 *
 * @example
 * ```typescript
 * // Using environment variable
 * const db = getDatabase()
 *
 * // Using explicit connection string
 * const db = getDatabase({ connectionString: 'postgresql://...' })
 *
 * // Query example
 * const connections = await db
 *   .selectFrom('CloudConnection')
 *   .selectAll()
 *   .where('isActive', '=', true)
 *   .execute()
 * ```
 */
export function getDatabase(config?: DatabaseConfig): Kysely<Database> {
  // Return existing instance if already created
  if (db) {
    return db;
  }

  const connectionString =
    config?.connectionString ?? configLoader().DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "Database connection string is required. " +
        "Set DATABASE_URL environment variable or provide connectionString in config.",
    );
  }

  console.log(connectionString);

  const pool = new Pool({
    connectionString,
    max: config?.maxConnections ?? 10,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 30000,
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 10000,
  });

  db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });

  return db;
}

/**
 * Destroys the database connection pool
 * Call this when shutting down the application
 *
 * @example
 * ```typescript
 * // On application shutdown
 * process.on('SIGTERM', async () => {
 *   await destroyDatabase()
 *   process.exit(0)
 * })
 * ```
 */
export async function destroyDatabase(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}

/**
 * Returns the current database instance without creating one
 * Returns null if no instance exists
 *
 * @returns Current database instance or null
 */
export function getDatabaseInstance(): Kysely<Database> | null {
  return db;
}

/**
 * Checks if a database connection exists and is healthy
 *
 * @returns true if database is connected and responsive
 */
export async function isDatabaseConnected(): Promise<boolean> {
  try {
    const client = getDatabase();
    await client.selectFrom("CloudConnection").select("id").limit(1).execute();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function saveFootprintResponse(
  estimates: EstimationResult[],
  embodiedMetrics: EmbodiedMetricsAggregatedResult[],
  cloudConnectionId: string,
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const syncLogger = new Logger("FootprintSync");

  // Flatten and save to database
  const db = getDatabase();
  const flattenedData: NewCloudFootprint[] = [];

  for (const estimate of estimates) {
    for (const serviceEstimate of estimate.serviceEstimates) {
      flattenedData.push({
        id: randomUUID(),
        cloudConnectionId,
        timestamp: estimate.timestamp,
        periodStartDate: estimate.periodStartDate,
        periodEndDate: estimate.periodEndDate,
        cloudProvider: serviceEstimate.cloudProvider,
        kilowattHours: serviceEstimate.kilowattHours,
        co2e: serviceEstimate.co2e,
        type: "OPERATIONAL_METRICS",
        cost: serviceEstimate.cost,
        serviceType: null,
        serviceName: serviceEstimate.serviceName,
        region: serviceEstimate.region,
        tags: serviceEstimate.tags
          ? JSON.stringify(serviceEstimate.tags)
          : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  for (const embodiedMetric of embodiedMetrics) {
    const periodEndDate = embodiedMetric.timestamp;
    periodEndDate.setDate(periodEndDate.getDate() + 1);
    flattenedData.push({
      id: randomUUID(),
      cloudConnectionId,
      timestamp: embodiedMetric.timestamp,
      periodStartDate: embodiedMetric.timestamp,
      periodEndDate: periodEndDate,
      cloudProvider: "AWS",
      serviceType: embodiedMetric.serviceType,
      kilowattHours: embodiedMetric.kilowattHours,
      co2e: embodiedMetric.co2e,
      type: "EMBODIED_METRICS",
      serviceName: embodiedMetric.serviceName,
      region: embodiedMetric.region,
      tags: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Upsert data to database
  if (flattenedData.length > 0) {
    syncLogger.info(
      `Saving ${flattenedData.length} footprint records for connection: ${cloudConnectionId}`,
    );
    await db.transaction().execute(async (trx) => {
      // Delete existing data for the connection within the date range
      await trx
        .deleteFrom("CloudFootprint")
        .where("cloudConnectionId", "=", cloudConnectionId)
        .where("timestamp", ">=", new Date(startDate))
        .where("timestamp", "<=", new Date(endDate))
        .execute();

      // Bulk insert
      await trx.insertInto("CloudFootprint").values(flattenedData).execute();
    });

    syncLogger.info(
      `Successfully saved ${flattenedData.length} footprint records for connection: ${cloudConnectionId}`,
    );
  }

  return flattenedData.length;
}
