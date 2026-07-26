## Question

How should generic committed View events match active Automation Views and invoke Automation Runtime without Browser, macOS, Capture, or storage adapters manually constructing special trigger flows?

## Acceptance criteria

- Add one adapter that converts exact `ViewCommitted` evidence into strict `TriggerSignal` values and evaluates all enabled matching Automations.
- Support Schema, source, Representation field, relation, policy, Raw/Derived origin, and bounded predicate matching without model calls in the trigger path.
- Allow one View to match many Automations and one Automation to accept many View Schemas.
- Preserve event/outbox identity through occurrence reservation so duplicate delivery cannot duplicate execution.
- Keep context resolution, authorization, Transformation execution, Delivery, and output commit in their existing owners.
- Record matched, ignored, denied, failed, and enqueued outcomes with correlation to exact evidence.

## Verification method

- Test zero, one, and many matches; disabled Automations; predicate failure; duplicate event; denied evidence; and Raw-to-Derived recursive input.
- Prove Browser/macOS-specific controllers are not required for an ordinary committed-View trigger.
