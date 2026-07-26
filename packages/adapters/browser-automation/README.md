# Browser Automation Adapter

This adapter turns one strict browser page event into the v1 Ambient path:

```text
small URL/DOM/dwell payload
  -> deterministic Automation match
  -> Browser Capture exact-evidence port
  -> atomic full-page and optional selection Raw Views
  -> TriggerSignal with exact evidence revisions
  -> Automation Runtime
```

The adapter does not select an Agent, own cooldown state, or invoke legacy
Ambient Programs. Durable occurrence reservation remains in Automation, and
result validation/commit remains in Execution. It does not construct Capture
candidates or call Capture Ingress directly. One Browser `event_id` is the
exact replay identity. A later DOM snapshot has a new occurrence identity and
is suppressed, when appropriate, by Automation cooldown rather than being
aliased to older exact evidence.
