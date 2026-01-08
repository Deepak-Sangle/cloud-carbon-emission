/*
 * © 2021 Thoughtworks, Inc.
 */

import axios from 'axios'
import { equals } from 'ramda'
import { useEffect, useState } from 'react'

import {
  CalculationConstants,
  EstimationResult,
  FootprintResponse,
} from '@cloud-carbon-footprint/common'

import moment from 'moment'
import { useAxiosErrorHandling } from '../../layout/ErrorPage'
import { ServiceResult } from '../../Types'

export interface UseRemoteFootprintServiceParams {
  baseUrl: string | null
  startDate: moment.Moment
  endDate: moment.Moment
  initial?: EstimationResult[]
  ignoreCache?: boolean
  onApiError?: (e: Error) => void
  minLoadTimeMs?: number
  groupBy?: string
  limit?: number
}

export interface FootprintServiceResult
  extends ServiceResult<EstimationResult> {
  calculationConstants: CalculationConstants | null
}

const useRemoteFootprintService = (
  params: UseRemoteFootprintServiceParams,
): FootprintServiceResult => {
  const [data, setData] = useState(params.initial ?? [])
  const [loading, setLoading] = useState(true)
  const [calculationConstants, setCalculationConstants] =
    useState<CalculationConstants | null>(null)

  const { error, setError } = useAxiosErrorHandling(params.onApiError)

  const start: string = params.startDate.format('YYYY-MM-DD').toString()
  const end: string = params.endDate.format('YYYY-MM-DD').toString()

  useEffect(() => {
    const fetchEstimates = async () => {
      if (!params.baseUrl) {
        setLoading(false)
        return
      }
      setError(null)

      /*
       * Estimates needs to be initialized to spread data and not data itself to avoid state mutation during concatenation
       * This allows setState to properly set off useEffect dependencies in the filter hooks
       */
      let estimates: EstimationResult[] = [...data]
      try {
        let lastDataLength = 1
        let skip = 0
        while (lastDataLength > 0) {
          const res = await axios.get<FootprintResponse>(
            `${params.baseUrl}/footprint`,
            {
              params: {
                start: start,
                end: end,
                ignoreCache: params.ignoreCache,
                groupBy: params.groupBy,
                limit: params.limit,
                skip,
              },
            },
          )
          const responseEstimates = res?.data?.estimates
          // Update calculation constants from the first response
          if (res?.data?.calculationConstants && !calculationConstants) {
            setCalculationConstants(res.data.calculationConstants)
          }
          lastDataLength = checkForLoopExit(
            lastDataLength,
            responseEstimates,
            params,
            estimates,
          )
          estimates = concatenateResults(estimates, responseEstimates)
          skip += params.limit
        }
      } catch (e) {
        console.error(e.message, e)
        setError(e)
      } finally {
        setData(estimates)
        if (params.minLoadTimeMs) {
          setTimeout(() => {
            setLoading(false)
          }, params.minLoadTimeMs)
        } else {
          setLoading(false)
        }
      }
    }

    fetchEstimates()
  }, [
    end,
    start,
    params.ignoreCache,
    setError,
    params.baseUrl,
    params.groupBy,
    params.limit,
  ])

  return { data, loading, error, calculationConstants }
}

const concatenateResults = (estimates, newEstimates) => {
  const equalsLastDataObject = checkForEqualObjects(newEstimates, estimates)
  if (estimates.length === 0) {
    return newEstimates
  }

  if (!newEstimates || newEstimates.length === 0 || equalsLastDataObject) {
    return estimates
  }

  const existingDates = estimates.reduce((dates, estimate) => {
    dates.push(moment.utc(estimate.timestamp))
    return dates
  }, [])

  const updatedEstimates = estimates
  newEstimates.forEach((newEstimate) => {
    const newDateExists = existingDates.some(
      (date) =>
        new Date(date).getTime() == new Date(newEstimate.timestamp).getTime(),
    )

    if (newDateExists) {
      const elementIndex = updatedEstimates.findIndex((estimate) =>
        moment
          .utc(estimate.timestamp)
          .isSame(moment.utc(newEstimate.timestamp)),
      )
      const estimateToUpdate = updatedEstimates[elementIndex]
      if (estimateToUpdate) {
        estimateToUpdate.serviceEstimates =
          estimateToUpdate?.serviceEstimates.concat(
            newEstimate.serviceEstimates,
          )
        updatedEstimates[elementIndex] = estimateToUpdate
      }
    } else {
      updatedEstimates.push(newEstimate)
    }
  })

  return updatedEstimates
}

const checkForEqualObjects = (
  newEstimates: EstimationResult[],
  cachedEstimates: EstimationResult[],
) => {
  if (!cachedEstimates || cachedEstimates?.length == 0) return false
  if (!newEstimates || newEstimates?.length == 0) return true

  const newServiceEstimates =
    newEstimates[newEstimates?.length - 1]?.serviceEstimates
  const lastNewDataObject = newServiceEstimates[newServiceEstimates?.length - 1]

  const cachedServiceEstimates =
    cachedEstimates[cachedEstimates?.length - 1]?.serviceEstimates
  const lastCachedDataObject =
    cachedServiceEstimates[cachedServiceEstimates?.length - 1]

  return equals(lastNewDataObject, lastCachedDataObject)
}

const checkForLoopExit = (
  lastDataLength: number,
  data: EstimationResult[],
  params: UseRemoteFootprintServiceParams,
  estimates: EstimationResult[],
) => {
  const equalsLastDataObject = checkForEqualObjects(data, estimates)

  lastDataLength = data?.length || 0
  if (params.ignoreCache || data == undefined || equalsLastDataObject)
    lastDataLength = 0

  return lastDataLength
}

export default useRemoteFootprintService
