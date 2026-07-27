# Notion Capture Adapter

This adapter uses the official MIT-licensed `@notionhq/client@5.4.0`. It does
not construct Notion HTTP requests itself.

`discover` uses the SDK search endpoint to return a bounded onboarding preview.
It does not create a View or change a checkpoint. `pull` and `reference` use
the same SDK and emit ordinary Capture Batches; Capture Runtime remains the
owner of health evidence, admission, checkpoint CAS, retry, DLQ, and trace.

Only full page or data-source search results accepted by the SDK's
`isFullPageOrDataSource` guard become Raw View candidates. The source JSON is
preserved for later Transformations. Notion-hosted or external media URLs stay
references inside that source object; this adapter never downloads large
media.

Authentication requires exactly one named `notion_token` SecretReference. A
host resolver turns it into a token only while constructing the SDK client.
The token cannot enter Source Connection configuration, candidates, Views,
errors, traces, or dead letters.

Official references:

- <https://github.com/makenotion/notion-sdk-js>
- <https://developers.notion.com/reference/intro>

Verification:

```bash
pnpm test:connector-onboarding
```
