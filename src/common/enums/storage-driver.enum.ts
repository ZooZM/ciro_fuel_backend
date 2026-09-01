/**
 * Which `FileStorage` adapter backs uploads and downloads (spec 012 Story 6).
 *
 * `LOCAL` writes to a real `sys_storge` directory and is what development and
 * every e2e suite use; `GCS` writes to the regional bucket. The download route
 * issues a 302 under BOTH — see `FileStorage.signedUrl` and spec FR-042a. A
 * driver-conditional branch in the controller would leave the redirect path
 * executing first in production, which is the exact class of defect spec 012
 * exists to remove.
 */
export enum StorageDriver {
  LOCAL = 'local',
  GCS = 'gcs',
}
