// Multer's storage/fileFilter/limits are evaluated when the module graph is
// built (decorator-time), before Nest's DI container exists — so these can't
// be sourced from ConfigService without an async factory at every call site.
// Plain constants keep the general upload path and the company-creation
// upload path (files.module.ts, companies.controller.ts) trivially consistent.
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const STORAGE_DIR = 'sys_storge'; // binding constraint — exact name
