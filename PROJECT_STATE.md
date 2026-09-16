# Project State

## Current release state

Phase B — Four-platform Extension Integration: **COMPLETED / ACCEPTED / FROZEN**.

| Platform | Detection | Acquisition | Snapshot |
| --- | --- | --- | --- |
| DeepSeek | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN |
| Doubao | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN |
| Yuanbao | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN |
| Wenxin | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN | COMPLETED / ACCEPTED / FROZEN |

## Current supported scope

- Platform detection and routing.
- Platform-native acquisition and observation.
- Stable observation lifecycle and deduplication.
- Platform-native Snapshot generation.
- Local Extension IndexedDB/debug/export facilities for acceptance and inspection.

The governing principle is **Unified entry, not unified platform data.** Shared runtime infrastructure does not replace platform-native semantics.

## Not implemented

- Delivery to a remote service.
- GEO backend integration or contract.
- Remote Snapshot storage.
- Backend normalization.
- Metrics, analysis, dashboard, API, or reporting services.

## Frozen boundary

- Existing four-platform acquisition behavior is frozen.
- Existing four-platform Snapshot page behavior is frozen.
- Snapshot artifact types may differ by platform.
- Snapshot evidence comes from the prepared real platform page, not reconstructed observation JSON.
- Platform-native field names and semantics remain platform-owned.
- The current official conversation URL is secondary traceability evidence, not a replacement for page observation.

## Extensibility

The current four platforms are the first supported cohort. Additional AI platforms may be added with platform-specific adapters while preserving the principle **Unified entry, not unified platform data.**
