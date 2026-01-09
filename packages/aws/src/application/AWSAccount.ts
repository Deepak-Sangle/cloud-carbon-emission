/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  Athena,
  CloudWatch,
  CloudWatchLogs,
  CostExplorer,
  Credentials,
  Glue,
  S3 as S3Service,
} from "aws-sdk";
import { ServiceConfigurationOptions } from "aws-sdk/lib/service";

import {
  AWS_RECOMMENDATIONS_TARGETS,
  configLoader,
  EstimationResult,
  GroupBy,
  Logger,
  LookupTableInput,
  LookupTableOutput,
  RecommendationResult,
} from "@cloud-carbon-footprint/common";
import {
  CloudProviderAccount,
  ComputeEstimator,
  EmbodiedEmissionsEstimator,
  ICloudService,
  MemoryEstimator,
  NetworkingEstimator,
  Region,
  StorageEstimator,
  UnknownEstimator,
} from "@cloud-carbon-footprint/core";

import {
  AthenaConfig,
  CostAndUsageReports,
  EBS,
  EC2,
  ElastiCache,
  Lambda,
  RDS,
  RDSComputeService,
  RDSStorage,
  S3,
  ServiceWrapper,
} from "../lib";

import AWSCredentialsProvider from "./AWSCredentialsProvider";

import {
  AWS_CLOUD_CONSTANTS,
  AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
} from "../domain";
import { Recommendations } from "../lib/Recommendations";

export default class AWSAccount extends CloudProviderAccount {
  private readonly credentials: Credentials;
  private readonly athenaConfig?: AthenaConfig;

  private readonly logger: Logger;
  constructor(
    public id: string,
    public name: string,
    private regions: string[],
    athenaConfig?: AthenaConfig
  ) {
    super();
    this.logger = new Logger(`AWSAccount-${id}`);
    this.credentials = AWSCredentialsProvider.create(id);
    this.athenaConfig = athenaConfig;
  }

  async getDataForRegions(
    startDate: Date,
    endDate: Date,
    grouping: GroupBy
  ): Promise<EstimationResult[]> {
    const results: EstimationResult[][] = [];
    for (const regionId of this.regions) {
      // break the start and enddate in 30 days chunks (so if a year is given it makes 12 requests)
      // process them in reverse order (from end to start) to get recent data first
      let chunkEnd = new Date(endDate);
      let chunkStart = new Date(chunkEnd);
      const finalStart = new Date(startDate);

      while (chunkEnd > finalStart) {
        chunkStart = new Date(chunkEnd);
        chunkStart.setDate(chunkStart.getDate() - 30);
        if (chunkStart < finalStart) chunkStart = new Date(finalStart);

        try {
          this.logger.info(
            `Getting data for region ${regionId} from ${chunkStart} to ${chunkEnd}`
          );
          const regionEstimates: EstimationResult[] =
            await this.getDataForRegion(
              regionId,
              chunkStart,
              chunkEnd,
              grouping
            );
          this.logger.info(
            `Got ${regionEstimates.length} estimates for region ${regionId} from ${chunkStart} to ${chunkEnd}`
          );
          results.push(regionEstimates);
        } catch (error) {
          this.logger.warn(
            `Failed to get data for region ${regionId} from ${chunkStart} to ${chunkEnd}: ${error.message}`
          );
          // This most probably means that we can't access data that old
          // so we break the loop
          break;
        }

        chunkEnd = new Date(chunkStart);
      }
    }

    return results.flat();
  }

  getDataForRegion(
    regionId: string,
    startDate: Date,
    endDate: Date,
    grouping: GroupBy
  ): Promise<EstimationResult[]> {
    const awsServices = this.getServices(regionId);
    const awsConstants = {
      minWatts: AWS_CLOUD_CONSTANTS.MIN_WATTS_AVG,
      maxWatts: AWS_CLOUD_CONSTANTS.MAX_WATTS_AVG,
      powerUsageEffectiveness: AWS_CLOUD_CONSTANTS.getPUE(),
    };
    const region = new Region(
      regionId,
      awsServices,
      AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
      awsConstants
    );
    return this.getRegionData(
      configLoader().AWS.NAME,
      region,
      startDate,
      endDate,
      grouping
    );
  }

  getServices(regionId: string): ICloudService[] {
    return configLoader().AWS.CURRENT_SERVICES.map(({ key }) => {
      return this.getService(key, regionId, this.credentials);
    });
  }

