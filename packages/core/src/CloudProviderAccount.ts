/*
 * © 2021 Thoughtworks, Inc.
 */
import {
  EstimationResult,
  GroupBy,
  reduceByTimestamp,
  saveFootprintResponse,
} from "@cloud-carbon-footprint/common";
import moment from "moment";
import { union } from "ramda";
import { FootprintEstimate, Region, aggregateEstimatesByDay } from ".";
import { Cost, aggregateCostsByDay } from "./cost";

export default class CloudProviderAccount {
  id?: string;
  name?: string;
  async getRegionData(
    cloudProvider: string,
    region: Region,
    startDate: Date,
    endDate: Date,
    grouping: GroupBy,
    connectionId?: string | null,
  ): Promise<EstimationResult[]> {
    const [regionEstimates, regionCosts] = await Promise.all([
      region.getEstimates(startDate, endDate),
      region.getCosts(startDate, endDate),
    ]);

    const estimatesGroupByService: EstimationResult[][] = region.services.map(
      (service) => {
        const estimates: FootprintEstimate[] =
          regionEstimates[service.serviceName];
        const estimatesByDay = aggregateEstimatesByDay(estimates);

        const costs: Cost[] = regionCosts[service.serviceName];
        const costsByDay = aggregateCostsByDay(costs);

        const dates = union(
          Object.keys(estimatesByDay),
          Object.keys(costsByDay),
        );

        const dataByDay = dates.reduce(
          (
            acc: {
              [date: string]: { estimate: FootprintEstimate; cost: Cost };
            },
            date,
          ) => {
            acc[date] = {
              estimate: estimatesByDay[date],
              cost: costsByDay[date],
            };
            return acc;
          },
          {},
        );

        const estimationResults: EstimationResult[] = Object.entries(
          dataByDay,
        ).map(([date, { estimate, cost }]) => {
          return {
            timestamp: moment.utc(date).toDate(),
            serviceEstimates: [
              {
                cloudProvider: cloudProvider,
                accountId: this.id,
                accountName: this.name,
                serviceName: service.serviceName,
                region: region.id,
                kilowattHours: estimate?.kilowattHours || 0,
                co2e: estimate?.co2e || 0,
                cost: cost?.amount || 0,
                usesAverageCPUConstant: !!estimate?.usesAverageCPUConstant,
              },
            ],
            periodStartDate: startDate,
            periodEndDate: endDate,
            groupBy: grouping,
          };
        });

        return estimationResults;
      },
    );

    let estimates = reduceByTimestamp(estimatesGroupByService.flat());
    estimates = estimates.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    // save to db first
    if (connectionId != null) {
      await saveFootprintResponse(
        estimates,
        [],
        connectionId,
        startDate,
        endDate,
      );
    }
    return estimates;
  }
}
