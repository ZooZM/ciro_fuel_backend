/**
 * Where a document's bytes live — spec 012 Story 6 (FR-036 – FR-042e).
 *
 * An ABSTRACT CLASS, not an interface, so it works as a Nest DI token while
 * still being a compile-time contract. The point is that `FilesService` gains
 * no cloud-vendor import: it says `put`/`signedUrl`/`delete` and never learns
 * which storage answered (Constitution IV — every provider-specific client
 * reaches its API through a port with a second working implementation).
 *
 * The second implementation is not decorative. `LocalFileStorage` is what
 * development and all 53 e2e suites run against, so the port has a working
 * alternative continuously rather than in principle.
 *
 * **`signedUrl` is on the port for a reason that is easy to design away.** The
 * download route answers 302 under EVERY driver, local included (FR-042a). Had
 * the local driver returned bytes directly, the redirect would first execute in
 * production — the exact production-only-path defect research R1 found in the
 * bootstrap, reintroduced inside the story meant to be safest.
 */
export abstract class FileStorage {
  /**
   * Writes bytes and returns the key they can be read back by.
   *
   * The key is stored on `FileRecord.storagePath`, which keeps its name and its
   * type and changes only its content — an object key rather than an absolute
   * filesystem path. Renaming it to `objectKey` would read better and would
   * break FR-038's payload freeze.
   *
   * MUST throw rather than return a key for bytes that did not land: the caller
   * persists the metadata record only after this resolves, so a storage failure
   * leaves no record pointing at nothing (FR-041).
   */
  abstract put(params: {
    key: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<void>;

  /**
   * A URL that serves exactly one object, for a bounded time, to a client
   * presenting no credentials of the platform's.
   *
   * "No credentials" is load-bearing and not an implementation detail: the
   * caller is redirected here, and clients differ in whether they forward
   * `Authorization` across a redirect. GCS refuses a request carrying both a
   * signed URL and an `Authorization` header, so a client that forwards it is
   * refused while a browser — which strips the header — succeeds (FR-038c).
   */
  abstract signedUrl(params: { key: string; fileId: string }): Promise<string>;

  abstract delete(key: string): Promise<void>;
}
