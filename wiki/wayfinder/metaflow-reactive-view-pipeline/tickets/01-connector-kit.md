## Question

How can an Agent or contributor add a new external source by writing only a small source contract and Adapt function while Capture retains all admission, identity, policy, checkpoint, retry, trace, and DLQ behavior?

## Acceptance criteria

- Provide a minimal Connector Kit API for manifest, connection config, source payload validation, and source payload to `RawViewCandidate` adaptation.
- Provide helpers for stable source objects versus occurrence identities, exact provenance, external references, secret references, and policy propagation without hiding required decisions.
- Add an AI-readable template and conformance harness covering malformed payloads, deterministic identity, exact replay, schema evolution, lossless source fields, and multiple candidates per source event.
- Prove the kit with one small source such as Clipboard or a fake photo feed; the example must use the ordinary Capture Runtime rather than bypassing it.
- Keep source-specific protocol and large-media fetching out of `packages/capture`.

## Verification method

- Run Connector Kit unit/conformance tests and the Capture Runtime test suite.
- Compare the example Connector against Browser and Screenpipe adapters and document the intentionally source-specific remainder.
