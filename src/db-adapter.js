/**
 * Abstract database adapter interface.
 * Both sqlite-vec and libsql backends implement this contract.
 * All methods are async to support both sync (better-sqlite3) and async (@libsql/client) backends.
 */
export class DbAdapter {
  /**
   * Semantic search across records.
   * @param {Float32Array} embedding - Query embedding vector
   * @param {{ limit?: number, kind?: string, projectId?: number }} opts
   * @returns {Promise<Array<Object>>} Records with similarity scores
   */
  async search(embedding, opts = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Create or update a record with dedup.
   * @param {{ id?: number, projectId?: number, kind: string, title: string, body?: string, status?: string }} record
   * @param {Float32Array} embedding
   * @returns {Promise<Object>} The saved record
   */
  async upsert(record, embedding) {
    throw new Error('Not implemented');
  }

  /**
   * Get a single record by ID.
   * @param {number} id
   * @returns {Promise<Object|null>}
   */
  async get(id) {
    throw new Error('Not implemented');
  }

  /**
   * List records with optional filters.
   * @param {{ kind?: string, status?: string, project?: string }} filters
   * @returns {Promise<Array<Object>>}
   */
  async list(filters = {}) {
    throw new Error('Not implemented');
  }

  /**
   * Delete a record by ID.
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    throw new Error('Not implemented');
  }

  /**
   * List all projects.
   * @returns {Promise<Array<Object>>}
   */
  async listProjects() {
    throw new Error('Not implemented');
  }

  /**
   * Get the current project.
   * @returns {Promise<{ id: number, name: string }>}
   */
  async getCurrentProject() {
    throw new Error('Not implemented');
  }

  /**
   * Get recently updated records for a project.
   * @param {number} projectId
   * @param {number} hours - Lookback window in hours
   * @returns {Promise<Array<Object>>}
   */
  async getRecentRecords(projectId, hours = 1) {
    throw new Error('Not implemented');
  }

  /**
   * Get cloud sync status.
   * @returns {Promise<{ enabled: boolean, syncUrl?: string, syncInterval?: number }>}
   */
  async syncStatus() {
    return { enabled: false };
  }

  /**
   * Trigger a manual cloud sync (no-op if sync is not configured).
   * @returns {Promise<{ synced: boolean, message: string }>}
   */
  async sync() {
    return { synced: false, message: 'Cloud sync not configured' };
  }

  /**
   * Close the database connection.
   */
  async close() {
    throw new Error('Not implemented');
  }
}
