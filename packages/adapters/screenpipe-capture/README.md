# Screenpipe Capture Adapter

This package is the replaceable Screenpipe REST implementation behind
`@info/capture`. It does not read Screenpipe's SQLite database, vendor its
source, install its binary, or commit Views directly.

## Pinned provider contract

The implementation was audited against Screenpipe upstream commit
[`4cf388b746454302f8cac673fc37530b9e2dc47f`](https://github.com/screenpipe/screenpipe/tree/4cf388b746454302f8cac673fc37530b9e2dc47f)
from 2026-07-25:

- engine version family: `0.4.x`;
- checked-in OpenAPI contract version: `1.0.0`;
- endpoints: `/health`, `/search`, `/elements`, and `/activity-summary`;
- response authority: current Rust route/types and tests, then current official
  docs, then the checked-in generated OpenAPI. The generated OpenAPI was stale
  for several fields at the audited revision.

Health returns HTTP 200 even when its JSON body says `status_code: 503`; the
adapter validates both body fields. `/health` has no capability manifest, so
the adapter negotiates a declared capability by probing its official endpoint
with a bounded request before capture. A missing engine version, incompatible
SemVer family, 403, unknown tagged result, added/removed strict field, or
pagination mismatch fails observably.

Screenpipe's `content_type=all` is not a complete capture feed: it omits Input
and Memory. Default search capture therefore calls `ocr`, `audio`, `input`, and
`accessibility` separately. Every modality uses ascending provider order and an
independent time watermark. A 60-second inclusive overlap retains exact item
identities, scans past boundary replays, and catches rows inserted before a
previous page position without relying on unstable global offsets. The overlap
scan and retained identity set are bounded; exhaustion fails observably instead
of skipping evidence. All requested modalities are admitted in one atomic
`CaptureBatch`. It never silently substitutes `all`.

## Raw View mapping

| Screenpipe source | Raw View Schema | Identity | Assertion |
| --- | --- | --- | --- |
| OCR frame | `capture.screenpipe.frame_ocr@1` | stable `frame_id` | direct |
| Audio segment | `capture.screenpipe.audio@1` | stable composite segment key | direct |
| Input event row | `capture.screenpipe.input@1` | stable provider `id` | direct |
| Accessibility result | `capture.screenpipe.ui_accessibility@1` | stable `id` | direct |
| UI element | `capture.screenpipe.ui_element@1` | stable `id` | direct |
| Activity summary | `capture.screenpipe.activity_summary@1` | stable query window | source-derived |

The full validated provider item remains inline semantic evidence. Base64
frames are forbidden because every search request fixes `include_frames=false`.
Frame and audio media use logical `screenpipe://` references in Representation
metadata; the adapter never downloads or embeds large media by default.

Retries, atomic admission, checkpoint CAS, trace, rejection, and dead letters
remain owned by `ConnectorRuntime`. Transport failures and HTTP 408/503/504 are
retryable. HTTP 400/403/404/500 and schema/version incompatibilities are not.
`Retry-After` is retained in structured error details when Screenpipe provides
it.

## Authentication and licensing

Current Screenpipe defaults API authentication on, including localhost.
`/health` is exempt, but capture endpoints may return 403 without
`Authorization: Bearer ...`. A connection declares either `none` or exactly one
Bearer `SecretReference`; the adapter-owned `ScreenpipeSecretResolver` resolves
that reference just in time for protected requests. `/health` never receives
the header. Missing, mismatched, empty, or invalid secret resolution fails
before protected provider access. The value must never enter a query URI, View,
trace, checkpoint, error, or dead letter.

At the audited revision, Screenpipe is under the
[`Screenpipe Commercial License`](https://github.com/screenpipe/screenpipe/blob/4cf388b746454302f8cac673fc37530b9e2dc47f/LICENSE.md),
not MIT. Personal non-commercial, nonprofit, educational, and research use is
allowed; business/production use and embedding, distributing, hosting, or
integrating Screenpipe into a customer product require the applicable paid
license. Official binaries are governed separately by Screenpipe's terms and
subscription. Metaflow therefore connects to a separately user-installed
local service and does not bundle, vendor, modify, or auto-install Screenpipe.
Commercial distribution requires legal review and an appropriate agreement.

## Verification

`tests/fixtures/screenpipe` records the audited health, four search variants,
elements, activity summary, incompatible health, and unknown tagged payloads.
`tests/screenpipe-capture.test.ts` executes them through
`ConnectorRuntime -> CaptureIngress -> SQLite`, including unavailable source,
all audited HTTP retry classes, strict Audio incompatibility, secret isolation,
four-modality atomic failure, late insertion, same-timestamp pagination,
bounded overlap failure, failed atomic admission, dead-letter replay, and
watermark recovery. Set `SCREENPIPE_LIVE_TEST=1` and
`SCREENPIPE_API_KEY` to run the local live smoke test. On 2026-07-26 the local
`127.0.0.1:3030` service was unavailable, so fixture and unavailable-source
verification ran while the live smoke remained skipped.
