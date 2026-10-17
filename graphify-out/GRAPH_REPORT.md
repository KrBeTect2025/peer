# Graph Report - webrtc  (2026-10-12)

## Corpus Check
- Corpus is ~17,733 words - fits in a single context window. You may not need a graph.

## Summary
- 213 nodes · 374 edges · 12 communities (7 shown, 5 thin omitted)
- Extraction: 91% EXTRACTED · 8% INFERRED · 1% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.89)
- Token cost: 169,839 input · 0 output

## Community Hubs (Navigation)
- Streaming Download Design
- FastAPI Backend & Signaling
- Public Link Test Harness
- Deployment & Product Overview
- Client WebRTC App
- Browser Test Suite
- Service Worker Download
- ICE & Security
- Unload Warning

## God Nodes (most connected - your core abstractions)
1. `basic()` - 11 edges
2. `receiveInto()` - 9 edges
3. `handle()` - 9 edges
4. `special()` - 9 edges
5. `midway()` - 9 edges
6. `long()` - 9 edges
7. `status()` - 8 edges
8. `send()` - 8 edges
9. `sendFile()` - 8 edges
10. `check()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `EXPLANATION.pdf (rendered explanation)` --semantically_similar_to--> `How this P2P file share works (EXPLANATION)`  [AMBIGUOUS] [semantically similar]
  app/EXPLANATION.pdf → app/EXPLANATION.md
- `sendFile two brakes (HIGH_WATER 1 MB, WINDOW 64 MB)` --semantically_similar_to--> `Ack-per-batch flow control (64 MB window)`  [INFERRED] [semantically similar]
  app/EXPLANATION.md → app-disk/README.md
- `10 s ping keep-alive to service worker` --implements--> `Service worker keep-alive ping`  [INFERRED]
  app/EXPLANATION.md → plan.md
- `openSink(meta) sink selection (best first)` --references--> `Memory sink (up to 1 GB)`  [INFERRED]
  app/EXPLANATION.md → app-disk/README.md
- `Plan: receive straight into browser downloads` --references--> `Save-dialog sink (showSaveFilePicker, Chrome/Edge)`  [INFERRED]
  plan.md → app-disk/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Streamed browser-download pipeline (page stream -> service worker -> download manager)** — app_explanation_streamsink, app_explanation_sw_js, app_explanation_keepalive_ping, plan_transferable_streams, plan_download_headers, plan_one_use_download_url [EXTRACTED 1.00]
- **Receiver sink fallback chain (write/close/abort interface)** — app_explanation_opensink, app_explanation_streamsink, app_disk_readme_save_file_picker_sink, app_disk_readme_opfs_sink, app_disk_readme_memory_sink [INFERRED 0.95]
- **Signaling handshake flow** — app_explanation_signaling, app_explanation_redis_code_state, app_explanation_ready_only_to_first, app_explanation_message_chain, app_explanation_signaling_state_machine [EXTRACTED 1.00]
- **Docker Compose stack: web + redis + tunnel** — app_docker_compose_web, app_docker_compose_redis, app_docker_compose_tunnel [EXTRACTED 1.00]
- **Receiver storage strategies** — app_tests_report_download_bar_path, app_tests_report_save_dialog_fallback, app_tests_report_opfs_storage, app_tests_report_in_memory_receive [INFERRED 0.85]

## Communities (12 total, 5 thin omitted)

### Community 0 - "Streaming Download Design"
Cohesion: 0.06
Nodes (36): app-disk: write-to-disk test build, Big-file tests (run.mjs disk|picker|memory, series.sh), Memory sink (up to 1 GB), OPFS sink (Firefox/Safari, quota-checked), Save-dialog sink (showSaveFilePicker, Chrome/Edge), How this P2P file share works (EXPLANATION), abort() on failure (download shows failed), DataChannel protocol (meta, go, 64 KB chunks, ack, done) (+28 more)

### Community 1 - "FastAPI Backend & Signaling"
Cohesion: 0.08
Nodes (11): config(), index(), service_worker(), signaling(), expire(), relay(), send_safe(), metered_ice_servers() (+3 more)

### Community 2 - "Public Link Test Harness"
Cohesion: 0.07
Nodes (29): dependencies, playwright-core, name, private, type, cdp(), chrome, DL (+21 more)

### Community 3 - "Deployment & Product Overview"
Cohesion: 0.09
Nodes (25): redis service, tunnel service (cloudflared quick tunnel), web service (FastAPI), Metered hosted STUN/TURN, P2P File Share (README), Safari browser-storage fallback, FastAPI signaling server, 6-digit share code (1-hour expiry) (+17 more)

### Community 4 - "Client WebRTC App"
Cohesion: 0.22
Nodes (25): chain, clickTo(), closePeer(), configReady, createPeer(), fileSink(), findRoute(), handle() (+17 more)

### Community 5 - "Browser Test Suite"
Cohesion: 0.36
Nodes (19): basic(), check(), fallback(), launch(), log(), long(), makeFile(), midway() (+11 more)

### Community 7 - "ICE & Security"
Cohesion: 0.67
Nodes (3): DTLS-encrypted DataChannels; code as password, /config ICE servers (Metered TURN, cached 1 h, Google STUN fallback), ICE route selection (host, srflx hole punching, TURN relay)

## Ambiguous Edges - Review These
- `How this P2P file share works (EXPLANATION)` → `EXPLANATION.pdf (rendered explanation)`  [AMBIGUOUS]
  app/EXPLANATION.pdf · relation: semantically_similar_to
- `Safari browser-storage fallback` → `Save-dialog fallback path`  [AMBIGUOUS]
  app/tests/REPORT.md · relation: conceptually_related_to

## Knowledge Gaps
- **44 isolated node(s):** `iceServers`, `chain`, `configReady`, `pending`, `RFC-5987` (+39 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 67 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `How this P2P file share works (EXPLANATION)` and `EXPLANATION.pdf (rendered explanation)`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **Why does `P2P File Share page (index.html)` connect `Deployment & Product Overview` to `Client WebRTC App`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **What connects `iceServers`, `chain`, `configReady` to the rest of the system?**
  _44 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Streaming Download Design` be split into smaller, more focused modules?**
  _Cohesion score 0.05795918367346939 - nodes in this community are weakly interconnected._
- **What is the exact relationship between `Safari browser-storage fallback` and `Save-dialog fallback path`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Should `FastAPI Backend & Signaling` be split into smaller, more focused modules?**
  _Cohesion score 0.08292682926829269 - nodes in this community are weakly interconnected._
- **Should `Public Link Test Harness` be split into smaller, more focused modules?**
  _Cohesion score 0.07017543859649122 - nodes in this community are weakly interconnected._