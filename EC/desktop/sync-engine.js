// Transport-independent so the exact desktop protocol can be exercised with real HTTP and SQLite.
export async function syncReplica(database, request, { cancelled = () => false } = {}) {
  const alive = () => { if (cancelled()) throw new Error("同步任务已停止"); };
  const pull = async () => {
    let page;
    do {
      alive();
      const state = await database.sync.replicaState();
      const query = new URLSearchParams({ since: String(state.cursor), ...(state.epoch ? { epoch: state.epoch } : {}) });
      alive();
      page = await request(`/api/sync/changes?${query}`);
      alive(); await database.sync.receive(page);
    } while (page.hasMore);
  };
  // Replay uncertain uploads before pulling. Their receipts remain valid even when the remote has advanced.
  const replay = async () => {
    for (let batches = 0; batches < 100; batches++) {
      alive();
      const operations = await database.sync.stage();
      if (!operations.length) return;
      const { epoch } = await database.sync.replicaState();
      alive();
      const result = await request("/api/sync/push", { epoch, operations });
      alive(); await database.sync.acknowledge(result);
    }
  };
  if ((await database.sync.replicaState()).epoch) await replay();
  await pull();
  await replay();
  await pull();
  alive();
  const { conflicts } = await request("/api/sync/conflicts");
  alive();
  return { ...(await database.sync.replicaState()), conflicts };
}