  async getDataForRecommendations(
    recommendationTarget: AWS_RECOMMENDATIONS_TARGETS
  ): Promise<RecommendationResult[]> {
    const serviceWrapper = this.createServiceWrapper(
      this.getServiceConfigurationOptions(
        configLoader().AWS.ATHENA_REGION,
        this.credentials
      )
    );

    return await Recommendations.getRecommendations(
      recommendationTarget,
      serviceWrapper
    );
  }

  async getDataFromCostAndUsageReports(
    startDate: Date,
    endDate: Date,
    grouping: GroupBy
  ): Promise<EstimationResult[]> {
    // Use athenaConfig region if available, otherwise fall back to global config
    const athenaRegion = this.athenaConfig
      ? this.regions[0] // For billing accounts, region is passed via constructor
      : configLoader().AWS.ATHENA_REGION;

    const costAndUsageReportsService = new CostAndUsageReports(
      new ComputeEstimator(),
      new StorageEstimator(AWS_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AWS_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AWS_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AWS_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AWS_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AWS_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN
      ),
      this.createServiceWrapper(
        this.getServiceConfigurationOptions(athenaRegion, this.credentials)
      ),
      this.athenaConfig
    );
    return await costAndUsageReportsService.getEstimates(
      startDate,
      endDate,
      grouping
    );
  }

  static async getCostAndUsageReportsDataFromInputData(
    inputData: LookupTableInput[]
  ): Promise<LookupTableOutput[]> {
    const costAndUsageReportsService = new CostAndUsageReports(
      new ComputeEstimator(),
      new StorageEstimator(AWS_CLOUD_CONSTANTS.SSDCOEFFICIENT),
      new StorageEstimator(AWS_CLOUD_CONSTANTS.HDDCOEFFICIENT),
      new NetworkingEstimator(AWS_CLOUD_CONSTANTS.NETWORKING_COEFFICIENT),
      new MemoryEstimator(AWS_CLOUD_CONSTANTS.MEMORY_COEFFICIENT),
      new UnknownEstimator(AWS_CLOUD_CONSTANTS.ESTIMATE_UNKNOWN_USAGE_BY),
      new EmbodiedEmissionsEstimator(
        AWS_CLOUD_CONSTANTS.SERVER_EXPECTED_LIFESPAN
      )
    );
    return await costAndUsageReportsService.getEstimatesFromInputData(
      inputData
    );
  }

  private getService(
    key: string,
    region: string,
    credentials: Credentials
  ): ICloudService {
    if (this.services[key] === undefined)
      throw new Error("Unsupported service: " + key);
    const options = this.getServiceConfigurationOptions(region, credentials);
    return this.services[key](options);
  }

  private getServiceConfigurationOptions(
    region: string,
    credentials: Credentials
  ): ServiceConfigurationOptions {
    return {
      region: region,
      credentials: credentials,
    };
  }

  private createServiceWrapper(options: ServiceConfigurationOptions) {
    return new ServiceWrapper(
      new CloudWatch(options),
      new CloudWatchLogs(options),
      new CostExplorer({
        region: configLoader().AWS.IS_AWS_GLOBAL
          ? "us-east-1"
          : "cn-northwest-1",
        credentials: options.credentials,
      }),
      new S3Service(options),
      new Athena(options),
      new Glue(options)
    );
  }

  /**
   * Get embodied carbon metrics for all configured regions
   *
   * @param startDate - Start date for the query
   * @param endDate - End date for the query
   * @returns Aggregated embodied metrics for all regions
   */
  async getEmbodiedMetricsForRegions(
    startDate: Date,
    endDate: Date
  ): Promise<EmbodiedMetricsAggregatedResult[]> {
    const results: EmbodiedMetricsAggregatedResult[][] = [];

    for (const regionId of this.regions) {
      try {
        this.logger.info(
          `Getting embodied metrics for region ${regionId} from ${startDate} to ${endDate}`
        );
        const regionResults = await this.getEmbodiedMetricsForRegion(
          regionId,
          startDate,
          endDate
        );
        this.logger.info(
          `Got ${regionResults.length} embodied metrics for region ${regionId}`
        );
        results.push(regionResults);
      } catch (error) {
        this.logger.warn(
          `Failed to get embodied metrics for region ${regionId}: ${error.message}`
        );
      }
    }

    return results.flat();
  }

