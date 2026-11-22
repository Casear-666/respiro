// Transport-independent so the exact desktop protocol can be exercised with real HTTP and SQLite.
export async function syncReplica(database, request, { cancelled = () => false } = {}) {
  const alive = () => { if (cancelled()) throw new Error("同步任务已停止"); };
  const pull = async () => {
    let page;
    do {
      alive();
      const state = database.sync.replicaState();
      const query = new URLSearchParams({ since: String(state.cursor), ...(state.epoch ? { epoch: state.epoch } : {}) });
      page = await request(`/api/sync/changes?${query}`);
      alive(); database.sync.receive(page);
    } while (page.hasMore);
  };
  // Replay uncertain uploads before pulling. Their receipts remain valid even when the remote has advanced.
  const replay = async () => {
    for (let batches = 0; batches < 100; batches++) {
      alive();
      const operations = database.sync.stage();
      if (!operations.length) return;
      const result = await request("/api/sync/push", { epoch: database.sync.replicaState().epoch, operations });
      alive(); database.sync.acknowledge(result);
    }
  };
  if (database.sync.replicaState().epoch) await replay();
  await pull();
  await replay();
  await pull();
  const { conflicts } = await request("/api/sync/conflicts");
  alive();
  return { ...database.sync.replicaState(), conflicts };
}
