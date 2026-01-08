/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  ALI_CLOUD_CONSTANTS,
  ALI_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
  AliAccount,
} from '@cloud-carbon-footprint/ali'
import {
  AWS_CLOUD_CONSTANTS,
  AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
  AWSAccount,
} from '@cloud-carbon-footprint/aws'
import {
  AZURE_CLOUD_CONSTANTS,
  AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
  AzureAccount,
} from '@cloud-carbon-footprint/azure'
import {
  AccountDetails,
  AWSBillingAccountConfig,
  CalculationConstants,
  CloudProviderConstants,
  configLoader,
  EmissionRatioResult,
  EstimationResult,
  FootprintResponse,
  GroupBy,
  Logger,
  LookupTableInput,
  LookupTableOutput,
  OnPremiseDataInput,
  OnPremiseDataOutput,
  RecommendationResult,
  reduceByTimestamp,
} from '@cloud-carbon-footprint/common'
import { CloudConstantsByProvider } from '@cloud-carbon-footprint/core'
import {
  GCP_CLOUD_CONSTANTS,
  GCPAccount,
  getGCPEmissionsFactors,
} from '@cloud-carbon-footprint/gcp'
import { OnPremise } from '@cloud-carbon-footprint/on-premise'
import { promises as fs } from 'fs'

import { EstimationRequest, RecommendationRequest } from './CreateValidRequest'
import { includeCloudProviders } from './common/helpers'

export const recommendationsMockPath = 'recommendations.mock.json'

export default class App {
  /**
   * Converts cloud provider constants to the API response format
   */
  private static toCloudProviderConstants(
    constants: CloudConstantsByProvider,
  ): CloudProviderConstants {
    return {
      pueAverage: constants.PUE_AVG,
      pueByRegion: constants.PUE_TRAILING_TWELVE_MONTH,
      ssdCoefficient: constants.SSDCOEFFICIENT,
      hddCoefficient: constants.HDDCOEFFICIENT,
      memoryCoefficient: constants.MEMORY_COEFFICIENT,
      networkingCoefficient: constants.NETWORKING_COEFFICIENT,
      averageCpuUtilization: constants.AVG_CPU_UTILIZATION_2020,
      serverExpectedLifespan: constants.SERVER_EXPECTED_LIFESPAN,
      replicationFactors: constants.REPLICATION_FACTORS,
      minWattsAverage: constants.MIN_WATTS_AVG || constants.MIN_WATTS_MEDIAN,
      maxWattsAverage: constants.MAX_WATTS_AVG || constants.MAX_WATTS_MEDIAN,
      memoryAverage: constants.MEMORY_AVG,
    }
  }

  /**
   * Gets the calculation constants used to compute carbon footprint estimates.
   * Includes PUE factors, emissions intensity factors, and other coefficients.
   */
  getCalculationConstants(): CalculationConstants {
    const config = configLoader()

    const calculationConstants: CalculationConstants = {
      cloudProviderConstants: {},
      emissionsFactors: {},
    }

    // Add AWS constants if enabled
    if (config.AWS?.INCLUDE_ESTIMATES) {
      calculationConstants.cloudProviderConstants.aws =
        App.toCloudProviderConstants(AWS_CLOUD_CONSTANTS)
      calculationConstants.emissionsFactors.aws =
        AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH
    }

    // Add GCP constants if enabled
    if (config.GCP?.INCLUDE_ESTIMATES) {
      calculationConstants.cloudProviderConstants.gcp =
        App.toCloudProviderConstants(GCP_CLOUD_CONSTANTS)
      calculationConstants.emissionsFactors.gcp = getGCPEmissionsFactors()
    }

    // Add Azure constants if enabled
    if (config.AZURE?.INCLUDE_ESTIMATES) {
      calculationConstants.cloudProviderConstants.azure =
        App.toCloudProviderConstants(AZURE_CLOUD_CONSTANTS)
      calculationConstants.emissionsFactors.azure =
        AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH
    }

    // Add Ali constants if enabled
    if (config.ALI?.INCLUDE_ESTIMATES) {
      calculationConstants.cloudProviderConstants.ali =
        App.toCloudProviderConstants(ALI_CLOUD_CONSTANTS)
      calculationConstants.emissionsFactors.ali =
        ALI_EMISSIONS_FACTORS_METRIC_TON_PER_KWH
    }

    return calculationConstants
  }

