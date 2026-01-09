/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  CloudConstants,
  CloudConstantsEmissionsFactors,
  FootprintEstimate,
} from ".";
import { Cost } from "./cost";

export interface EmbodiedEmissionsResult {
  timestamp: Date;
  serviceType: string;
  kilowattHours: number;
  co2e: number;
}

export default interface ICloudService {
  serviceName: string;
  getEstimates(
    start: Date,
    end: Date,
    region: string,
    emissionsFactors: CloudConstantsEmissionsFactors,
    constants: CloudConstants
  ): Promise<FootprintEstimate[]>;
  getCosts(start: Date, end: Date, region: string): Promise<Cost[]>;
  getEmbodiedMetrics?(start: Date, end: Date, region: string): Promise<any[]>;
}
