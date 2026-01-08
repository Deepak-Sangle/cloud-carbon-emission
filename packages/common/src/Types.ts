/*
 * © 2021 Thoughtworks, Inc.
 */

import {
  BaseExternalAccountClient,
  Compute,
  Impersonated,
  JWT,
  UserRefreshClient,
} from 'google-auth-library'

export type GoogleAuthClient =
  | Compute
  | JWT
  | UserRefreshClient
  | Impersonated
  | BaseExternalAccountClient

export type AccountDetails = {
  id: string
  name?: string
}

export type AccountDetailsOrIdList = AccountDetails[] | string[]

export type AWSBillingAccountConfig = {
  id: string
  name: string
  athenaDbName: string
  athenaDbTable: string
  athenaQueryResultLocation: string
  athenaRegion: string
}
