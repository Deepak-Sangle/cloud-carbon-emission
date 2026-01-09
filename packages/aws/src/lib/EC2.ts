/*
 * © 2021 Thoughtworks, Inc.
 */

import { OxygenIT } from "@cloud-carbon-footprint/common";
import {
  buildComputeUsages,
  CloudConstants,
  ComputeUsage,
  Cost,
  extractRawComputeUsages,
  RawComputeUsage,
  ServiceWithCPUUtilization,
} from "@cloud-carbon-footprint/core";
import { MetricDataResult } from "aws-sdk/clients/cloudwatch";
import { GetCostAndUsageRequest } from "aws-sdk/clients/costexplorer";

import { getCostFromCostExplorer } from "./CostMapper";

import { AWS_CLOUD_CONSTANTS } from "../domain";
import { ServiceWrapper } from "./ServiceWrapper";

export default class EC2 extends ServiceWithCPUUtilization {
  serviceName = "EC2";

  constructor(private serviceWrapper: ServiceWrapper) {
    super();
  }

  async getUsage(
    start: Date,
    end: Date,
    _region: string
  ): Promise<ComputeUsage[]> {
    const response = await this.serviceWrapper.getQueryByInterval(
      30,
      this.runQuery,
      start,
      end
    );
    return response.flat();
  }

  private runQuery = async (
    start: Date,
    end: Date
  ): Promise<ComputeUsage[]> => {
    const params = {
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        {
          Id: "cpuUtilizationWithEmptyValues",
          Expression:
            "SEARCH('{AWS/EC2,InstanceId} MetricName=\"CPUUtilization\"', 'Average', 3600)",
          ReturnData: false,
        },
        {
          Id: "cpuUtilization",
          Expression: "REMOVE_EMPTY(cpuUtilizationWithEmptyValues)",
        },
        {
          Id: "vCPUs",
          Expression:
            "SEARCH('{AWS/Usage,Resource,Type,Service,Class } Resource=\"vCPU\" MetricName=\"ResourceCount\"', 'Average', 3600)",
        },
      ],
      ScanBy: "TimestampAscending",
    };

    const responses = await this.serviceWrapper.getMetricDataResponses(params);

    const metricDataResults: MetricDataResult[] = responses.flatMap(
      (response) => response.MetricDataResults
    );

    const rawComputeUsages: RawComputeUsage[] = metricDataResults.flatMap(
      extractRawComputeUsages
    );
    const cloudConstants: CloudConstants = {
      avgCpuUtilization: AWS_CLOUD_CONSTANTS.AVG_CPU_UTILIZATION_2020,
    };
    return buildComputeUsages(rawComputeUsages, cloudConstants);
  };

  async getCosts(start: Date, end: Date, region: string): Promise<Cost[]> {
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "REGION",
              Values: [region],
            },
          },
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: ["EC2: Running Hours"],
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
   * Get embodied carbon metrics for EC2 instances
   *
   * Fetches EC2 usage data from Cost Explorer, extracts instance types and running hours,
   * calls OxygenIT API for embodied carbon calculations, and aggregates results by
   * region, day, and instance type.
   *
   * @param start - Start date for the query
   * @param end - End date for the query
   * @param region - AWS region ID
   * @returns Aggregated embodied metrics by region, day, and instance type
   */
  async getEmbodiedMetrics(
    start: Date,
    end: Date,
    region: string
  ): Promise<EC2EmbodiedAggregatedResult[]> {
    // Use 30-day chunking to fetch data
    const responses = await this.serviceWrapper.getQueryByInterval(
      30,
      this.fetchEC2EmbodiedData,
      start,
      end,
      region
    );

    return responses.flat();
  }

  private fetchEC2EmbodiedData = async (
    start: Date,
    end: Date,
    region: string
  ): Promise<EC2EmbodiedAggregatedResult[]> => {
    // Query Cost Explorer for EC2 running hours grouped by USAGE_TYPE
    const params: GetCostAndUsageRequest = {
      TimePeriod: {
        Start: start.toISOString().substr(0, 10),
        End: end.toISOString().substr(0, 10),
      },
      Filter: {
        And: [
          {
            Dimensions: {
              Key: "REGION",
              Values: [region],
            },
          },
          {
            Dimensions: {
              Key: "USAGE_TYPE_GROUP",
              Values: ["EC2: Running Hours"],
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

    // Aggregate results by region, day, and instance type
    const aggregationMap = new Map<string, EC2EmbodiedAggregatedResult>();

    // Process all Cost Explorer responses
    for (const response of costExplorerResponses) {
      for (const result of response.ResultsByTime) {
        const timestamp = new Date(result.TimePeriod.Start);
        const dateKey = timestamp.toISOString().substr(0, 10);

        for (const group of result.Groups) {
          const usageType = group.Keys[0];
          const runningHours = Number.parseFloat(
            group.Metrics.UsageQuantity.Amount
          );

          if (runningHours === 0) {
            continue;
          }

          // Extract instance type from usage type (e.g., "USE2-BoxUsage:t2.micro" -> "t2.micro")
          const instanceType = this.extractInstanceType(usageType);

          if (!instanceType) {
            continue;
          }

          // Convert hours to seconds for OxygenIT API (must be integer)
          const durationInSeconds = Math.round(runningHours * 3600);

          try {
            // Call OxygenIT API for embodied metrics
            const embodiedMetrics = await oxygenClient.getEC2EmbodiedMetrics({
              config: {
                type: instanceType,
                datacenter: region,
              },
              duration: durationInSeconds,
            });

            // Create aggregation key: region_date_instanceType
            const aggregationKey = `${region}_${dateKey}_${instanceType}`;

            // Aggregate or create new entry
            if (aggregationMap.has(aggregationKey)) {
              const existing = aggregationMap.get(aggregationKey);
              if (existing) {
                existing.runningHours += runningHours;
                existing.carbon += embodiedMetrics.carbon;
                existing.kwh += embodiedMetrics.kwh;
              }
            } else {
              aggregationMap.set(aggregationKey, {
                region,
                timestamp,
                instanceType,
                runningHours,
                carbon: embodiedMetrics.carbon,
                kwh: embodiedMetrics.kwh,
              });
            }
          } catch (error) {
            console.warn(
              `Failed to get embodied metrics for ${instanceType} in ${region}: ${error.message}`
            );
          }
        }
      }
    }

    return Array.from(aggregationMap.values());
  };

  /**
   * Extract instance type from AWS usage type string
   * E.g., "USE2-BoxUsage:t2.micro" -> "t2.micro"
   */
  private extractInstanceType(usageType: string): string | null {
    // Handle xlarge instances that might be shortened to 'xl'
    let normalizedUsageType = usageType;
    if (usageType.endsWith("xl")) {
      normalizedUsageType = usageType + "arge";
    }

    // Split by colon and get the instance type part
    const parts = normalizedUsageType.split(":");
    if (parts.length < 2) {
      return null;
    }

    const instanceType = parts[1];

    // Validate instance type format (should contain at least one dot)
    if (!instanceType.includes(".")) {
      return null;
    }

    return instanceType;
  }
}

/**
 * Aggregated result for EC2 embodied carbon metrics
 */
export interface EC2EmbodiedAggregatedResult {
  region: string;
  timestamp: Date;
  instanceType: string;
  runningHours: number;
  carbon: number; // in gCO2eq
  kwh: number; // in kWh
}
