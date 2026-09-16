# AI-GEO-Monitor

AI-GEO-Monitor is an extensible Manifest V3 Extension for collecting platform-native data from visible AI Web conversations and preserving real-page evidence. The first supported platform cohort is DeepSeek, Doubao, Yuanbao, and Wenxin; additional AI platforms may be added over time.

## Start here

For project context, platform-native data shapes, frozen boundaries, and current implementation status, start with:

- [Extension project overview](docs/EXTENSION_PROJECT_OVERVIEW.md)
- [Current project state](PROJECT_STATE.md)

The repository contains the formal Extension source, tests, and the current public release notes.

## Project overview

The current Extension provides:

- platform Detection and routing;
- platform-native Acquisition and Observation;
- platform-specific stable-observation lifecycle handling;
- platform-native Snapshot generation;
- local acceptance/cache storage in Extension IndexedDB.

The local IndexedDB/debug/export path is an acceptance facility, not the final product database or a GEO backend. Delivery and downstream integration are not implemented.

## Supported platforms

The current first cohort is:

| Platform | Detection | Acquisition | Snapshot | Status |
| --- | --- | --- | --- | --- |
| DeepSeek | Exact official host | Native answer, Citation, and Source Pool-count observation | Dead HTML | COMPLETED / ACCEPTED / FROZEN |
| Doubao | Exact official host | Native question/answer, Search/Reference, and response observation | Raw MHTML | COMPLETED / ACCEPTED / FROZEN |
| Yuanbao | Exact official host | Native response/Processing and passive Search observation | Raw MHTML | COMPLETED / ACCEPTED / FROZEN |
| Wenxin | Exact official host | Native answer, Source Pool, and sanitized passive Search observation | Raw MHTML | COMPLETED / ACCEPTED / FROZEN |

These are the first supported platforms, not a closed platform list.

## Core principle

**Unified entry, not unified platform data.**

Shared infrastructure provides Detection, Routing, Runtime, Trigger, deduplication, and common Snapshot storage. Each platform retains its own Acquisition shape, Search, Processing/reasoning, Citation, Sources, Attribution, Source Pool, and Snapshot behavior. Missing platform capabilities are not fabricated for cross-platform symmetry.

## Current data flow

```text
AI Platform
  -> Extension Detection
  -> Platform Acquisition
  -> Observation
  -> Stable
  -> Platform Snapshot
  -> Current local acceptance/cache
```

Future and not implemented:

```text
Delivery
  -> Downstream GEO / analysis backend
```

## Snapshot behavior

Snapshots are evidence of the corresponding platform page, not a separate AI data source and not a reconstruction from normalized observation JSON.

- Doubao: raw MHTML
- DeepSeek: dead HTML
- Yuanbao: raw MHTML
- Wenxin: raw MHTML

These differences are intentional platform-native behavior.

## Repository scope

The current primary implementation is `extension/ai-geo-monitor-unified/`.
It is the frozen four-platform Extension for DeepSeek, Doubao, Yuanbao, and
Wenxin. The `src/` tree is retained supporting code for the Node, Playwright,
SQLite, and local tooling pipeline; some of it is legacy and is not the
recommended Unified Extension entry point. Kimi-related code belongs to that
legacy implementation and does not add Kimi to the current supported-platform
scope. The local Product UI and SQLite pipeline are not a GEO backend or a
remote Delivery architecture.

## Extensibility

A new platform can add a platform adapter, preserve its native data semantics, and use a platform-appropriate reliable Snapshot method. New platform fields do not need to match existing platforms. Downstream normalization, when implemented, must not change or weaken Acquisition semantics.

## Local development and testing

Use a legally accessible account and follow each platform's terms when testing locally. Do not provide, commit, or share Cookies, browser Profiles, Tokens, real conversation data, exported MHTML/Snapshot artifacts, or screenshots containing private content. Local runtime data belongs in ignored paths.

```powershell
npm ci
npm test
npm run lint
```

The repository currently targets Node.js `>=22.5.0` and depends directly on Playwright `1.62.1`. Third-party dependencies retain their respective licenses; see [package.json](package.json) and [package-lock.json](package-lock.json).

## Disclaimer

AI-GEO-Monitor is an independent open-source project for research, learning, interoperability, and technical validation. It is not affiliated with, authorized by, partnered with, or endorsed by DeepSeek, Doubao, Tencent Yuanbao, Baidu Wenxin, or any other current or future supported platform. Platform names, trademarks, websites, and services belong to their respective rights holders.

This project does not design, provide, or encourage bypassing authentication, access controls, paid restrictions, security mechanisms, platform risk controls, or other technical protection measures. Users are responsible for complying with applicable platform Terms of Service, laws, privacy requirements, and copyright/data rights.

Snapshots, MHTML, HTML, screenshots, conversations, and cited sources may contain third-party protected content. Do not publicly redistribute collected material without a lawful basis or authorization. This project does not claim ownership of third-party pages, trademarks, model outputs, or third-party source content.

## License

The project code is licensed under the [Mozilla Public License 2.0](LICENSE). See the license text for the applicable file-level copyleft terms.
