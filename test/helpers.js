import { openDb, Store } from '../src/db.js';

export function memStore() {
  const db = openDb(':memory:');
  return new Store(db);
}