  async getCostAndEstimates(
    request: EstimationRequest,
  ): Promise<FootprintResponse> {
    const appLogger = new Logger('App')
    const { startDate, endDate, accounts, cloudProviderToSeed } = request
    const grouping = request.groupBy as GroupBy
    const config = configLoader()
    includeCloudProviders(cloudProviderToSeed, config)
    const { AWS, GCP, AZURE, ALI } = config
    appLogger.info(`Using config: ${JSON.stringify(config, null, 2)}`)
    if (configLoader().ELECTRICITY_MAPS_TOKEN)
      appLogger.info('Using Electricity Maps')
    if (process.env.TEST_MODE) {
      return {
        estimates: [],
        calculationConstants: this.getCalculationConstants(),
      }
    }

    const AWSEstimatesByRegion: EstimationResult[][] = []
    if (AWS?.INCLUDE_ESTIMATES) {
      appLogger.info('Starting AWS Estimations')
      if (AWS?.USE_BILLING_DATA) {
        // Check for multiple billing accounts configuration
        const billingAccounts = AWS.billingAccounts as AWSBillingAccountConfig[]
        if (billingAccounts && billingAccounts.length > 0) {
          // Multi-account billing data mode
          appLogger.info(
            `Processing ${billingAccounts.length} AWS billing accounts`,
          )
          for (const billingAccount of billingAccounts) {
            appLogger.info(
              `Processing AWS billing account: ${billingAccount.name}`,
            )
            const athenaConfig = {
              dataBaseName: billingAccount.athenaDbName,
              tableName: billingAccount.athenaDbTable,
              queryResultsLocation: billingAccount.athenaQueryResultLocation,
            }
            const estimates = await new AWSAccount(
              billingAccount.id,
              billingAccount.name,
              [billingAccount.athenaRegion],
              athenaConfig,
            ).getDataFromCostAndUsageReports(startDate, endDate, grouping)
            AWSEstimatesByRegion.push(estimates)
          }
        } else {
          // Single billing account (backward compatible)
          const estimates = await new AWSAccount(
            AWS.BILLING_ACCOUNT_ID,
            AWS.BILLING_ACCOUNT_NAME,
            [AWS.ATHENA_REGION],
          ).getDataFromCostAndUsageReports(startDate, endDate, grouping)
          AWSEstimatesByRegion.push(estimates)
        }
      } else if (AWS?.accounts.length) {
        // Resolve AWS Estimates synchronously in order to avoid hitting API limits
        const awsAccounts = AWS.accounts as AccountDetails[]
        for (const account of awsAccounts) {
          const estimates = await new AWSAccount(
            account.id,
            account.name,
            AWS.CURRENT_REGIONS,
          ).getDataForRegions(startDate, endDate, grouping)
          AWSEstimatesByRegion.push(estimates)
        }
      }
      appLogger.info('Finished AWS Estimations')
    }

    const GCPEstimatesByRegion: EstimationResult[][] = []
    if (GCP?.INCLUDE_ESTIMATES) {
      appLogger.info('Starting GCP Estimations')
      if (GCP?.USE_BILLING_DATA) {
        const estimates = await new GCPAccount(
          GCP.BILLING_PROJECT_ID,
          GCP.BILLING_PROJECT_NAME,
          [],
        ).getDataFromBillingExportTable(startDate, endDate, grouping)
        GCPEstimatesByRegion.push(estimates)
      } else if (GCP?.projects.length) {
        const googleProjectDetails = GCP.projects as AccountDetails[]
        // Resolve GCP Estimates asynchronously
        for (const project of googleProjectDetails) {
          const estimates = await Promise.all(
            await new GCPAccount(
              project.id,
              project.name,
              GCP.CURRENT_REGIONS,
            ).getDataForRegions(startDate, endDate, grouping),
          )
          GCPEstimatesByRegion.push(estimates)
        }
      }
      appLogger.info('Finished GCP Estimations')
    }

    const AzureEstimatesByRegion: EstimationResult[][] = []
    if (AZURE?.INCLUDE_ESTIMATES && AZURE?.USE_BILLING_DATA) {
      appLogger.info('Starting Azure Estimations')
      const azureAccount = new AzureAccount()
      await azureAccount.initializeAccount()
      const estimates = await azureAccount.getDataFromConsumptionManagement(
        startDate,
        endDate,
        grouping,
        accounts,
      )
      AzureEstimatesByRegion.push(estimates)
      appLogger.info('Finished Azure Estimations')
    }

    const AliEstimates: EstimationResult[][] = []
    if (ALI.INCLUDE_ESTIMATES && ALI.authentication?.accessKeyId) {
      appLogger.info('Starting Ali Cloud Estimations')
      const aliAccount = new AliAccount()
      const estimates = await aliAccount.getDataFromCostAndUsageReports(
        startDate,
        endDate,
        grouping,
      )
      AliEstimates.push(estimates)
      appLogger.info('Finished Ali Cloud Estimations')
    }

    const estimates = reduceByTimestamp(
      AWSEstimatesByRegion.flat()
        .flat()
        .concat(GCPEstimatesByRegion.flat())
        .concat(AzureEstimatesByRegion.flat())
        .concat(AliEstimates.flat()),
    )

    return {
      estimates,
      calculationConstants: this.getCalculationConstants(),
    }
  }

