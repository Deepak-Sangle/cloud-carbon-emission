/**
 * Constants used per cloud provider for carbon footprint calculations.
 * These values explain how kilowatt-hours and CO2e are computed.
 */
export interface CloudProviderConstants {
  /** Power Usage Effectiveness - accounts for datacenter overhead (cooling, lighting, etc.) */
  pueAverage: number
  /** Region-specific PUE values if available */
  pueByRegion?: { [region: string]: number }
  /** Energy coefficient for SSD storage (watt hours / terabyte hour) */
  ssdCoefficient: number
  /** Energy coefficient for HDD storage (watt hours / terabyte hour) */
  hddCoefficient: number
  /** Energy coefficient for memory (kWh / Gb) */
  memoryCoefficient: number
  /** Energy coefficient for networking (kWh / Gb) */
  networkingCoefficient: number
  /** Average CPU utilization assumption used in calculations */
  averageCpuUtilization: number
  /** Server expected lifespan in hours (used for embodied emissions) */
  serverExpectedLifespan: number
  /** Replication factors by storage service type */
  replicationFactors: { [serviceType: string]: number }
  /** Average minimum watts per vCPU at idle */
  minWattsAverage: number
  /** Average maximum watts per vCPU at full load */
  maxWattsAverage: number
  /** Average memory per physical chip (gigaBytes) */
  memoryAverage?: number
}

/**
 * Emissions factors (carbon intensity) per region for a cloud provider.
 * Values are in metric tons CO2e per kilowatt-hour.
 */
export interface EmissionsFactorsByRegion {
  [region: string]: number
}

/**
 * Complete calculation constants for all cloud providers.
 */
export interface CalculationConstants {
  /** Constants and coefficients used in calculations */
  cloudProviderConstants: {
    aws?: CloudProviderConstants
    gcp?: CloudProviderConstants
    azure?: CloudProviderConstants
    ali?: CloudProviderConstants
  }
  /** Carbon intensity factors by region for each cloud provider (metric tons CO2e / kWh) */
  emissionsFactors: {
    aws?: EmissionsFactorsByRegion
    gcp?: EmissionsFactorsByRegion
    azure?: EmissionsFactorsByRegion
    ali?: EmissionsFactorsByRegion
  }
}
