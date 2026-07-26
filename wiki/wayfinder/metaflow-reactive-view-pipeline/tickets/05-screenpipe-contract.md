## Question

How should the Screenpipe Connector follow the current upstream REST protocol exactly while remaining a replaceable, separately installed external source?

## Acceptance criteria

- Sync OCR, Audio, Input, and Accessibility with independent checkpoints; do not assume `content_type=all` includes all modalities.
- Support secret-referenced bearer authentication and inspect the `/health` body status rather than HTTP 200 alone.
- Probe real endpoint/response capabilities instead of reading a nonexistent capability field.
- Preserve actual audio device/speaker shapes, `text_source`, robust source identities, and external frame/audio references without storing credentials.
- Classify 403, 400/404, 408, 503, 504, 500, network errors, and schema incompatibility according to explicit fail-fast/retry policy.
- Document the verified upstream commit and commercial-license boundary; do not vendor, bundle, auto-install, or read internal SQLite.

## Verification method

- Contract-test recorded upstream response shapes for every modality, auth/health, pagination overlap, checkpoint replay, retry classes, and unknown response types.
- Keep live Screenpipe checks as separately reported smoke evidence.
