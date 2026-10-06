# hookscope

[![ci](https://github.com/Ahmedkholaif/hookscope/actions/workflows/ci.yml/badge.svg)](https://github.com/Ahmedkholaif/hookscope/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

A **live webhook inspector**. Get a URL, point any webhook sender at it, and watch requests stream into the browser the instant they land: headers, pretty-printed bodies and **signature verification**. You can replay a request to any URL, or make the endpoint **fail on purpose** (503, 429, 410, slow responses) to watch a sender's retries and backoff happen in real time.

It's the companion to [hookline](https://github.com/Ahmedkholaif/hookline): point hookline at a hookscope URL, set the endpoint secret, and every delivery shows up with ✓ signed, its attempt number and the status you told hookscope to answer with.

## Node.js: one process, zero runtime dependencies

The server is plain `node:http`: no Express, no Socket.IO, and `dependencies: {}`. It leans on what Node does best, which is many concurrent, mostly idle connections and streaming I/O.

| Node strength | In hookscope |
|---|---|
| **Event-driven fan-out** | Every bin is an `EventEmitter`. One capture is pushed to every open browser tab over **Server-Sent Events**. |
| **Resumable streams** | Each event carries an `id`. On reconnect, the browser's `EventSource` sends `Last-Event-ID` and the server replays exactly what was missed from a ring buffer, so a dropped connection loses nothing. |
| **Backpressure** | A browser that can't keep up (its socket buffer passes 1 MB) is disconnected instead of growing server memory. It reconnects and resumes from its last event id. |
| **Streaming bodies** | Request bodies are consumed chunk by chunk with `for await`, and the server stops reading the moment the size limit is crossed (`413`). An oversized upload is never buffered. Static files are streamed with `stream.pipeline`. |
| **Constant-time crypto** | hookline's `t=…,v1=…` HMAC-SHA256 signatures are checked with `crypto.timingSafeEqual`, with a replay window and support for rotated secrets. The test vector comes from the Go implementation. |
| **Built-in `fetch` + `AbortSignal.timeout`** | Replays a captured request to any URL, with a hard timeout. |
| **Token-bucket rate limiting** | Per client IP on the capture endpoint, answering `429` with `Retry-After`. |
| **Graceful shutdown** | `SIGTERM` stops accepting connections, tells live browsers goodbye and drains in-flight requests. |

## React: a live UI without a state library

| React feature | In hookscope |
|---|---|
| **`useSyncExternalStore`** | The SSE feed (`web/src/feed.ts`) is an external store. React subscribes to it directly: no Redux, no context, no tearing. The hash router uses the same hook. |
| **`useDeferredValue`** | Filtering hundreds of captures stays responsive while you type. |
| **`useTransition`** | Pending states for creating bins and replaying. |
| **Referential stability** | `merge()` returns the *same* array when a resumed stream repeats known events, so React skips the render entirely. |
| **Untrusted content** | Bodies are attacker-controlled. The JSON highlighter escapes before adding markup (unit-tested against an XSS payload). |

The UI also has keyboard navigation (`j`/`k`), copy-as-cURL, "copy endpoint", and light and dark themes.

## Tests

- **Server (`node:test`, 10 tests):**
  - capture fidelity and binary bodies
  - **SSE fan-out to multiple subscribers**
  - **`Last-Event-ID` resume with no gaps**
  - `413` without buffering
  - signature verification against **Go-generated vectors**
  - simulated status and latency
  - replay to a live target
  - token-bucket `429`s
- **Frontend (Vitest):** stream merge and de-duplication, the XSS-safe highlighter, and cURL shell quoting.
- **E2E (Playwright, real browser):** requests appear live without a reload, filtering works, and simulated failures apply and survive a reload.

## Run

```bash
npm ci && npm run build && npm start       # http://localhost:4000
# or
docker build -t hookscope . && docker run -p 4000:4000 hookscope
```

Development: run `npm run dev:server` (Node on :4000) and `npm run dev` (Vite with HMR, proxying `/api` and `/h`) side by side.

**With hookline:** register `http://<host>:4000/h/<bin>` as an endpoint, paste the returned `whsec_…` secret into hookscope, publish an event, then flip "Respond with" to `503` and watch the retries arrive.

**Note:** it's built for development and testing. Bins live in memory (LRU-evicted, 200 requests each). Replay can reach any URL the server can, so don't expose it publicly without adding auth.
