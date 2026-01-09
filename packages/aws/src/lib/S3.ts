/*
 * © 2021 Thoughtworks, Inc.
 */

import { Logger, OxygenIT } from "@cloud-carbon-footprint/common";
import {
  Cost,
  HDDStorageService,
  StorageUsage,
} from "@cloud-carbon-footprint/core";
import { GetCostAndUsageRequest } from "aws-sdk/clients/costexplorer";
import { AWS_CLOUD_CONSTANTS } from "../domain";
import { getCostFromCostExplorer } from "./CostMapper";
import { ServiceWrapper } from "./ServiceWrapper";

export default class S3 extends HDDStorageService {
  serviceName = "S3";
  s3Logger: Logger;

  constructor(private readonly serviceWrapper: ServiceWrapper) {
    super(AWS_CLOUD_CONSTANTS.HDDCOEFFICIENT);
    this.s3Logger = new Logger("S3");
  }

  async getUsage(startDate: Date, endDate: Date): Promise<StorageUsage[]> {
    const params = {
      StartTime: startDate,
      EndTime: endDate,
      MetricDataQueries: [
        {
          Id: "s3Size",
          Expression:
            "SUM(SEARCH('{AWS/S3,BucketName,StorageType} MetricName=\"BucketSizeBytes\" StorageType=\"StandardStorage\"', 'Average', 86400))",
        },
      ],
      ScanBy: "TimestampAscending",
    };

    const responses = await this.serviceWrapper.getMetricDataResponses(params);
    const s3ResponseData = responses[0].MetricDataResults[0];

    return (
      s3ResponseData.Timestamps.map((timestampString, i) => {
        return {
          timestamp: new Date(timestampString),
          terabyteHours: (s3ResponseData.Values[i] / 1099511627776) * 24, // Convert bytes to terabyte hours
        };
      }).filter((r: StorageUsage) => r.terabyteHours && r.timestamp) || []
    );
  }

