let opening;

function openDatabase() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open("smartbudget", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("transactions", { keyPath: "id" });
        request.result.createObjectStore("outbox", { keyPath: "client_tx_id" });
        request.result.createObjectStore("deletions", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return opening;
}

async function run(stores, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    const result = operation((name) => transaction.objectStore(name));
    transaction.oncomplete = () => resolve(result);
  });
}

export async function readState() {
  const stores = ["transactions", "outbox", "deletions"];
  const requests = await run(stores, "readonly", (store) => stores.map((name) => store(name).getAll()));
  const [transactions, outbox, deletions] = requests.map((request) => request.result);
  return { transactions, outbox, deletions };
}

export function replaceTransactions(transactions, acknowledgedIds = []) {
  return run(["transactions", "outbox"], "readwrite", (store) => {
    const records = store("transactions");
    records.clear();
    for (const row of transactions) records.put(row);
    for (const id of acknowledgedIds) store("outbox").delete(id);
  });
}

export function acceptTransactions(transactions, acknowledgedIds = []) {
  return run(["transactions", "outbox"], "readwrite", (store) => {
    for (const row of transactions) store("transactions").put(row);
    for (const id of acknowledgedIds) store("outbox").delete(id);
  });
}

export function enqueue(transactions) {
  return run(["outbox"], "readwrite", (store) => {
    for (const row of transactions) store("outbox").put(row);
  });
}

export function removePending(clientId) {
  return run(["outbox"], "readwrite", (store) => store("outbox").delete(clientId));
}

export function enqueueDeletion(id) {
  return run(["deletions"], "readwrite", (store) => store("deletions").put({ id }));
}

export function acceptDeletion(id) {
  return run(["deletions", "transactions"], "readwrite", (store) => {
    store("deletions").delete(id);
    store("transactions").delete(id);
  });
}
