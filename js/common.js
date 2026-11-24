'use strict';
/* 操作画面と出力画面で共通に使う定義と、VRMファイルの保存（ブラウザ内の IndexedDB）。
   VRMファイルやカメラ映像はサーバーには送られず、使っているパソコンのブラウザの中だけで扱われる。 */
const CHANNEL = 'vrm-avatar-v1';
let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('vrm-avatar', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('ブラウザの保存領域を開けません'));
  });
  return dbPromise;
}
async function idbReq(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('files', mode), req = fn(tx.objectStore('files'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('保存に失敗しました'));
  });
}
const fileGet = key => idbReq('readonly', s => s.get(key));
const filePut = (key, val) => idbReq('readwrite', s => s.put(val, key));
