# Bug report — `headers.<name>` never resolves unless the server sends the header in lowercase

Draft for filing at [ericwastaken/PayloadStash](https://github.com/ericwastaken/PayloadStash/issues).
Everything below was reproduced locally; the workaround we are running is in
`Dockerfile.payloadstash` next to this file.

---

## Summary

`Capture` and `Expect` paths of the form `headers.<name>` resolve to `None` for
any response header the server did not send in all-lowercase. The resolver
lowercases the name from the config but looks it up in a dict keyed with the
server's original casing, so `headers.etag` misses a header sent as `ETag`.

Two things make this worse than a plain lookup miss:

1. **It fails in the documented-correct direction.** The formal spec says
   "`<name>` must be lowercase", so a config written exactly to spec is the one
   that fails.
2. **It fails green.** A missing capture becomes `None`, and most matchers pass
   against `None` — `notEquals`, `notContains`, `notMatches`, `notIn`. Only
   `exists: true` catches it. A suite can report all-green while asserting
   nothing, and any later request built from the captured value silently sends an
   empty string.

It is invisible over HTTP/2, where header names are lowercase on the wire by
protocol. PayloadStash uses `requests`, which is HTTP/1.1 only, so **every**
target sending canonical casing is affected.

## Environment

| | |
|---|---|
| Image | `ghcr.io/ericwastaken/payloadstash:main` (pulled 2026-07-28) |
| `payloadstash --version` | `0.1.1` |
| `pip show payloadstash` | `1.0.2` — see [Secondary note](#secondary-note-version-mismatch) |
| Host | macOS 15 (arm64), Docker Desktop, image runs under `linux/amd64` emulation |

## Reproduction

Self-contained; no external services. A stdlib HTTP/1.1 server that returns one
canonically-cased header and one already-lowercase header, so the two cases sit
side by side in the same response.

`server.py`:

```python
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_GET(self):
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("ETag", "abc123")          # canonical casing
        self.send_header("x-lower-case", "works")   # already lowercase
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

HTTPServer(("0.0.0.0", 8099), H).serve_forever()
```

`config/repro.yml`:

```yaml
StashConfig:
  Name: HeaderCaseRepro
  Defaults:
    URLRoot: http://host.docker.internal:8099
    FlowControl: { DelaySeconds: 0, TimeoutSeconds: 10 }
  Sequences:
    - Name: repro
      Type: Sequential
      Requests:
        - get_it:
            Method: GET
            URLPath: /
            Capture:
              etag: headers.etag
              lower: headers.x-lower-case
            Expect:
              - status: 200
              - headers.x-lower-case: { equals: 'works' }
              - headers.etag: { exists: true }
              # The false pass: this succeeds against None.
              - headers.etag: { notEquals: 'not-the-real-value' }
```

Run:

```bash
python3 server.py &
docker run --rm --add-host host.docker.internal:host-gateway \
  -v "$PWD/config":/app/config:ro -v "$PWD/output":/app/output \
  ghcr.io/ericwastaken/payloadstash:main \
  run /app/config/repro.yml --out /app/output --yes
```

### Actual

```
Capture: etag = None
Capture: lower = 'works'
  ✓ status equals 200
  ✓ headers.x-lower-case equals 'works'
  ✗ headers.etag exists True
  ✓ headers.etag notEquals 'not-the-real-value'      <-- passes against None
```

The run log records the header correctly in the response dump — `ETag: 'abc123'`
— so the value reached PayloadStash; only the lookup fails.

### Expected

```
Capture: etag = 'abc123'
  ✓ headers.etag exists True
```

## Root cause

`payload_stash/config_utility.py`, in `resolve_response_path` (line 235 in the
1.0.2 that ships in the image):

```python
if path.startswith("headers."):
    return headers.get(path[len("headers."):].lower())
```

The `.lower()` applies to the name taken from the config. `headers` is the plain
dict built from the response in `main.py` (`resp_headers`), which preserves the
server's casing — it is not a `requests.structures.CaseInsensitiveDict`. So the
lookup is effectively case-sensitive against the *server's* choice of casing,
which is the one thing a config author cannot control.

## Suggested fix

Normalize the dict, not just the query:

```python
if path.startswith("headers."):
    wanted = path[len("headers."):].lower()
    return {str(k).lower(): v for k, v in (headers or {}).items()}.get(wanted)
```

Better still, normalize `resp_headers` once where it is built in `main.py`, so
every consumer (capture, expect, report rendering, redaction) sees the same keys.
That also keeps the report's header dump consistent with what paths resolve
against.

Worth considering alongside it: **treat a resolution miss as distinct from a
`None` value.** Today they are indistinguishable, which is what lets `notEquals`
pass against a header that was never found. Failing an assertion whose path did
not resolve — or at least warning on it — would have surfaced this immediately
instead of after a suite spent a run reporting green.

## Impact for us

We verify a service whose optimistic-concurrency model is carried entirely in the
`ETag` response header: read it, echo it back in `If-Match`, expect `409` when it
is stale. Unpatched, every capture and assertion on that header resolved to
`None`, every conditional request went out with an empty `If-Match`, and the
suite still reported the `notEquals` assertions as passing. The first run looked
green while testing nothing.

## Workaround

`Dockerfile.payloadstash` in this folder: a single-layer patch over the upstream
image applying the fix above, with an `assert` on the original source line so the
build fails loudly if upstream changes it rather than silently patching nothing.
With it, the reproduction above passes all four assertions and captures
`etag = 'abc123'`.

## Secondary note: version mismatch

In the same image, `payloadstash --version` reports **0.1.1** while
`pip show payloadstash` reports **1.0.2**. Probably a stale version constant in
the CLI, but it made pinning a known-good build harder than it should be, and it
is why this report cites the source line rather than a version alone.
