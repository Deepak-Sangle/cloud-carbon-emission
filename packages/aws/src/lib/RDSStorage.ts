/*
 * © 2021 Thoughtworks, Inc.
 */

import { Logger, OxygenIT } from "@cloud-carbon-footprint/common";
import {
  CloudConstants,
  CloudConstantsEmissionsFactors,
  Cost,
  FootprintEstimate,
  ICloudService,
} from "@cloud-carbon-footprint/core";
import { GetCostAndUsageRequest } from "aws-sdk/clients/costexplorer";

import { getCostFromCostExplorer } from "./CostMapper";
import { ServiceWrapper } from "./ServiceWrapper";
import {
  DiskType,
  getEstimatesFromCostExplorer,
  getUsageFromCostExplorer,
  VolumeUsage,
} from "./StorageUsageMapper";

export default class RDSStorage implements ICloudService {
  serviceName = "rds-storage";
  rdsStorageLogger: Logger;

  constructor(private readonly serviceWrapper: ServiceWrapper) {
    this.rdsStorageLogger = new Logger("RDS Storage Logger");
  }

  async getEstimates(
    start: Date,
    end: Date,
    region: string,
    emissionsFactors: CloudConstantsEmissionsFactors,
    constants: CloudConstants
  ): Promise<FootprintEstimate[]> {
    const usage: VolumeUsage[] = await this.getUsage(start, end, region);
    return getEstimatesFromCostExplorer(
      region,
      usage,
      emissionsFactors,
      constants
    );
  }

  async getUsage(
    startDate: Date,
    endDate: Date,
    region: string
  ): Promise<VolumeUsage[]> {
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: startDate.toISOString().substr(0, 10),
        End: endDate.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          { Dimensions: { Key: "REGION", Values: [region] } },
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: ["RDS: Storage"],
            },
          },
        ],
      },
      Granularity: "DAILY",
      Metrics: ["UsageQuantity"],
      GroupBy: [
        {
          Key: "USAGE_TYPE",
          Type: "DIMENSION",
        },
      ],
    };

    return await getUsageFromCostExplorer(
      params,
      this.getDiskType,
      this.serviceWrapper
    );
  }

  private getDiskType = (awsGroupKey: string) => {
    if (
      awsGroupKey.endsWith("GP2-Storage") ||
      awsGroupKey.endsWith("PIOPS-Storage")
    )
      return DiskType.SSD;
    if (
      awsGroupKey.endsWith("StorageUsage") ||
      awsGroupKey.endsWith("ChargedBackupUsage")
    )
      return DiskType.HDD;
    this.rdsStorageLogger.warn(
      "Unexpected Cost explorer Dimension Name: " + awsGroupKey
    );
    return DiskType.UNKNOWN;
  };

  async getCosts(start: Date, end: Date, region: string): Promise<Cost[]> {
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
              Key: "USAGE_TYPE_GROUP",
              Values: ["RDS: Storage"],
            },
          },
        ],
      },
      Granularity: "DAILY",
      Metrics: ["AmortizedCost"],
      GroupBy: [
        {
          Key: "USAGE_TYPE",
          Type: "DIMENSION",
        },
      ],
    };

    return getCostFromCostExplorer(params, this.serviceWrapper);
  }

  /**
   * Get embodied carbon metrics for RDS storage
   *
   * Fetches RDS storage usage data from Cost Explorer, aggregates total storage size,
   * calls OxygenIT API for embodied carbon calculations, and returns results by
   * region and day.
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
  ): Promise<RDSStorageEmbodiedAggregatedResult[]> {
    // Use 30-day chunking to fetch data
    const responses = await this.serviceWrapper.getQueryByInterval(
      30,
      this.fetchRDSStorageEmbodiedData,
      start,
      end,
      region
    );

    return responses.flat();
  }

  private fetchRDSStorageEmbodiedData = async (
    start: Date,
    end: Date,
    region: string
  ): Promise<RDSStorageEmbodiedAggregatedResult[]> => {
    // Query Cost Explorer for RDS storage usage
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
              Key: "USAGE_TYPE_GROUP",
              Values: ["RDS: Storage"],
            },
          },
        ],
      },
      Granularity: "DAILY",
      Metrics: ["UsageQuantity"],
    };

    const costExplorerResponses =
      await this.serviceWrapper.getCostAndUsageResponses(params);

    // Initialize OxygenIT client
    const oxygenClient = new OxygenIT();

    // Aggregate storage by region and date
    const storageByDateMap = new Map<
      string,
      {
        region: string;
        timestamp: Date;
        totalGbMonth: number;
      }
    >();

    // Process all Cost Explorer responses and aggregate by date
    for (const response of costExplorerResponses) {
      for (const result of response.ResultsByTime) {
        const timestamp = new Date(result.TimePeriod.Start);
        const dateKey = `${region}_${timestamp.toISOString().substr(0, 10)}`;

        if (!storageByDateMap.has(dateKey)) {
          storageByDateMap.set(dateKey, {
            region,
            timestamp,
            totalGbMonth: 0,
          });
        }

        const dateEntry = storageByDateMap.get(dateKey);

        // Handle both grouped and total responses
        // When no GroupBy is specified, AWS returns data in Total instead of Groups
        if (result.Groups && result.Groups.length > 0) {
          for (const group of result.Groups) {
            const gbMonth = Number.parseFloat(
              group.Metrics.UsageQuantity.Amount
            );
            dateEntry.totalGbMonth += gbMonth;
          }
        } else if (result.Total?.UsageQuantity?.Amount) {
          // Use Total when Groups is empty
          const gbMonth = Number.parseFloat(result.Total.UsageQuantity.Amount);
          dateEntry.totalGbMonth += gbMonth;
        }
      }
    }

    // Call OxygenIT API for each date
    const results: RDSStorageEmbodiedAggregatedResult[] = [];

    for (const [_, dateEntry] of storageByDateMap) {
      if (dateEntry.totalGbMonth === 0) {
        continue;
      }

      // Duration is 1 day in seconds (86400) since Cost Explorer returns DAILY data
      const durationInSeconds = 24 * 3600;

      // Convert GB-Month (daily prorated) to actual bytes
      // GB-Month from daily granularity = actual_GB / days_in_month
      // So actual_GB = GB-Month * days_in_month (use 30 as approximation)
      const daysInMonth = 30;
      const actualGb = dateEntry.totalGbMonth * daysInMonth;
      const sizeInBytes = Math.round(actualGb * Math.pow(1024, 3));

      try {
        // Call OxygenIT API for embodied metrics
        const embodiedMetrics = await oxygenClient.getRDSEmbodiedMetrics({
          config: {
            size: sizeInBytes,
          },
          duration: durationInSeconds,
        });

        results.push({
          region: dateEntry.region,
          timestamp: dateEntry.timestamp,
          sizeGbMonth: dateEntry.totalGbMonth,
          carbon: embodiedMetrics.carbon,
          kwh: embodiedMetrics.kwh,
        });
      } catch (error) {
        this.rdsStorageLogger.warn(
          `Failed to get embodied metrics for RDS storage in ${region} on ${dateEntry.timestamp.toISOString()}: ${
            error.message
          }`
        );
      }
    }

    return results;
  };
}

/**
 * Aggregated result for RDS Storage embodied carbon metrics
 */
export interface RDSStorageEmbodiedAggregatedResult {
  region: string;
  timestamp: Date;
  sizeGbMonth: number; // Storage size in GB-Month
  carbon: number; // in gCO2eq
  kwh: number; // in kWh
}
