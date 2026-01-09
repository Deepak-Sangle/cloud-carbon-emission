/*
 * © 2021 Thoughtworks, Inc.
 */

import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import {
  EC2_INSTANCE_TYPES,
  INSTANCE_FAMILY_TO_INSTANCE_TYPE_MAPPING,
} from "./EC2InstanceTypes";
import { convertGramsToMetricTons } from "./helpers";

// Common response type for all embodied metrics
export interface EmbodiedMetricsResponse {
  carbon: number;
  kwh: number;
}

// EC2 specific types
export interface EC2EmbodiedConfig {
  type: string;
  datacenter: string;
}

export interface EC2EmbodiedRequest {
  config: EC2EmbodiedConfig;
  duration: number;
}

// S3 specific types
export interface S3StorageClass {
  class: string;
  size: number;
}

export interface S3EmbodiedConfig {
  datacenter: string;
}

export interface S3EmbodiedMetrics {
  storages: S3StorageClass[];
}

export interface S3EmbodiedRequest {
  config: S3EmbodiedConfig;
  metrics: S3EmbodiedMetrics;
  duration: number;
}

// RDS specific types
export interface RDSEmbodiedConfig {
  size: number;
}

export interface RDSEmbodiedRequest {
  config: RDSEmbodiedConfig;
  duration: number;
}

// EBS specific types
export interface EBSEmbodiedConfig {
  type: string;
  datacenter: string;
  size: number;
}

export interface EBSEmbodiedRequest {
  config: EBSEmbodiedConfig;
  duration: number;
}

// OxygenIT Client Configuration
export interface OxygenITConfig {
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  useLocalFallback?: boolean;
}

/**
 * AWS Emissions Factors by region (metric tons CO2 per kWh)
 * Source: Cloud Carbon Footprint methodology
 */
const AWS_EMISSIONS_FACTORS: { [region: string]: number } = {
  "us-east-1": 0.000379069,
  "us-east-2": 0.000410608,
  "us-west-1": 0.000322167,
  "us-west-2": 0.000322167,
  "us-gov-east-1": 0.000379069,
  "us-gov-west-1": 0.000322167,
  "af-south-1": 0.0009006,
  "ap-east-1": 0.00071,
  "ap-south-1": 0.0007082,
  "ap-south-2": 0.0007082,
  "ap-northeast-3": 0.0004658,
  "ap-northeast-2": 0.0004156,
  "ap-southeast-1": 0.000408,
  "ap-southeast-2": 0.00076,
  "ap-southeast-3": 0.0007177,
  "ap-southeast-4": 0.00076,
  "ap-northeast-1": 0.0004658,
  "ca-central-1": 0.00012,
  "cn-north-1": 0.0005374,
  "cn-northwest-1": 0.0005374,
  "eu-central-1": 0.000311,
  "eu-central-2": 0.000311,
  "eu-west-1": 0.0002786,
  "eu-west-2": 0.000225,
  "eu-south-1": 0.0002134,
  "eu-south-2": 0.0002134,
  "eu-west-3": 0.0000511,
  "eu-north-1": 0.0000088,
  "me-south-1": 0.0005059,
  "me-central-1": 0.0004041,
  "sa-east-1": 0.0000617,
  "il-central-1": 0.00046,
  Unknown: 0.00039278188,
};

/**
 * Server expected lifespan in hours (4 years)
 * Source: Cloud Carbon Footprint methodology
 */
const SERVER_EXPECTED_LIFESPAN_HOURS = 35040;

/**
 * Default scope 3 emissions factor for unknown instance types (metric tons CO2e)
 * This is an average value based on typical instance embodied emissions over server lifetime
 */
const DEFAULT_SCOPE3_EMISSIONS = 1.5;

/**
 * Default vCPU count for unknown instance types
 */
const DEFAULT_VCPU = 4;

/**
 * OxygenIT API Client for calculating embodied carbon metrics for AWS services
 *
 * This class provides methods to fetch embodied carbon emissions and energy consumption
 * for various AWS services including EC2, S3, RDS, and EBS.
 *
 * Features:
 * - Primary: Uses OxygenIT API for accurate embodied emissions data
 * - Fallback: Local calculation using Cloud Carbon Footprint methodology when API fails
 * - Comprehensive instance type support with local data mappings
 *
 * @example
 * ```typescript
 * const client = new OxygenIT({ timeout: 10000 });
 * const ec2Metrics = await client.getEC2EmbodiedMetrics({
 *   config: { type: 't4g.large', datacenter: 'eu-north-1' },
 *   duration: 3600
 * });
 * console.log(`Carbon: ${ec2Metrics.carbon}, kWh: ${ec2Metrics.kwh}`);
 * ```
 */
