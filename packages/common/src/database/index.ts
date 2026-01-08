// Database connection
export {
  DatabaseConfig,
  destroyDatabase,
  getDatabase,
  getDatabaseInstance,
  isDatabaseConnected,
} from "./connection";

// Database types
export {
  AuditLog,
  // AuditLog
  AuditLogTable,
  AuditLogUpdate,
  CloudConnection,
  // CloudConnection
  CloudConnectionTable,
  CloudConnectionUpdate,
  CloudFootprint,
  // CloudFootprint
  CloudFootprintTable,
  CloudFootprintUpdate,
  // Enums
  CloudProvider,
  // Full Database Schema
  Database,
  NewAuditLog,
  NewCloudConnection,
  NewCloudFootprint,
} from "./types";
