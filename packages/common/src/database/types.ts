import type { ColumnType, Insertable, Selectable, Updateable } from "kysely";

export type CloudProvider = "AWS" | "GCP" | "AZURE" | "ALI";

export interface CloudConnectionTable {
  id: string;
  provider: CloudProvider;
  // AWS specific
  roleArn: string | null;
  externalId: string | null;
  accountId: string | null;
  // GCP specific
  serviceAccountKey: string | null;
  projectId: string | null;
  // Common
  isActive: ColumnType<boolean, boolean | undefined, boolean>;
  lastSync: Date | null;
  organizationId: string;
  createdAt: ColumnType<Date, Date | undefined, never>;
  updatedAt: ColumnType<Date, Date | undefined, Date>;
}

export type CloudConnection = Selectable<CloudConnectionTable>;
export type NewCloudConnection = Insertable<CloudConnectionTable>;
export type CloudConnectionUpdate = Updateable<CloudConnectionTable>;

export interface AuditLogTable {
  id: string;
  action: string; // e.g., "KPI_CREATED", "KPI_ACCEPTED", "DATA_PULL", "RESULT_CHANGED"
  entity: string; // e.g., "KPI", "LOAN", "CLOUD_CONNECTION"
  entityId: string;
  details: string; // JSON string
  userId: string | null;
  loanId: string | null;
  kpiId: string | null;
  kpiResultId: string | null;
  cloudConnectionId: string | null;
  createdAt: ColumnType<Date, Date | undefined, never>;
}

export type AuditLog = Selectable<AuditLogTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
export type AuditLogUpdate = Updateable<AuditLogTable>;

export interface CloudFootprintTable {
  id: string;
  cloudConnectionId: string;
  timestamp: Date;
  periodStartDate: Date;
  periodEndDate: Date;
  cloudProvider: string;
  kilowattHours: number;
  co2e: number;
  cost: number;
  accountId: string;
  serviceName: string;
  region: string;
  tags: string | null;
  createdAt: ColumnType<Date, Date | undefined, never>;
  updatedAt: ColumnType<Date, Date | undefined, Date>;
}

export type CloudFootprint = Selectable<CloudFootprintTable>;
export type NewCloudFootprint = Insertable<CloudFootprintTable>;
export type CloudFootprintUpdate = Updateable<CloudFootprintTable>;

export interface Database {
  CloudConnection: CloudConnectionTable;
  AuditLog: AuditLogTable;
  CloudFootprint: CloudFootprintTable;
}
