# Unified Extension

This directory contains the current four-platform Manifest V3 Extension. It
uses an exact-host registry/router, platform-specific content and observation
adapters, stable-observation triggers, and platform-native Snapshot handlers.

## Supported platforms

The current frozen platform cohort is:

- DeepSeek — `https://chat.deepseek.com/*`
- Doubao — `https://www.doubao.com/*`
- Yuanbao — `https://yuanbao.tencent.com/*`
- Wenxin — `https://wenxin.baidu.com/*`

Each host loads only its matching platform entry. Unsupported hosts fail
closed and do not activate an adapter.

## Runtime and storage

The Extension is a Manifest V3 package with:

- background service worker: `background.js`;
- permissions: `pageCapture` and `storage`;
- platform content scripts and document-start passive observers where required;
- local Snapshot persistence in Extension IndexedDB.

The IndexedDB/debug/export path is a local acceptance and cache facility. It is
not a GEO backend and does not implement remote Delivery. The current
background worker captures the platform page, stores the native Snapshot
locally, and reports capture/storage status through the debug surface.

## Platform-native boundary

Shared runtime code handles routing, lifecycle publication, fingerprint-based
observation deduplication, and Snapshot triggering. Platform modules retain
their native acquisition fields, readiness rules, source/citation semantics,
and Snapshot artifact behavior. The project principle is **Unified entry, not
unified platform data.**

The four current Snapshot forms are intentionally different:

- Doubao: raw MHTML;
- DeepSeek: dead HTML;
- Yuanbao: raw MHTML;
- Wenxin: raw MHTML.

## Scope

The current Extension covers Detection, platform-native Acquisition and
Observation, stable publication, and platform-native Snapshot generation.
Delivery, remote storage, backend normalization, metrics, dashboards, APIs,
and reports are outside this implementation.
