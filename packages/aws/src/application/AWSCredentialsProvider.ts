/*
 * © 2021 Thoughtworks, Inc.
 */

import { configLoader } from '@cloud-carbon-footprint/common'
import {
  config as awsConfig,
  ChainableTemporaryCredentials,
  Credentials,
  EC2MetadataCredentials,
  ECSCredentials,
} from 'aws-sdk'
import GCPCredentials from './GCPCredentials'

export default class AWSCredentialsProvider {
  static create(accountId: string): Credentials {
    switch (configLoader().AWS.authentication.mode) {
      case 'GCP':
        return new GCPCredentials(
          accountId,
          configLoader().AWS.authentication.options.targetRoleName,
          configLoader().AWS.authentication.options.proxyAccountId,
          configLoader().AWS.authentication.options.proxyRoleName,
        )
      case 'AWS':
        const partition = configLoader().AWS.IS_AWS_GLOBAL ? `aws` : `aws-cn`
        return new ChainableTemporaryCredentials({
          params: {
            // target role is always ccf since our cloudformation template creates the role
            RoleArn: `arn:${partition}:iam::${accountId}:role/ccf`,
            ExternalId: configLoader().AWS.authentication.options.externalId,
            RoleSessionName: 'ccf',
          },
          stsConfig: {
            credentials: {
              accessKeyId:
                configLoader().AWS.authentication.options.accessKeyId,
              secretAccessKey:
                configLoader().AWS.authentication.options.secretAccessKey,
            },
          },
        })
      case 'EC2-METADATA':
        return new EC2MetadataCredentials({
          httpOptions: { timeout: 5000 },
          maxRetries: 10,
        })
      case 'ECS-METADATA':
        return new ECSCredentials({
          httpOptions: { timeout: 5000 },
          maxRetries: 10,
        })
      default:
        return new Credentials(awsConfig.credentials)
    }
  }
}
