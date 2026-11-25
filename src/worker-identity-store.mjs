// V1-07 adapter: worker identity state shares the existing machine-global
// WorkflowStore root-lease database and append-only identity journal.
export function createWorkflowStoreWorkerIdentityRegistry(store) {
  if (!store || typeof store.workerIdentityGet !== 'function'
    || typeof store.workerIdentityRegister !== 'function'
    || typeof store.workerIdentityIsRevoked !== 'function'
    || typeof store.workerIdentityRevoke !== 'function') {
    throw Object.assign(new Error('WORKER_IDENTITY_DURABLE_WORKFLOW_STORE_REQUIRED'), {
      workerIdentityCode: 'WORKER_IDENTITY_DURABLE_WORKFLOW_STORE_REQUIRED'
    });
  }
  return Object.freeze({
    get: workerId => store.workerIdentityGet(workerId),
    register: (envelope, expected) => store.workerIdentityRegister(envelope, expected),
    isRevoked: (workerId, bindingId) => store.workerIdentityIsRevoked(workerId, bindingId),
    revoke: (workerId, bindingId, receipt, options) =>
      store.workerIdentityRevoke(workerId, bindingId, receipt, options)
  });
}
