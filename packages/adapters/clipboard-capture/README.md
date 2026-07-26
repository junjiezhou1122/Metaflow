# Clipboard Capture Connector

This is the smallest complete Connector Kit example. It contains only:

- a strict source payload Schema;
- a small source configuration Schema;
- one pure `adapt` function;
- a push controller that builds a canonical batch and calls
  `ConnectorRuntime.submitBatch`.

The main Raw View preserves every accepted clipboard source field. File values
remain external references and are never fetched by the Connector.

Unlike this example, Browser still owns Manifest V3 lifecycle, tab/document
identity, DOM collection, and transport outbox behavior. Screenpipe still owns
REST authentication, health/version checks, pagination, modality cursors, and
HTTP retry classification. Those protocol-specific responsibilities do not
belong in Connector Kit or `packages/capture`.
