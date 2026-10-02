/**
 * Browser-only workspace persistence.
 *
 * IndexedDB is used for the saved workspace because it is asynchronous and
 * does not impose the small synchronous quota of localStorage.  The legacy
 * localStorage key is retained as a migration/fallback path for embedded
 * WebViews and test hosts that do not expose IndexedDB.
 */

const DATABASE_NAME = 'llm-serial-workspace';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace';
const RECORD_KEY = 'current';
export const LEGACY_WORKSPACE_KEY = 'llm_serial_app_config';

interface WorkspaceRecord {
  id: string;
  serialized: string;
  updatedAt: number;
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function closeAfter<T>(database: IDBDatabase, operation: Promise<T>): Promise<T> {
  return operation.finally(() => database.close());
}

function readRecord(database: IDBDatabase): Promise<WorkspaceRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 读取失败'));
    request.onsuccess = () => resolve(request.result as WorkspaceRecord | undefined);
  });
}

function writeRecord(database: IDBDatabase, record: WorkspaceRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 写入失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 写入被中止'));
    transaction.oncomplete = () => resolve();
    transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
  });
}

function readLegacyWorkspace(): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  return localStorage.getItem(LEGACY_WORKSPACE_KEY);
}

function writeLegacyWorkspace(serialized: string): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    throw new Error('当前环境没有可用的浏览器工作区存储');
  }
  localStorage.setItem(LEGACY_WORKSPACE_KEY, serialized);
}

/** Load the current workspace JSON, migrating a legacy localStorage record when possible. */
export async function loadBrowserWorkspace(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  if (canUseIndexedDb()) {
    try {
      const database = await openDatabase();
      const record = await closeAfter(database, readRecord(database));
      if (record && typeof record.serialized === 'string') return record.serialized;

      const legacy = readLegacyWorkspace();
      if (legacy !== null) {
        const migrationDb = await openDatabase();
        await closeAfter(
          migrationDb,
          writeRecord(migrationDb, { id: RECORD_KEY, serialized: legacy, updatedAt: Date.now() }),
        );
        // Remove only after the IndexedDB transaction has committed.
        try {
          localStorage.removeItem(LEGACY_WORKSPACE_KEY);
        } catch {
          // A read-only storage area should not make the migrated workspace unavailable.
        }
        return legacy;
      }
      return null;
    } catch (error) {
      // A browser may expose IndexedDB but deny it in private/embedded mode.
      // Keep the legacy path usable and let the caller surface save failures.
      console.warn('[workspace-storage] IndexedDB 读取失败，回退旧存储:', error);
    }
  }

  return readLegacyWorkspace();
}

/** Persist workspace JSON. IndexedDB failures are returned to the caller as actionable errors. */
export async function saveBrowserWorkspace(serialized: string): Promise<void> {
  if (typeof window === 'undefined') return;

  if (canUseIndexedDb()) {
    try {
      const database = await openDatabase();
      await closeAfter(
        database,
        writeRecord(database, { id: RECORD_KEY, serialized, updatedAt: Date.now() }),
      );
      try {
        localStorage.removeItem(LEGACY_WORKSPACE_KEY);
      } catch {
        // The IndexedDB copy is authoritative; legacy cleanup is best effort.
      }
      return;
    } catch (error) {
      throw new Error(`浏览器工作区保存失败（IndexedDB）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    writeLegacyWorkspace(serialized);
  } catch (error) {
    throw new Error(`浏览器工作区保存失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
