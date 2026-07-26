## Question

How should the View Store persist and publish `ViewCommitted` events so no consumer sees an uncommitted View and no successful commit is lost when publication crashes?

## Acceptance criteria

- Persist an outbox record in the same SQLite transaction as every newly created View revision and its relations/materializations.
- Emit no new outbox record for exact idempotent replay and no event for rolled-back batches.
- Support atomic multi-View batches, ordered durable polling, leases/acknowledgement, crash recovery, explicit replay, and observable poison-event failure.
- Publish only after commit and always reference exact committed revisions.
- Keep transport-neutral event/outbox ports outside the SQLite implementation.

## Verification method

- Cover single commit, batch commit, duplicate replay, conflict, rollback, crash between commit and publish, duplicate delivery, restart, and poison event.
- Run View Store and boundary tests.