export class OxygenIT {
  private readonly baseUrl: string;
  private readonly axiosInstance: AxiosInstance;
  private readonly useLocalFallback: boolean;

  // Rate limiting and retry configuration
  private lastRequestTime = 0;
  private readonly minRequestInterval: number; // milliseconds between requests
  private readonly maxRetries: number;
  private readonly initialRetryDelay: number; // milliseconds

  constructor(config: OxygenITConfig = {}) {
    this.baseUrl = config.baseUrl || "https://api-co2.oxygenit.io/v2/services";
    this.useLocalFallback = config.useLocalFallback ?? true;

    // Rate limiting: 100ms gap between requests
    this.minRequestInterval = 100;
    // Retry configuration
    this.maxRetries = 3;
    this.initialRetryDelay = 1000; // 1 second

    const axiosConfig: AxiosRequestConfig = {
      timeout: config.timeout || 30000,
      headers: {
        ...config.headers,
        Accept: "application/json",
        "Content-Type": "application/json",
        token: `${process.env.OXYGENIT_API_KEY}`,
      },
    };

    this.axiosInstance = axios.create(axiosConfig);
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Enforce rate limiting by waiting if necessary
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await this.sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Execute an API request with rate limiting and exponential backoff
   * @param requestFn - The function that makes the actual API request
   * @param context - Description of the request for logging
   */
  private async executeWithRetry<T>(
    requestFn: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // Enforce rate limiting before each request
        await this.enforceRateLimit();

        return await requestFn();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const statusCode = error.response?.status;

          // Don't retry on 500+ server errors - these are unlikely to resolve quickly
          if (statusCode && statusCode >= 500) {
            throw error;
          }

          // For non-500 errors (rate limits, timeouts, etc.), retry with exponential backoff
          if (attempt < this.maxRetries) {
            const delay = this.initialRetryDelay * Math.pow(2, attempt);
            console.warn(
              `OxygenIT API request failed (${context}), attempt ${
                attempt + 1
              }/${this.maxRetries + 1}. ` +
                `Status: ${statusCode || "N/A"}. Retrying in ${delay}ms...`
            );
            await this.sleep(delay);
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Parse an instance type string into its family and size components
   * Handles various formats like:
   * - "t4g.large" -> family: "t4g", size: "large"
   * - "db.m5.xlarge" -> family: "m5", size: "xlarge"
   * - "cache.r6g.large" -> family: "r6g", size: "large"
   */
  private parseInstanceType(instanceType: string): {
    family: string;
    size: string;
  } {
    if (!instanceType) {
      return { family: "", size: "" };
    }

    const parts = instanceType.split(".");

    // Handle different formats
    if (parts.length >= 2) {
      // Standard EC2 format: "t4g.large"
      // Or prefixed format: "db.m5.xlarge", "cache.r6g.large"
      const size = parts[parts.length - 1];
      const family = parts[parts.length - 2];
      return { family: family.toLowerCase(), size: size.toLowerCase() };
    }

    return { family: instanceType.toLowerCase(), size: "" };
  }

  /**
   * Get instance type data from the local mappings
   * Returns [vCPUs, memory, scope3_emissions] or null if not found
   */
  private getInstanceTypeData(instanceType: string): number[] | null {
    const { family, size } = this.parseInstanceType(instanceType);

    if (!family || !size) {
      return null;
    }

    // Check primary EC2 instance types mapping
    if (EC2_INSTANCE_TYPES[family]?.[size]) {
      return EC2_INSTANCE_TYPES[family][size];
    }

    // Check special instance family mappings
    if (INSTANCE_FAMILY_TO_INSTANCE_TYPE_MAPPING[family]?.[size]) {
      return INSTANCE_FAMILY_TO_INSTANCE_TYPE_MAPPING[family][size];
    }

    return null;
  }

  /**
   * Get the largest instance in a family (by vCPU count)
   * This is needed for proportional allocation of embodied emissions
   */
  private getLargestInstanceInFamily(family: string): number {
    const normalizedFamily = family.toLowerCase();
    const familyData =
      EC2_INSTANCE_TYPES[normalizedFamily] ||
      INSTANCE_FAMILY_TO_INSTANCE_TYPE_MAPPING[normalizedFamily];

    if (!familyData) {
      return DEFAULT_VCPU;
    }

    const instances = Object.values(familyData);
    if (instances.length === 0) {
      return DEFAULT_VCPU;
    }

    // Find the instance with the most vCPUs (first element in each array)
    const largestVcpu = Math.max(...instances.map((data) => data[0]));
    return largestVcpu || DEFAULT_VCPU;
  }

  /**
   * Get emissions factor for a region
   */
  private getEmissionsFactor(region: string): number {
    const normalizedRegion = region.toLowerCase();
    return (
      AWS_EMISSIONS_FACTORS[normalizedRegion] ||
      AWS_EMISSIONS_FACTORS["Unknown"]
    );
  }

  /**
   * Calculate kWh from carbon (metric tons) using regional emissions factor
   * Formula: kWh = CO2e (metric tons) / emissions_factor (metric tons/kWh)
   */
  private calculateKwhFromCarbon(carbonMt: number, region: string): number {
    const emissionsFactor = this.getEmissionsFactor(region);
    return emissionsFactor > 0 ? carbonMt / emissionsFactor : 0;
  }

  /**
   * Calculate embodied emissions locally using the Cloud Carbon Footprint methodology
   *
   * Formula: CO2e = scopeThreeEmissions * (usageTimePeriod / serverExpectedLifespan) * (instancevCpu / largestInstancevCpu)
   * Source: https://github.com/Green-Software-Foundation/software_carbon_intensity
   *
   * @param instanceType - The EC2 instance type (e.g., "t4g.large")
   * @param region - The AWS region (e.g., "eu-north-1")
   * @param durationSeconds - Duration of usage in seconds
   */
  private calculateEmbodiedEmissionsLocally(
    instanceType: string,
    region: string,
    durationSeconds: number
  ): EmbodiedMetricsResponse {
    const instanceData = this.getInstanceTypeData(instanceType);
    const { family } = this.parseInstanceType(instanceType);

    // Get instance characteristics
    let instancevCpu: number;
    let scopeThreeEmissions: number;

    if (instanceData) {
      instancevCpu = instanceData[0];
      scopeThreeEmissions = instanceData[2];
    } else {
      // Use defaults for unknown instance types
      instancevCpu = DEFAULT_VCPU;
      scopeThreeEmissions = DEFAULT_SCOPE3_EMISSIONS;
      console.warn(
        `Unknown instance type "${instanceType}", using default values for embodied emissions calculation`
      );
    }

    const largestInstancevCpu = this.getLargestInstanceInFamily(family);

    // Convert duration from seconds to hours
    const usageTimePeriodHours = durationSeconds / 3600;

    // Calculate CO2e using the Green Software Foundation formula
    // scopeThreeEmissions is in metric tons CO2e (despite older comments saying kg)
    // Values like 1.02 mtCO2e are reasonable for server embodied emissions over its lifetime
    const co2eMetricTons =
      scopeThreeEmissions *
      (usageTimePeriodHours / SERVER_EXPECTED_LIFESPAN_HOURS) *
      (instancevCpu / largestInstancevCpu);

    // Calculate equivalent kWh using the regional emissions factor
    // kWh = CO2e (metric tons) / emissions_factor (metric tons/kWh)
    const emissionsFactor = this.getEmissionsFactor(region);
    const kwh = emissionsFactor > 0 ? co2eMetricTons / emissionsFactor : 0;

    return {
      carbon: co2eMetricTons,
      kwh: kwh,
    };
  }

  /**
   * Get embodied carbon metrics for AWS EC2 instances
   *
   * This method first attempts to fetch data from the OxygenIT API.
   * If the API fails (e.g., unknown instance type), it falls back to local calculation
   * using the Cloud Carbon Footprint methodology.
   *
   * @param request - EC2 embodied metrics request with instance type, datacenter, and duration
   * @returns Promise resolving to carbon (in metric tons CO2e) and energy (in kWh) metrics
   *
   * @example
   * ```typescript
   * const metrics = await client.getEC2EmbodiedMetrics({
   *   config: { type: 't4g.large', datacenter: 'eu-north-1' },
   *   duration: 3600 // 1 hour in seconds
   * });
   * ```
   */
  async getEC2EmbodiedMetrics(
    request: EC2EmbodiedRequest
  ): Promise<EmbodiedMetricsResponse> {
    // no oxygenit api call, this is better
    return this.calculateEmbodiedEmissionsLocally(
      request.config.type,
      request.config.datacenter,
      request.duration
    );
  }

  /**
   * Get embodied carbon metrics for AWS S3 storage
   *
   * @param request - S3 embodied metrics request with datacenter, storage classes, and duration
   * @returns Promise resolving to carbon (in metric tons CO2e) and energy (in kWh) metrics
   *
   * @example
   * ```typescript
   * const metrics = await client.getS3EmbodiedMetrics({
   *   config: { datacenter: 'eu-north-1' },
   *   metrics: {
   *     storages: [
   *       { class: 'EXPRESS_ONEZONE', size: 4294967296 }
   *     ]
   *   },
   *   duration: 3600
   * });
   * ```
   */
  async getS3EmbodiedMetrics(
    request: S3EmbodiedRequest
  ): Promise<EmbodiedMetricsResponse> {
    return this.executeWithRetry(async () => {
      const url = `${this.baseUrl}/aws-s3/get-embodied`;
      const response = await this.axiosInstance.post<EmbodiedMetricsResponse>(
        url,
        request
      );
      // OxygenIT API returns carbon in grams, convert to metric tons for consistency
      const carbonMt = convertGramsToMetricTons(response.data.carbon);
      // Calculate kwh from carbon if not provided (use average emissions factor)
      const kwh =
        response.data.kwh ??
        this.calculateKwhFromCarbon(carbonMt, request.config.datacenter);
      return {
        carbon: carbonMt,
        kwh: kwh,
      };
    }, `S3 ${request.config.datacenter}`);
  }

  /**
   * Get embodied carbon metrics for AWS RDS databases
   *
   * @param request - RDS embodied metrics request with size and duration
   * @returns Promise resolving to carbon (in metric tons CO2e) and energy (in kWh) metrics
   *
   * @example
   * ```typescript
   * const metrics = await client.getRDSEmbodiedMetrics({
   *   config: { size: 30000000 },
   *   duration: 3600
   * });
   * ```
   */
  async getRDSEmbodiedMetrics(
    request: RDSEmbodiedRequest
  ): Promise<EmbodiedMetricsResponse> {
    return this.executeWithRetry(async () => {
      const url = `${this.baseUrl}/aws-rds/get-embodied`;
      const response = await this.axiosInstance.post<EmbodiedMetricsResponse>(
        url,
        request
      );
      // OxygenIT API returns carbon in grams, convert to metric tons for consistency
      const carbonMt = convertGramsToMetricTons(response.data.carbon);
      // RDS API doesn't include datacenter, use average emissions factor for kwh calculation
      const kwh =
        response.data.kwh ?? this.calculateKwhFromCarbon(carbonMt, "Unknown");
      return {
        carbon: carbonMt,
        kwh: kwh,
      };
    }, `RDS storage`);
  }

  /**
   * Get embodied carbon metrics for AWS EBS volumes
   *
   * @param request - EBS embodied metrics request with type, datacenter, size, and duration
   * @returns Promise resolving to carbon (in metric tons CO2e) and energy (in kWh) metrics
   *
   * @example
   * ```typescript
   * const metrics = await client.getEBSEmbodiedMetrics({
   *   config: {
   *     type: 'st1',
   *     datacenter: 'eu-west-1',
   *     size: 30000000
   *   },
   *   duration: 3600
   * });
   * ```
   */
  async getEBSEmbodiedMetrics(
    request: EBSEmbodiedRequest
  ): Promise<EmbodiedMetricsResponse> {
    return this.executeWithRetry(async () => {
      const url = `${this.baseUrl}/aws-ebs/get-embodied`;
      const response = await this.axiosInstance.post<EmbodiedMetricsResponse>(
        url,
        request
      );
      // OxygenIT API returns carbon in grams, convert to metric tons for consistency
      const carbonMt = convertGramsToMetricTons(response.data.carbon);
      // Calculate kwh from carbon if not provided
      const kwh =
        response.data.kwh ??
        this.calculateKwhFromCarbon(carbonMt, request.config.datacenter);
      return {
        carbon: carbonMt,
        kwh: kwh,
      };
    }, `EBS ${request.config.type}`);
  }

  /**
   * Calculate embodied emissions directly using local data (bypasses API)
   * Useful when you want to ensure consistent calculations without API dependency
   *
   * @param instanceType - The EC2 instance type (e.g., "t4g.large")
   * @param region - The AWS region (e.g., "eu-north-1")
   * @param durationSeconds - Duration of usage in seconds
   */
  calculateEmbodiedEmissions(
    instanceType: string,
    region: string,
    durationSeconds: number
  ): EmbodiedMetricsResponse {
    return this.calculateEmbodiedEmissionsLocally(
      instanceType,
      region,
      durationSeconds
    );
  }

  /**
   * Check if an instance type is supported by the local calculation
   */
  isInstanceTypeSupported(instanceType: string): boolean {
    return this.getInstanceTypeData(instanceType) !== null;
  }

  /**
   * Get a list of all supported instance families
   */
  getSupportedInstanceFamilies(): string[] {
    return [
      ...Object.keys(EC2_INSTANCE_TYPES),
      ...Object.keys(INSTANCE_FAMILY_TO_INSTANCE_TYPE_MAPPING),
    ];
  }

  /**
   * Get instance type details (vCPUs, memory, scope3 emissions in metric tons CO2e)
   */
  getInstanceTypeDetails(instanceType: string): {
    vCpus: number;
    memoryGb: number;
    scope3EmissionsMtCO2e: number;
  } | null {
    const data = this.getInstanceTypeData(instanceType);
    if (!data) return null;

    return {
      vCpus: data[0],
      memoryGb: data[1],
      scope3EmissionsMtCO2e: data[2],
    };
  }
}

export default OxygenIT;
