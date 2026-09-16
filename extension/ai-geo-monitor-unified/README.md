# Unified Extension

This is the unified read-only Extension. It provides the
registry-driven exact-host router, lifecycle/bootstrap status, and a plain-data
observation publication boundary. Unit 2 ports the already-frozen Doubao
observation adapter without changing the frozen spike.

The current descriptors cover only:

- `https://www.doubao.com/*`
- `https://yuanbao.tencent.com/*`
- `https://chat.deepseek.com/*`
- `https://wenxin.baidu.com/*` (Wenxin Unified port passed offline review and Real Edge acceptance; the four-platform baseline is being frozen. Yuanbao post-stable publication churn remains a deferred stabilization issue.)

The Doubao manifest entries additionally load its MAIN-world passive response
probe and isolated-world adapter. DeepSeek loads its isolated-world frozen
adapter. Yuanbao loads its document-start MAIN-world passive fetch/XHR observer
and isolated-world frozen adapter. Each host loads only its matching platform
entry; unsupported hosts receive no content script and
therefore no adapter activation. The router uses descriptor host data; it has
no platform-specific conditional branch.

The Doubao adapter and response probe are copied from the frozen
`doubao-readonly-spike` and only have the minimum glue needed to publish the
same plain observation to the shared runtime. The DeepSeek adapter is copied
from the frozen `deepseek-readonly-spike` with the same minimum publication
glue. The Yuanbao adapter and document-start MAIN-world response observer are
copied from the frozen `yuanbao-raw-observation-poc` with only the minimum
Unified publication/package glue. Unified three-platform real Edge acceptance
passed; all three standalone research assets remain unchanged.

There is no service worker, permission, Core transport, SQLite integration,
prompt automation, or Data Contract change. Passive network observation remains
platform-specific: Doubao, Yuanbao, and Wenxin each use their own relevant
passive probe where implemented; DeepSeek has no such observer. The shared
runtime is platform-agnostic and does not interpret platform endpoints or
response fields. The runtime status surface is
`globalThis.__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__`. The publication
boundary accepts plain observation data and performs same-fingerprint in-memory
dedupe only; it does not persist or transmit data.
