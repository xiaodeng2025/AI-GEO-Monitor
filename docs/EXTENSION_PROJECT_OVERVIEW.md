# AI-GEO-Monitor Extension Project Overview

## Project role

The Extension identifies an AI platform, observes and acquires its native page data, waits for a stable observation, creates a platform-native Snapshot, and stores the result in the current local acceptance facility. Delivery to a GEO backend is not implemented. **Unified entry, not unified platform data.**

## Platform status

| Platform | Detection | Acquisition | Snapshot | Manual acceptance | Freeze | Official URL pattern |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek | Exact official host | Final answer, question when unambiguous, citations and source-pool count | Dead HTML (`text/html`) | PASS | FROZEN | `https://chat.deepseek.com/a/chat/s/<id>` |
| Doubao | Exact official host | Native question/answer, Search/Reference and response observation | Raw MHTML | PASS | FROZEN | `https://www.doubao.com/chat/<id>` |
| Yuanbao | Exact official host | Native response/Processing and passive Search observation | Raw MHTML | PASS | FROZEN | `https://yuanbao.tencent.com/chat/<segment>/<segment>` |
| Wenxin | Exact official host | Native answer, Source Pool and passive Search observation | Raw MHTML | PASS | FROZEN | `https://wenxin.baidu.com/search/<id>` |

## Acquisition data dictionary

The Extension preserves native platform fields. A capability marked “not collected” is not synthesized for cross-platform symmetry.

### Shared concepts

`platform`, page/conversation URL where exposed, question and answer text where available, observation identifier/fingerprint, observation status, timestamps, and acquisition diagnostics are common concepts. Exact names and availability remain platform-specific.

### DeepSeek

| Field / structure | Meaning and source |
| --- | --- |
| `platform` | Router-provided platform identifier. |
| Conversation URL / ID | Official chat route; ID is derived only when present in the route. |
| Question / answer | Paired DOM content from the visible conversation. |
| Observation ID / fingerprint | Stable-result identity used for publication and deduplication. |
| Observation status | Active, stable, or failure lifecycle state. |
| Citations | Answer-local citation occurrences and URLs when native citation anchors are present. |
| Source Pool | Native source-pool count when reported by the page. |
| Timestamps | Capture and observation lifecycle times. |
| Search, Processing/reasoning, Sources, Attribution | Not separately collected in the current DeepSeek acquisition schema unless represented by supported citation/source structures. |

### Doubao

| Field / structure | Meaning and source |
| --- | --- |
| `platform` | Router-provided platform identifier. |
| Conversation URL / ID | Official chat route and page conversation identity. |
| Question / answer | Visible native question and final response. |
| Observation ID / fingerprint | Stable semantic observation identity used for one-time publication and dedupe. |
| Observation status / response status | Native response lifecycle and passive response diagnostics. |
| Search / Reference | Native Search summary, query items, reference items, and URLs when materialized. |
| Processing/reasoning | Not separately collected in the current Doubao schema. |
| Citations / Sources / Attribution | No separate formal citation field; Search/Reference semantics remain native structures. |
| Timestamps | Observation and capture times. |

### Yuanbao

| Field / structure | Meaning and source |
| --- | --- |
| `platform` | Router-provided platform identifier. |
| Conversation URL / ID | Official chat route segments and page identity when exposed. |
| Question / answer | Visible prompt and response DOM. |
| Observation ID / fingerprint | Stable complete-result identity excluding capture-time metadata. |
| Observation status | Active, registered, stable, and failure lifecycle states. |
| Processing / reasoning | Native processing observation when present; absence is represented as absence. |
| Search | Passive raw Search observation when exposed by page/runtime transport. |
| Sources / Attribution / Source Pool / formal Citations | Not uniformly collected by the current Yuanbao acquisition schema; native source-panel data belongs to Snapshot evidence. |
| Timestamps | Observation and capture lifecycle times. |

### Wenxin

| Field / structure | Meaning and source |
| --- | --- |
| `platform` | Router-provided platform identifier. |
| Conversation URL / ID | Official search route and page identity when exposed. |
| Question / answer | Visible final answer and associated prompt context. |
| Observation ID / fingerprint | Stable result identity used for publication and dedupe. |
| Observation status / response status | Stable observation and response lifecycle diagnostics. |
| Source Pool | Native reference-material pool and concrete source websites. |
| Search | Sanitized passive Search observation. |
| Processing/reasoning, formal Citations, Attribution | Not observed or not collected in the current schema. |
| Timestamps | Observation and capture lifecycle times. |

## Observation and stable lifecycle

Each content script observes its platform page. A `MutationObserver` watches relevant DOM changes and platform-specific readiness signals. The adapter emits an observation with a platform-native fingerprint; `observation_id`/fingerprint prevents repeated publication of the same stable result. A stable observation means the platform-specific completion/readiness predicate has held for the required window. Snapshot preparation runs only after the accepted stable trigger. Acquisition failures and Snapshot failures are independent outcomes: a Snapshot error does not rewrite a successful acquisition, and an acquisition failure does not create a fabricated Snapshot.

## Snapshot data dictionary

| Platform | Artifact / MIME | Page preparation | Sources behavior | Dedupe | Current storage |
| --- | --- | --- | --- | --- | --- |
| Doubao | Raw MHTML / `multipart/related` | Prepare accepted native response and reference state | Expand native reference entry when present | Conversation-scoped Snapshot dedupe | Extension IndexedDB acceptance store |
| DeepSeek | Dead HTML / `text/html` | Solidify accepted answer and source state into offline HTML | Preserve supported source/citation evidence in page | Conversation-scoped Snapshot dedupe | Extension IndexedDB acceptance store |
| Yuanbao | Raw MHTML / `multipart/related` | Prepare accepted native response and source-panel state | Preserve native source panel and citation control | Conversation-scoped Snapshot dedupe | Extension IndexedDB acceptance store |
| Wenxin | Raw MHTML / `multipart/related` | Prepare accepted answer, sidebar, and reference state | Expand native reference entry and wait for concrete sources | Conversation-scoped Snapshot dedupe | Extension IndexedDB acceptance store |

Snapshots are evidence from the real page; they are not reconstructed from normalized JSON.

## Runtime structure

- Detection/router: `extension/ai-geo-monitor-unified/shared/router.js`, `platform-registry.js`.
- Shared observation trigger/runtime: `extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js`, `runtime.js`.
- Platform content/acquisition: `extension/ai-geo-monitor-unified/platforms/<platform>/content.js` and bootstrap/observer modules.
- Background entrypoint: `extension/ai-geo-monitor-unified/background.js`.
- Platform Snapshot preparation: `extension/ai-geo-monitor-unified/platforms/<platform>/extension-snapshot.js`.
- Snapshot dedupe/store and debug/export UI: `snapshot-debug.js`, `snapshot-debug.html`, and the Extension IndexedDB store.

## Formal capability and extensibility

Formal frozen capabilities are Detection, platform-native Acquisition/Observation, and platform-native Snapshot generation. The IndexedDB store and debug/export page are local acceptance facilities, not the future GEO backend architecture.

`AI Platform → Extension Detection → Platform Acquisition → Observation → Stable → Platform Snapshot → Current local test/cache storage`

Not implemented: `Delivery → GEO Backend → Storage / Analysis / Metrics / Dashboard / API / Report`.

Downstream Delivery work must not default to changing the four frozen acquisition paths or Snapshot page behavior. Additional AI platforms may add platform-specific adapters while preserving native semantics and the principle **Unified entry, not unified platform data.**
