/*
 * © 2021 Thoughtworks, Inc.
 */

export type {
  CalculationConstants,
  CloudProviderConstants,
  EmissionsFactorsByRegion,
} from './CalculationConstants'
export { default as Config, GroupBy } from './Config'
export type { CCFConfig, QUERY_DATE_TYPES } from './Config'
export { default as configLoader, setConfig } from './ConfigLoader'
export type { EmissionRatioResult } from './EmissionRatioResult'
export * from './EmissionsFactors'
export {
  EstimationRequestValidationError,
  PartialDataError,
  RecommendationsRequestValidationError,
} from './Errors'
export { reduceByTimestamp } from './EstimationResult'
export type {
  EstimationResult,
  FootprintResponse,
  ServiceData,
  TagCollection,
} from './EstimationResult'
export * from './helpers'
export { default as Logger } from './Logger'
export type { LookupTableInput, LookupTableOutput } from './LookupTableInput'
export type {
  OnPremiseDataInput,
  OnPremiseDataOutput,
} from './OnPremiseDataInput'
export type {
  ComputeOptimizerRecommendationOption,
  EBSRecommendationOption,
  EC2RecommendationOption,
  LambdaRecommendationOption,
  RecommendationResult,
} from './RecommendationResult'
export {
  AWS_DEFAULT_RECOMMENDATIONS_SERVICE,
  AWS_RECOMMENDATIONS_SERVICES,
} from './RecommendationsService'
export {
  AWS_DEFAULT_RECOMMENDATION_TARGET,
  AWS_RECOMMENDATIONS_TARGETS,
} from './RecommendationTarget'
export type {
  AccountDetails,
  AccountDetailsOrIdList,
  AWSBillingAccountConfig,
  GoogleAuthClient,
} from './Types'

// Database exports
export * from './database'
