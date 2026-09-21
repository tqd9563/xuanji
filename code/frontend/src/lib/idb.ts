/**
 * 浏览器 IndexedDB 的共享底座。
 *
 * 版本号与建表逻辑必须只有一处:IndexedDB 的 upgrade 由「第一个打开库的人」触发,
 * 若两个模块各写各的 onupgradeneeded,谁先打开谁就只建自己那张表,另一张永远不存在;
 * 而版本号写不一致时,用旧版本号打开一个新版本的库会直接抛 VersionError,
 * 把先前好好的功能(壁纸)一起带坏。
 *
 * 只存本机、不写 ~/.claude(架构铁律 2)。
 */
const IDB_NAME = 'xuanji';

/** 加新 store 必须同时 +1,并在 STORES 里登记 */
export const IDB_VERSION = 2;

export const STORE_WALLPAPER = 'wallpaper';
export const STORE_LIVE2D_THUMBS = 'live2d-thumbs';

const STORES = [STORE_WALLPAPER, STORE_LIVE2D_THUMBS] as const;

/** 建齐所有 store。任何 onupgradeneeded 都该调它,不要只建自己那张。 */
export function ensureStores(db: IDBDatabase): void {
  for (const name of STORES) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
  }
}

export function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => ensureStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function idbGet<T>(store: string, key: string): Promise<T | null> {
  const db = await idbOpen();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 列出 store 里的所有 key,用于清理失效缓存 */
export async function idbKeys(store: string): Promise<string[]> {
  const db = await idbOpen();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