  getEmissionsFactors(): EmissionRatioResult[] {
    const CLOUD_PROVIDER_EMISSIONS_FACTORS_METRIC_TON_PER_KWH = {
      AWS: AWS_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
      GCP: getGCPEmissionsFactors(),
      AZURE: AZURE_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
      ALI: ALI_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
    }

    return Object.entries(
      CLOUD_PROVIDER_EMISSIONS_FACTORS_METRIC_TON_PER_KWH,
    ).reduce((emissionDataResult, entry) => {
      const [cloudProvider, emissionsFactors] = entry
      Object.keys(emissionsFactors).forEach((region) => {
        emissionDataResult.push({
          cloudProvider,
          region,
          mtPerKwHour: emissionsFactors[region],
        })
      })
      return emissionDataResult
    }, [])
  }

  async getRecommendations(
    request: RecommendationRequest,
  ): Promise<RecommendationResult[]> {
    if (process.env.TEST_MODE) {
      const recommendationsMock = await fs.readFile(
        recommendationsMockPath,
        'utf8',
      )
      return JSON.parse(recommendationsMock)
    }
    const config = configLoader()
    const AWS = config.AWS
    const GCP = config.GCP
    const AZURE = config.AZURE
    const allRecommendations: RecommendationResult[][] = []

    const AWSRecommendations: RecommendationResult[][] = []
    if (AWS.USE_BILLING_DATA) {
      // Check for multiple billing accounts configuration
      const billingAccounts = AWS.billingAccounts as AWSBillingAccountConfig[]
      if (billingAccounts && billingAccounts.length > 0) {
        // Multi-account billing data mode
        for (const billingAccount of billingAccounts) {
          const athenaConfig = {
            dataBaseName: billingAccount.athenaDbName,
            tableName: billingAccount.athenaDbTable,
            queryResultsLocation: billingAccount.athenaQueryResultLocation,
          }
          const recommendations = await new AWSAccount(
            billingAccount.id,
            billingAccount.name,
            [billingAccount.athenaRegion],
            athenaConfig,
          ).getDataForRecommendations(request.awsRecommendationTarget)
          AWSRecommendations.push(recommendations)
        }
      } else {
        // Single billing account (backward compatible)
        const recommendations = await new AWSAccount(
          AWS.BILLING_ACCOUNT_ID,
          AWS.BILLING_ACCOUNT_NAME,
          [AWS.ATHENA_REGION],
        ).getDataForRecommendations(request.awsRecommendationTarget)
        AWSRecommendations.push(recommendations)
      }
    } else {
      // Resolve AWS Estimates synchronously in order to avoid hitting API limits
      const awsAccounts = AWS.accounts as AccountDetails[]
      for (const account of awsAccounts) {
        const recommendations: RecommendationResult[] = await Promise.all(
          await new AWSAccount(
            account.id,
            account.name,
            AWS.CURRENT_REGIONS,
          ).getDataForRecommendations(request.awsRecommendationTarget),
        )
        AWSRecommendations.push(recommendations)
      }
    }
    allRecommendations.push(AWSRecommendations.flat())

    let GCPRecommendations: RecommendationResult[][] = []
    if (GCP.USE_BILLING_DATA) {
      const recommendations = await new GCPAccount(
        GCP.BILLING_PROJECT_ID,
        GCP.BILLING_PROJECT_NAME,
        [],
      ).getDataForRecommendations()
      GCPRecommendations.push(recommendations)
    } else {
      GCPRecommendations = await Promise.all(
        GCP.projects.map((project) =>
          new GCPAccount(
            project.id,
            project.name,
            GCP.CURRENT_REGIONS,
          ).getDataForRecommendations(),
        ),
      )
    }
    allRecommendations.push(GCPRecommendations.flat())

    const AzureRecommendations: RecommendationResult[][] = []
    if (AZURE?.USE_BILLING_DATA) {
      const azureAccount = new AzureAccount()
      await azureAccount.initializeAccount()
      const recommendations = await azureAccount.getDataFromAdvisorManagement(
        request.accounts,
      )
      AzureRecommendations.push(recommendations)
    }
    allRecommendations.push(AzureRecommendations.flat())

    return allRecommendations.flat()
  }

  async getAwsEstimatesFromInputData(
    inputData: LookupTableInput[],
  ): Promise<LookupTableOutput[]> {
    return await AWSAccount.getCostAndUsageReportsDataFromInputData(inputData)
  }

  async getGcpEstimatesFromInputData(
    inputData: LookupTableInput[],
  ): Promise<LookupTableOutput[]> {
    return await GCPAccount.getBillingExportDataFromInputData(inputData)
  }

  async getAzureEstimatesFromInputData(
    inputData: LookupTableInput[],
  ): Promise<LookupTableOutput[]> {
    return await AzureAccount.getDataFromConsumptionManagementInputData(
      inputData,
    )
  }

  getOnPremiseEstimatesFromInputData(
    inputData: OnPremiseDataInput[],
  ): OnPremiseDataOutput[] {
    return OnPremise.getOnPremiseDataFromInputData(inputData)
  }
}