  async getCosts(start: Date, end: Date, region: string): Promise<Cost[]> {
    // This request includes all s3 types/keys combined together
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          { Dimensions: { Key: "REGION", Values: [region] } },
          {
            Dimensions: {
              Key: "SERVICE",
              Values: ["Amazon Simple Storage Service"],
            },
          },
        ],
      },
      Granularity: "DAILY",
      GroupBy: [
        {
          Key: "USAGE_TYPE",
          Type: "DIMENSION",
        },
      ],
      Metrics: ["AmortizedCost"],
    };

    return getCostFromCostExplorer(params, this.serviceWrapper);
  }

  /**
   * Get embodied carbon metrics for S3 storage
   *
   * Fetches S3 usage data from Cost Explorer, extracts storage classes and sizes,
   * calls OxygenIT API for embodied carbon calculations, and aggregates results by
   * region and day with breakdown by storage class.
   *
   * @param start - Start date for the query
   * @param end - End date for the query
   * @param region - AWS region ID
   * @returns Aggregated embodied metrics by region and day
   */
  async getEmbodiedMetrics(
    start: Date,
    end: Date,
    region: string
  ): Promise<S3EmbodiedAggregatedResult[]> {
    // Use 30-day chunking to fetch data
    const responses = await this.serviceWrapper.getQueryByInterval(
      30,
      this.fetchS3EmbodiedData,
      start,
      end,
      region
    );

    return responses.flat();
  }

  private fetchS3EmbodiedData = async (
    start: Date,
    end: Date,
    region: string
  ): Promise<S3EmbodiedAggregatedResult[]> => {
    // Query Cost Explorer for S3 storage usage grouped by USAGE_TYPE
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          { Dimensions: { Key: "REGION", Values: [region] } },
          {
            Dimensions: {
              Key: "SERVICE",
              Values: ["Amazon Simple Storage Service"],
            },
          },
        ],
      },
      Granularity: "DAILY",
      GroupBy: [
        {
          Key: "USAGE_TYPE",
          Type: "DIMENSION",
        },
      ],
      Metrics: ["UsageQuantity"],
    };

    const costExplorerResponses =
      await this.serviceWrapper.getCostAndUsageResponses(params);

    // Initialize OxygenIT client
    const oxygenClient = new OxygenIT();

    // Group storage by region and date first
    const storageByDateMap = new Map<
      string,
      {
        region: string;
        timestamp: Date;
        storages: Array<{ class: string; sizeGbMonth: number }>;
      }
    >();

    // Process all Cost Explorer responses and group by date
    for (const response of costExplorerResponses) {
      for (const result of response.ResultsByTime) {
        const timestamp = new Date(result.TimePeriod.Start);
        const dateKey = `${region}_${timestamp.toISOString().substr(0, 10)}`;

        if (!storageByDateMap.has(dateKey)) {
          storageByDateMap.set(dateKey, {
            region,
            timestamp,
            storages: [],
          });
        }

        const dateEntry = storageByDateMap.get(dateKey);

        for (const group of result.Groups) {
          const usageType = group.Keys[0];
          const gbMonth = Number.parseFloat(group.Metrics.UsageQuantity.Amount);

          if (gbMonth === 0) {
            continue;
          }

          // Extract storage class from usage type
          const storageClass = this.extractStorageClass(usageType);

          if (storageClass) {
            dateEntry.storages.push({
              class: storageClass,
              sizeGbMonth: gbMonth,
            });
          }
        }
      }
    }

    // Now call OxygenIT API for each date with all storages
    const results: S3EmbodiedAggregatedResult[] = [];

    for (const [_, dateEntry] of storageByDateMap) {
      if (dateEntry.storages.length === 0) {
        continue;
      }

      // Duration is 1 day in seconds (86400) since Cost Explorer returns DAILY data
      const durationInSeconds = 24 * 3600;

      // Convert storages to OxygenIT format (size in bytes, must be integer)
      // GB-Month from daily granularity = actual_GB / days_in_month
      // So actual_GB = GB-Month * days_in_month (use 30 as approximation)
      const daysInMonth = 30;
      const storagesForAPI = dateEntry.storages.map((storage) => ({
        class: storage.class,
        size: Math.round(storage.sizeGbMonth * daysInMonth * Math.pow(1024, 3)),
      }));

      try {
        // Call OxygenIT API for embodied metrics
        const embodiedMetrics = await oxygenClient.getS3EmbodiedMetrics({
          config: {
            datacenter: region,
          },
          metrics: {
            storages: storagesForAPI,
          },
          duration: durationInSeconds,
        });

        results.push({
          region: dateEntry.region,
          timestamp: dateEntry.timestamp,
          storageClasses: dateEntry.storages,
          totalSizeGbMonth: dateEntry.storages.reduce(
            (sum, s) => sum + s.sizeGbMonth,
            0
          ),
          carbon: embodiedMetrics.carbon,
          kwh: embodiedMetrics.kwh,
        });
      } catch (error) {
        this.s3Logger.warn(
          `Failed to get embodied metrics for S3 in ${region} on ${dateEntry.timestamp.toISOString()}: ${
            error.message
          }`
        );
      }
    }

    return results;
  };

  /**
   * Extract S3 storage class from AWS usage type string
   * Maps AWS usage types to S3 storage class names
   */
  private extractStorageClass(usageType: string): string | null {
    // Standard storage
    if (usageType.includes("TimedStorage-ByteHrs")) {
      return "STANDARD";
    }

    // Standard-IA
    if (usageType.includes("TimedStorage-SIA")) {
      return "STANDARD_IA";
    }

    // One Zone-IA
    if (usageType.includes("TimedStorage-ZIA")) {
      return "ONEZONE_IA";
    }

    // Glacier Deep Archive
    if (usageType.includes("TimedStorage-GDA")) {
      return "DEEP_ARCHIVE";
    }

    // Glacier
    if (usageType.includes("GlacierByteHrs") || usageType.includes("Glacier")) {
      return "GLACIER";
    }

    // Intelligent Tiering
    if (usageType.includes("TimedStorage-INT")) {
      return "INTELLIGENT_TIERING";
    }

    // Reduced Redundancy
    if (usageType.includes("TimedStorage-RRS")) {
      return "REDUCED_REDUNDANCY";
    }

    // Express One Zone
    if (usageType.includes("Express")) {
      return "EXPRESS_ONEZONE";
    }

    return null;
  }
}

/**
 * Aggregated result for S3 embodied carbon metrics
 */
export interface S3EmbodiedAggregatedResult {
  region: string;
  timestamp: Date;
  storageClasses: Array<{ class: string; sizeGbMonth: number }>;
  totalSizeGbMonth: number; // Total storage size in GB-Month
  carbon: number; // in gCO2eq
  kwh: number; // in kWh
}
