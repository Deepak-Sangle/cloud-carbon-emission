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

export default class EBS implements ICloudService {
  serviceName = "EBS";
  ebsLogger: Logger;

  constructor(private serviceWrapper: ServiceWrapper) {
    this.ebsLogger = new Logger("EBS");
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
    const params = {
      TimePeriod: {
        Start: startDate.toISOString().substr(0, 10),
        End: endDate.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: [
                "EC2: EBS - SSD(gp2)",
                "EC2: EBS - SSD(gp3)",
                "EC2: EBS - SSD(io1)",
                "EC2: EBS - SSD(io2)",
                "EC2: EBS - HDD(sc1)",
                "EC2: EBS - HDD(st1)",
                "EC2: EBS - Magnetic",
              ],
            },
          },
          { Dimensions: { Key: "REGION", Values: [region] } },
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
      awsGroupKey.endsWith("VolumeUsage.gp2") ||
      awsGroupKey.endsWith("VolumeUsage.gp3") ||
      awsGroupKey.endsWith("VolumeUsage.io1") ||
      awsGroupKey.endsWith("VolumeUsage.io2") ||
      awsGroupKey.endsWith("VolumeUsage.piops")
    )
      return DiskType.SSD;
    if (
      awsGroupKey.endsWith("VolumeUsage.st1") ||
      awsGroupKey.endsWith("VolumeUsage.sc1") ||
      awsGroupKey.endsWith("VolumeUsage")
    )
      return DiskType.HDD;
    this.ebsLogger.warn(
      "Unexpected Cost explorer Dimension Name: " + awsGroupKey
    );
    return DiskType.UNKNOWN;
  };

  async getCosts(start: Date, end: Date, region: string): Promise<Cost[]> {
    const params = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: [
                "EC2: EBS - SSD(gp2)",
                "EC2: EBS - SSD(gp3)",
                "EC2: EBS - SSD(io1)",
                "EC2: EBS - SSD(io2)",
                "EC2: EBS - HDD(sc1)",
                "EC2: EBS - HDD(st1)",
                "EC2: EBS - Magnetic",
              ],
            },
          },
          { Dimensions: { Key: "REGION", Values: [region] } },
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

    return await getCostFromCostExplorer(params, this.serviceWrapper);
  }

  /**
   * Get embodied carbon metrics for EBS volumes
   *
   * Fetches EBS usage data from Cost Explorer, extracts volume types and sizes,
   * calls OxygenIT API for embodied carbon calculations, and aggregates results by
   * region, day, and volume type.
   *
   * @param start - Start date for the query
   * @param end - End date for the query
   * @param region - AWS region ID
   * @returns Aggregated embodied metrics by region, day, and volume type
   */
  async getEmbodiedMetrics(
    start: Date,
    end: Date,
    region: string
  ): Promise<EBSEmbodiedAggregatedResult[]> {
    // Use 30-day chunking to fetch data
    const responses = await this.serviceWrapper.getQueryByInterval(
      30,
      this.fetchEBSEmbodiedData,
      start,
      end,
      region
    );

    return responses.flat();
  }

  private fetchEBSEmbodiedData = async (
    start: Date,
    end: Date,
    region: string
  ): Promise<EBSEmbodiedAggregatedResult[]> => {
    // Query Cost Explorer for EBS volume usage grouped by USAGE_TYPE
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: [
                "EC2: EBS - SSD(gp2)",
                "EC2: EBS - SSD(gp3)",
                "EC2: EBS - SSD(io1)",
                "EC2: EBS - SSD(io2)",
                "EC2: EBS - HDD(sc1)",
                "EC2: EBS - HDD(st1)",
                "EC2: EBS - Magnetic",
              ],
            },
          },
          { Dimensions: { Key: "REGION", Values: [region] } },
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

    // Aggregate results by region, day, and volume type
    const aggregationMap = new Map<string, EBSEmbodiedAggregatedResult>();

    // Process all Cost Explorer responses
    for (const response of costExplorerResponses) {
      for (const result of response.ResultsByTime) {
        const timestamp = new Date(result.TimePeriod.Start);
        const dateKey = timestamp.toISOString().substr(0, 10);

        for (const group of result.Groups) {
          const usageType = group.Keys[0];
          const gbMonth = Number.parseFloat(group.Metrics.UsageQuantity.Amount);

          if (gbMonth === 0) {
            continue;
          }

          // Extract volume type from usage type (e.g., "EBS:VolumeUsage.gp2" -> "gp2")
          const volumeType = this.extractVolumeType(usageType);

          if (!volumeType) {
            continue;
          }

          // Convert GB-Month (daily prorated) to actual bytes
          // GB-Month from daily granularity = actual_GB / days_in_month
          // So actual_GB = GB-Month * days_in_month (use 30 as approximation)
          const daysInMonth = 30;
          const sizeInBytes = Math.round(
            gbMonth * daysInMonth * Math.pow(1024, 3)
          );
          // Duration is 1 day in seconds (86400) since Cost Explorer returns DAILY data
          const durationInSeconds = 24 * 3600;

          try {
            // Call OxygenIT API for embodied metrics
            const embodiedMetrics = await oxygenClient.getEBSEmbodiedMetrics({
              config: {
                type: volumeType,
                datacenter: region,
                size: sizeInBytes,
              },
              duration: durationInSeconds,
            });

            // Create aggregation key: region_date_volumeType
            const aggregationKey = `${region}_${dateKey}_${volumeType}`;

            // Aggregate or create new entry
            if (aggregationMap.has(aggregationKey)) {
              const existing = aggregationMap.get(aggregationKey);
              if (existing) {
                existing.sizeGbMonth += gbMonth;
                existing.carbon += embodiedMetrics.carbon;
                existing.kwh += embodiedMetrics.kwh;
              }
            } else {
              aggregationMap.set(aggregationKey, {
                region,
                timestamp,
                volumeType,
                sizeGbMonth: gbMonth,
                carbon: embodiedMetrics.carbon,
                kwh: embodiedMetrics.kwh,
              });
            }
          } catch (error) {
            this.ebsLogger.warn(
              `Failed to get embodied metrics for ${volumeType} in ${region}: ${error.message}`
            );
          }
        }
      }
    }

    return Array.from(aggregationMap.values());
  };

  /**
   * Extract volume type from AWS usage type string
   * E.g., "EBS:VolumeUsage.gp2" -> "gp2", "USE1-EBS:VolumeUsage.st1" -> "st1"
   */
  private extractVolumeType(usageType: string): string | null {
    // Handle patterns like "EBS:VolumeUsage.gp2" or "USE1-EBS:VolumeUsage.st1"
    const match = usageType.match(/VolumeUsage\.(\w+)/);
    if (match && match[1]) {
      return match[1];
    }

    // Handle "VolumeUsage" without a specific type (typically magnetic/standard)
    if (usageType.includes("VolumeUsage") && !usageType.includes(".")) {
      return "standard";
    }

    return null;
  }
}

/**
 * Aggregated result for EBS embodied carbon metrics
 */
export interface EBSEmbodiedAggregatedResult {
  region: string;
  timestamp: Date;
  volumeType: string;
  sizeGbMonth: number; // Storage size in GB-Month
  carbon: number; // in gCO2eq
  kwh: number; // in kWh
}
