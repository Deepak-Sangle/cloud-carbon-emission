import type {
  ColumnType,
  Generated,
  Insertable,
  Selectable,
  Updateable,
} from 'kysely'

export type CloudProvider = 'AWS' | 'GCP' | 'AZURE' | 'ALI'

export type CloudServiceSource = 'OPERATIONAL_METRICS' | 'EMBODIED_METRICS'

export interface CloudConnectionTable {
  id: Generated<string>
  provider: CloudProvider
  // AWS specific
  roleArn: string | null
  externalId: string | null
  // GCP specific
  serviceAccountKey: string | null
  projectId: string | null
  // Common
  isActive: ColumnType<boolean, boolean | undefined, boolean>
  lastSync: Date | null
  organizationId: string
  createdAt: ColumnType<Date, Date | undefined, never>
  updatedAt: ColumnType<Date, Date | undefined, Date>
}

export type CloudConnection = Selectable<CloudConnectionTable>
export type NewCloudConnection = Insertable<CloudConnectionTable>
export type CloudConnectionUpdate = Updateable<CloudConnectionTable>

export interface AuditLogTable {
  id: Generated<string>
  action: string // e.g., "KPI_CREATED", "KPI_ACCEPTED", "DATA_PULL", "RESULT_CHANGED"
  entity: string // e.g., "KPI", "LOAN", "CLOUD_CONNECTION"
  entityId: string
  details: string // JSON string
  userId: string | null
  loanId: string | null
  kpiId: string | null
  kpiResultId: string | null
  cloudConnectionId: string | null
  createdAt: ColumnType<Date, Date | undefined, never>
}

export type AuditLog = Selectable<AuditLogTable>
export type NewAuditLog = Insertable<AuditLogTable>
export type AuditLogUpdate = Updateable<AuditLogTable>

export interface CloudServiceTable {
  id: Generated<string>
  serviceName: string
  serviceId: string
  region: string // AWS region (e.g., us-east-1, eu-west-1) or "global" for region-agnostic services
  additionalData: ColumnType<Record<string, unknown>>
  cloudConnectionId: string
  source: CloudServiceSource
  createdAt: ColumnType<Date, Date | undefined, never>
  updatedAt: ColumnType<Date, Date | undefined, Date>
}

export type CloudService = Selectable<CloudServiceTable>
export type NewCloudService = Insertable<CloudServiceTable>
export type CloudServiceUpdate = Updateable<CloudServiceTable>

export interface CloudOperationalMetricsTable {
  id: Generated<string>
  cloudServiceId: string
  periodStart: Date
  periodEnd: Date
  averageCpuLoad: number | null // Services - EC2
  network: number | null // Services - EC2, RDS, DynamoDB, DocumentDB, Redshift, Neptune, Keyspaces
  instanceType: string | null // Services - EC2
  region: string // Services - all
  storageBytes: number | null // Services - S3, EBS, RDS, DynamoDB, DocumentDB, Redshift, Neptune, Keyspaces
  storageClass: string | null // Services - S3
  createdAt: ColumnType<Date, Date | undefined, never>
  updatedAt: ColumnType<Date, Date | undefined, Date>
}

export type CloudOperationalMetrics = Selectable<CloudOperationalMetricsTable>
export type NewCloudOperationalMetrics =
  Insertable<CloudOperationalMetricsTable>
export type CloudOperationalMetricsUpdate =
  Updateable<CloudOperationalMetricsTable>

export interface CloudEmbodiedMetricsTable {
  id: Generated<string>
  cloudServiceId: string
  periodStart: Date
  periodEnd: Date
  region: string // AWS region (e.g., us-east-1)
  instanceType: string | null // EC2/RDS instance type, EBS volume type, etc.
  serviceName: string // EC2, S3, RDS, DynamoDB, DocumentDB, Redshift, Neptune, Keyspaces, EBS
  usageType: string | null // Detailed usage type from Cost Explorer (e.g., BoxUsage:t2.micro)
  instanceHours: number | null // Total hours instances were running
  storageGBHours: number | null // Total GB-hours of storage
  requestCount: number | null // Number of requests (for S3, DynamoDB, etc.)
  dataTransferGB: number | null // Data transfer in GB
  totalCost: number // Total cost in USD for this service/region/type
  unblendedCost: number | null // Unblended cost (without reserved instance discounts)
  additionalMetrics: ColumnType<
    Record<string, unknown> | null,
    string | Record<string, unknown> | null,
    string | Record<string, unknown> | null
  >
  createdAt: ColumnType<Date, Date | undefined, never>
  updatedAt: ColumnType<Date, Date | undefined, Date>
}

export type CloudEmbodiedMetrics = Selectable<CloudEmbodiedMetricsTable>
export type NewCloudEmbodiedMetrics = Insertable<CloudEmbodiedMetricsTable>
export type CloudEmbodiedMetricsUpdate = Updateable<CloudEmbodiedMetricsTable>

export interface Database {
  CloudConnection: CloudConnectionTable
  AuditLog: AuditLogTable
  CloudService: CloudServiceTable
  CloudUsageData: CloudOperationalMetricsTable // Maps to CloudOperationalMetrics model
  CloudEmbodiedMetrics: CloudEmbodiedMetricsTable
}
