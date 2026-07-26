## Question

How should Screenpipe be integrated as a replaceable, capability-negotiated Capture Connector without depending on its internal SQLite or mistaking source-derived summaries for Metaflow outputs?

## Depends on

- Implement View Store and SQLite revision persistence
- Implement View access approval profiles and deny overrides

## Acceptance criteria

- Connector negotiates health, version, and supported capabilities before capture.
- Official REST/OpenAPI contracts are used; internal Screenpipe SQLite is not queried.
- Frame/OCR, audio, input, UI element, and activity payloads retain source-native distinctions.
- Screenpipe-derived summaries are marked as source-derived with provider provenance.
- Large media is externally referenced by default.
- Unknown or incompatible schema fields fail observably instead of degrading silently.
- Screenpipe license constraints are documented for the intended use.

## Verification method

- Contract-test recorded official payload fixtures for supported and incompatible versions.
- Run a live local smoke test when Screenpipe is available and separately verify the unavailable-source failure path.