  /**
   * Get embodied carbon metrics for a specific region
   *
   * @param regionId - AWS region ID
   * @param startDate - Start date for the query
   * @param endDate - End date for the query
   * @returns Aggregated embodied metrics for the region
   */
  async getEmbodiedMetricsForRegion(
    regionId: string,
    startDate: Date,
    endDate: Date
  ): Promise<EmbodiedMetricsAggregatedResult[]> {
    const options = this.getServiceConfigurationOptions(
      regionId,
      this.credentials
    );

    const results: EmbodiedMetricsAggregatedResult[] = [];

    // EC2 embodied metrics
    try {
      const ec2Service = new EC2(this.createServiceWrapper(options));
      if (ec2Service.getEmbodiedMetrics) {
        const ec2Results = await ec2Service.getEmbodiedMetrics(
          startDate,
          endDate,
          regionId
        );
        for (const result of ec2Results) {
          results.push({
            timestamp: result.timestamp,
            region: result.region,
            serviceName: "EC2",
            serviceType: result.instanceType,
            usageAmount: result.runningHours,
            usageUnit: "Hours",
            co2e: result.carbon,
            kilowattHours: result.kwh,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to get EC2 embodied metrics: ${error.message}`);
    }

    // EBS embodied metrics
    try {
      const ebsService = new EBS(this.createServiceWrapper(options));
      if (ebsService.getEmbodiedMetrics) {
        const ebsResults = await ebsService.getEmbodiedMetrics(
          startDate,
          endDate,
          regionId
        );
        for (const result of ebsResults) {
          results.push({
            timestamp: result.timestamp,
            region: result.region,
            serviceName: "EBS",
            serviceType: result.volumeType,
            usageAmount: result.sizeGbMonth,
            usageUnit: "GB-Month",
            co2e: result.carbon,
            kilowattHours: result.kwh,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to get EBS embodied metrics: ${error.message}`);
    }

    // S3 embodied metrics
    try {
      const s3Service = new S3(this.createServiceWrapper(options));
      if (s3Service.getEmbodiedMetrics) {
        const s3Results = await s3Service.getEmbodiedMetrics(
          startDate,
          endDate,
          regionId
        );
        for (const result of s3Results) {
          // S3 has multiple storage classes per day, create a summary entry
          const storageClassSummary = result.storageClasses
            .map((sc) => `${sc.class}:${sc.sizeGbMonth.toFixed(2)}GB`)
            .join(", ");
          results.push({
            timestamp: result.timestamp,
            region: result.region,
            serviceName: "S3",
            serviceType: storageClassSummary,
            usageAmount: result.totalSizeGbMonth,
            usageUnit: "GB-Month",
            co2e: result.carbon,
            kilowattHours: result.kwh,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to get S3 embodied metrics: ${error.message}`);
    }

    // RDS embodied metrics (storage only)
    try {
      const rdsService = new RDS(
        new RDSComputeService(this.createServiceWrapper(options)),
        new RDSStorage(this.createServiceWrapper(options))
      );
      if (rdsService.getEmbodiedMetrics) {
        const rdsResults = await rdsService.getEmbodiedMetrics(
          startDate,
          endDate,
          regionId
        );
        for (const result of rdsResults) {
          results.push({
            timestamp: result.timestamp,
            region: result.region,
            serviceName: "RDS",
            serviceType: "Storage",
            usageAmount: result.sizeGbMonth,
            usageUnit: "GB-Month",
            co2e: result.carbon,
            kilowattHours: result.kwh,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to get RDS embodied metrics: ${error.message}`);
    }

    return results;
  }

  private services: {
    [id: string]: (options: ServiceConfigurationOptions) => ICloudService;
  } = {
    ebs: (options) => {
      return new EBS(this.createServiceWrapper(options));
    },
    s3: (options) => {
      return new S3(this.createServiceWrapper(options));
    },
    ec2: (options) => {
      return new EC2(this.createServiceWrapper(options));
    },
    elasticache: (options) => {
      return new ElastiCache(this.createServiceWrapper(options));
    },
    rds: (options) => {
      return new RDS(
        new RDSComputeService(this.createServiceWrapper(options)),
        new RDSStorage(this.createServiceWrapper(options))
      );
    },
    lambda: (options) => {
      return new Lambda(120000, 1000, this.createServiceWrapper(options));
    },
  };
}

/**
 * Unified result type for embodied carbon metrics across all AWS services
 */
export interface EmbodiedMetricsAggregatedResult {
  timestamp: Date;
  region: string;
  serviceName: string;
  serviceType: string; // EC2 instance type, EBS volume type, S3 storage class, etc.
  usageAmount: number;
  usageUnit: string; // "Hours", "GB-Month", etc.
  co2e: number; // in gCO2eq
  kilowattHours: number; // in kWh
}
