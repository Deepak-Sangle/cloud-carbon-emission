/*
 * © 2021 Thoughtworks, Inc.
 */

import { PartialDataError } from "@cloud-carbon-footprint/common";
import {
  Athena,
  CloudWatch,
  CloudWatchLogs,
  CostExplorer,
  Glue,
  S3,
} from "aws-sdk";
import {
  GetMetricDataInput,
  GetMetricDataOutput,
  MetricDataResult,
} from "aws-sdk/clients/cloudwatch";
import {
  GetCostAndUsageRequest,
  GetCostAndUsageResponse,
  GetRightsizingRecommendationRequest,
  GetRightsizingRecommendationResponse,
} from "aws-sdk/clients/costexplorer";
import { ListObjectsV2Output } from "aws-sdk/clients/s3";
import csv from "csvtojson";
import { path } from "ramda";
import { EC2ComputeOptimizerRecommendationData } from "./Recommendations/ComputeOptimizer";

export class ServiceWrapper {
  constructor(
    private readonly cloudWatch: CloudWatch,
    private readonly cloudWatchLogs: CloudWatchLogs,
    private readonly costExplorer: CostExplorer,
    private readonly s3: S3,
    private readonly athena?: Athena,
    private readonly glue?: Glue
  ) {}

  private async getCostAndUsageResponse(
    params: CostExplorer.GetCostAndUsageRequest
  ): Promise<CostExplorer.GetCostAndUsageResponse[]> {
    return [await this.costExplorer.getCostAndUsage(params).promise()];
  }

  private async getMetricDataResponse(
    params: CloudWatch.GetMetricDataInput
  ): Promise<CloudWatch.GetMetricDataOutput[]> {
    return [await this.cloudWatch.getMetricData(params).promise()];
  }

  private async getRightsizingRecommendationResponse(
    params: GetRightsizingRecommendationRequest
  ): Promise<CostExplorer.GetRightsizingRecommendationResponse[]> {
    return [
      await this.costExplorer.getRightsizingRecommendation(params).promise(),
    ];
  }

  private async getAthenaQueryResults(
    queryExecutionInput: Athena.Types.GetQueryResultsInput
  ): Promise<Athena.GetQueryResultsOutput[]> {
    return [await this.athena.getQueryResults(queryExecutionInput).promise()];
  }

  private checkForPartialData = (array: Array<MetricDataResult>) => {
    const isPartialData = array.some(
      (obj: MetricDataResult) => obj.StatusCode === "PartialData"
    );
    if (isPartialData) {
      throw new PartialDataError("Partial Data Returned from AWS");
    }
  };

  public async getQueryByInterval(
    intervalInDays: number,
    func: (start: Date, end: Date, params?: any) => Promise<any>,
    start: Date,
    end: Date,
    ...args: any
  ): Promise<Array<any>> {
    const results: Array<any> = [];
    // Process from end date backwards to start date (most recent first)
    let chunkEnd = new Date(end);
    let chunkStart = new Date(chunkEnd);
    const finalStart = new Date(start);

    while (chunkEnd > finalStart) {
      // Calculate chunk start by going backwards
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() - intervalInDays);
      // Ensure we don't go before the final start date
      if (chunkStart < finalStart) {
        chunkStart = new Date(finalStart);
      }

      // Process this chunk serially (await before moving to next)
      const result = await func(chunkStart, chunkEnd, ...args);
      results.push(result);

      // Move to the previous chunk
      chunkEnd = new Date(chunkStart);
    }

    return results;
  }

  public async getCloudWatchLogQueryResults(
    params: CloudWatchLogs.GetQueryResultsRequest
  ): Promise<CloudWatchLogs.GetQueryResultsResponse> {
    return await this.cloudWatchLogs.getQueryResults(params).promise();
  }

  public async describeLogGroups(
    params: CloudWatchLogs.DescribeLogGroupsRequest
  ): Promise<CloudWatchLogs.DescribeLogGroupsResponse> {
    return await this.cloudWatchLogs.describeLogGroups(params).promise();
  }

  public async describeCloudWatchLogsQueries(
    params: CloudWatchLogs.DescribeQueriesRequest
  ): Promise<CloudWatchLogs.DescribeQueriesResponse> {
    return await this.cloudWatchLogs.describeQueries(params).promise();
  }

  public async startCloudWatchLogsQuery(
    params: CloudWatchLogs.StartQueryRequest
  ): Promise<CloudWatchLogs.StartQueryResponse> {
    return await this.cloudWatchLogs.startQuery(params).promise();
  }

  public async startAthenaQueryExecution(
    queryParams: Athena.StartQueryExecutionInput
  ): Promise<Athena.StartQueryExecutionOutput> {
    return await this.athena.startQueryExecution(queryParams).promise();
  }

  public async getAthenaQueryExecution(
    queryExecutionInput: Athena.GetQueryExecutionInput
  ): Promise<Athena.GetQueryExecutionOutput> {
    return await this.athena.getQueryExecution(queryExecutionInput).promise();
  }

  @enablePagination("NextToken")
  public async getAthenaQueryResultSets(
    queryExecutionInput: Athena.GetQueryExecutionInput
  ): Promise<Athena.GetQueryResultsOutput[]> {
    return await this.getAthenaQueryResults(queryExecutionInput);
  }

  @enablePagination("NextPageToken")
  public async getCostAndUsageResponses(
    params: GetCostAndUsageRequest
  ): Promise<GetCostAndUsageResponse[]> {
    const response = await this.getCostAndUsageResponse(params);
    return response;
  }

  @enablePagination("NextToken")
  public async getMetricDataResponses(
    params: GetMetricDataInput
  ): Promise<GetMetricDataOutput[]> {
    const response = await this.getMetricDataResponse(params);
    this.checkForPartialData(response[0].MetricDataResults);
    return response;
  }

  @enablePagination("NextPageToken")
  public async getRightsizingRecommendationsResponses(
    params: GetRightsizingRecommendationRequest
  ): Promise<GetRightsizingRecommendationResponse[]> {
    return await this.getRightsizingRecommendationResponse(params);
  }

  public async listBucketObjects(
    params: S3.Types.ListObjectsV2Request
  ): Promise<ListObjectsV2Output> {
    return await this.s3.listObjectsV2(params).promise();
  }

  public async getComputeOptimizerRecommendationsResponse(
    params: S3.Types.GetObjectRequest
  ): Promise<EC2ComputeOptimizerRecommendationData[]> {
    const stream = this.s3.getObject(params).createReadStream();
    const parsedCsv = await csv().fromStream(stream);
    return JSON.parse(JSON.stringify(parsedCsv));
  }

  public async getAthenaTableDescription(
    params: Glue.Types.GetTableRequest
  ): Promise<Glue.GetTableResponse> {
    return await this.glue.getTable(params).promise();
  }
}

function enablePagination<RequestType, ResponseType>(nextPageProperty: string) {
  return (
    target: unknown,
    propertyKey: string,
    descriptor?: PropertyDescriptor
  ) => {
    const originalMethod = descriptor.value;
    descriptor.value = async function (props: RequestType) {
      const responses: ResponseType[] = [];

      let latestResponse: ResponseType;
      do {
        const args = [
          {
            ...props,
            [nextPageProperty]: path(
              [responses.length - 1, nextPageProperty],
              responses
            ),
          },
        ];
        latestResponse = (await originalMethod.apply(this, args))[0];
        responses.push(latestResponse);
      } while (path([nextPageProperty], latestResponse));

      return responses;
    };

    return descriptor;
  };
}
