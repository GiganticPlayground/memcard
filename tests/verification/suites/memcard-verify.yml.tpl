# =========================================================================
# MEMCARD — PayloadStash verification suite
#
# TEMPLATE. x-run-memcard-stash.sh renders __VERIFY_USER__ into a throwaway
# player id and writes the result to .run/memcard-verify.yml. Do not run this
# file directly — PayloadStash's URLPath is a literal string with no
# interpolation, so a per-run player id can only get in by substitution.
#
# Scope: Memcard only. The stack's other service (Token Weaver) is never called
# from here — the runner collects its token beforehand and passes it in as a
# secret, so every request below goes to Memcard and nothing else.
#
# What this asserts, in order:
#   health          service is up
#   authn           every way a credential can be refused (401 vs 403)
#   player_state    the ETag concurrency cycle on the token-scoped routes
#   admin_state     the same cycle on the URL-scoped routes, on a fresh player,
#                   which is the only place the sentinel ETag can be asserted
#   path_claims     tokens whose own claims narrow what they may reach
#   key_segments    a path segment the spec must reject
# =========================================================================

# Requests do NOT merge with Defaults.Headers — a request that declares Headers
# replaces them wholesale. So each one carries its full set, composed from these
# anchors, and Authorization appears ONLY where a request should be authenticated.
# That is also what makes the no-token case expressible: it declares no Headers at
# all and inherits a Defaults block that has no Authorization in it.
#
# Each `_AUTH` secret holds a COMPLETE Authorization header value, scheme and all,
# which is why nothing here spells out `Bearer`. That is not stylistic: secret
# scanners flag `Authorization: "Bearer <anything>"` on sight, and these lines were
# tripping GitGuardian while containing no secret at all — only the NAME of one.
# The scheme is applied in mint-tokens.mjs; see the comment there.
#
# The trade-off, stated plainly: this file no longer says which auth scheme it
# speaks. Memcard uses bearer tokens throughout.
json_headers: &json_headers
  Content-Type: application/json
  Accept: application/json

player_headers: &player_headers
  <<: *json_headers
  Authorization: { $secrets: PLAYER_AUTH }

static_headers: &static_headers
  <<: *json_headers
  Authorization: { $secrets: STATIC_AUTH }

hs256_headers: &hs256_headers
  <<: *json_headers
  Authorization: { $secrets: HS256_ADMIN_AUTH }

StashConfig:
  Name: MemcardVerify

  Defaults:
    URLRoot: http://host.docker.internal:3010
    FlowControl:
      DelaySeconds: 0
      TimeoutSeconds: 30
    # No Authorization here on purpose — see the note above the anchors.
    Headers:
      <<: *json_headers
    Retry:
      # Retry only what is genuinely transient. 429 is deliberately absent: the
      # limits suite asserts it, and retrying an expected status would hide it.
      Attempts: 3
      BackoffStrategy: exponential
      BackoffSeconds: 0.5
      Multiplier: 2.0
      MaxBackoffSeconds: 5
      Jitter: min
      RetryOnStatus: [502, 503, 504]
    Response:
      PrettyPrint: true
      Sort: true

  # No Forced.Body. The PUT schema is additionalProperties:false over a single
  # `state` key, so anything injected globally would be rejected as malformed.

  Sequences:
    # ------------------------------------------------------------------
    # 0. The service is up and is the one we think it is.
    # ------------------------------------------------------------------
    - Name: health
      Type: Sequential
      Requests:
        - health_ok:
            Method: GET
            URLPath: /health
            Expect:
              - status: 200
              - body.status: { equals: 'ok' }
              - body.service: { equals: 'memcard' }

    # ------------------------------------------------------------------
    # 1. Every way a credential gets refused.
    #
    # The 401/403 split is the point: 401 means the token did not verify, 403
    # means it verified and is still not allowed here. Memcard prefers 403 when
    # several strategies reject, because "authenticated but not permitted" tells
    # the caller more than "bad token".
    #
    # All reads, no writes, so running them concurrently is safe.
    # ------------------------------------------------------------------
    - Name: authn
      Type: Concurrent
      ConcurrencyLimit: 4
      Requests:
        # Declares no Headers: inherits Defaults, which carries no Authorization.
        - no_token:
            Method: GET
            URLPath: /v1/memcard/me/state
            Expect:
              - status: 401

        - forged_signature:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_BADSIG_AUTH }
            Expect:
              - status: 401

        - expired_token:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_EXPIRED_AUTH }
            Expect:
              - status: 401

        # A static token carries no claims, so it cannot name a player. The
        # compiler already refuses a non-admin static strategy; this asserts the
        # runtime half of the same rule.
        - static_on_player_route:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 403

        # The admin gate: a perfectly valid player token, refused purely because
        # its strategy is not marked admin.
        - player_on_admin_route:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *player_headers
            Expect:
              - status: 403

        # Signature and issuer are fine; the `scope` requirement is not met.
        - hs256_missing_scope:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_NOSCOPE_AUTH }
            Expect:
              - status: 403

        # Same, for the second requirement (claim_includes on `roles`), so a
        # failure names which check broke rather than "one of the two".
        - hs256_missing_role:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_NOROLE_AUTH }
            Expect:
              - status: 403

        # Fully authorized token whose own blacklist claim denies this path.
        - hs256_blacklisted_admin:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_BLACKLIST_AUTH }
            Expect:
              - status: 403

        # Whitelist names only the player routes, so this path is outside it.
        - hs256_whitelist_excludes_admin:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_WHITELIST_AUTH }
            Expect:
              - status: 403

        # Correctly signed and otherwise valid, but minted for another audience.
        # The strategy declares `audience: memcard`, so this must not verify.
        - wrong_audience:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_WRONGAUD_AUTH }
            Expect:
              - status: 401

        # Correctly signed with the right secret, but an issuer no strategy
        # declares — nothing can trace it back to a configuration.
        - unknown_issuer:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_UNKNOWNISS_AUTH }
            Expect:
              - status: 401

        # The player routes build the S3 key from the token's identity, so a
        # token that names no app cannot resolve to a key. 401, not 403: the
        # request is not refused by policy, the credential is incomplete.
        - missing_app_claim:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_NOAPP_AUTH }
            Expect:
              - status: 401

        - missing_sub_claim:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_NOSUB_AUTH }
            Expect:
              - status: 401

        # The static token's inline whitelist names my-game only. Same credential
        # that works throughout the admin sequence, refused for a different app —
        # which is what shows the list is enforced rather than decorative.
        - static_outside_inline_whitelist:
            Method: GET
            URLPath: /v1/memcard/admin/other-app/someone/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 403

        # Path rules carried by an RS256 player token, enforced through the jwks
        # strategy's blacklistClaim. Everything else in this sequence that tests
        # path claims goes through the HS256 strategy.
        - player_blacklisted_own_route:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: PLAYER_BLACKLIST_AUTH }
            Expect:
              - status: 403

    # ------------------------------------------------------------------
    # 2. The ETag cycle on the token-scoped routes.
    #
    # The player here is fixed (the token's `sub`), so this player carries state
    # from previous runs. Every assertion below is therefore written to hold
    # whatever the starting state is: nothing asserts a specific ETag value, only
    # the relationships between them.
    # ------------------------------------------------------------------
    - Name: player_state
      Type: Sequential
      Requests:
        - me_read:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
            Capture:
              meEtagBefore: headers.etag
            Expect:
              - status: 200
              - headers.etag: { exists: true }
              - body.state: { exists: true }
              # Part of the read contract and easy to drop silently, since a
              # client that only reads `state` would never notice.
              - body.lastModified: { exists: true }

        # The timestamp guarantees the body differs from whatever is stored, so
        # S3 always issues a new ETag — without it an identical write could echo
        # the old one and the conflict case below would silently stop testing.
        - me_write:
            Method: PUT
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-Match: { $pattern: '${captured:meEtagBefore}' }
            Body:
              state:
                suite: payloadstash
                route: me
                writtenAt: { $timestamp: { format: epoch_ms, when: request } }
            Capture:
              meEtagAfter: headers.etag
            Expect:
              - status: 200
              - body.success: { equals: true }
              - headers.etag: { exists: true }

        # Same ETag as the write above used — now stale. This is the whole reason
        # optimistic concurrency exists: a second client that never re-read.
        - me_write_stale:
            Method: PUT
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-Match: { $pattern: '${captured:meEtagBefore}' }
            Body:
              state:
                suite: payloadstash
                route: me
                shouldNotPersist: true
            Expect:
              - status: 409
              - body.errorCode: { equals: 'STATE_CONFLICT' }
              # The client needs this to reconcile, so its absence is a real bug
              # even though the status alone would look correct.
              - body.currentEtag: { exists: true }

        - me_read_not_modified:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-None-Match: { $pattern: '${captured:meEtagAfter}' }
            Expect:
              - status: 304

        # The mirror image: a stale validator must NOT short-circuit.
        - me_read_stale_validator:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-None-Match: { $pattern: '${captured:meEtagBefore}' }
            Expect:
              - status: 200
              - body.state.suite: { equals: 'payloadstash' }

    # ------------------------------------------------------------------
    # 3. The same cycle on the URL-scoped routes, against a player that has
    #    never existed. This is the only place the sentinel ETag and the
    #    create-only write can be asserted, because it is the only place the
    #    target is chosen by the caller rather than by the token.
    # ------------------------------------------------------------------
    - Name: admin_state
      Type: Sequential
      Requests:
        # A player with no stored state reads as empty with the sentinel ETag,
        # rather than as 404 — that is what lets a client treat "new" and
        # "existing" identically.
        - admin_read_absent:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 200
              - headers.etag: { equals: '0' }
              - body.state: { exists: true }

        # The sentinel in If-Match is translated to a create-only conditional
        # write, so this succeeds exactly once.
        - admin_create:
            Method: PUT
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *static_headers
              If-Match: '0'
            Body:
              state:
                suite: payloadstash
                route: admin
                marker: __VERIFY_USER__
                writtenAt: { $timestamp: { format: epoch_ms, when: request } }
            Capture:
              adminEtag: headers.etag
            Expect:
              - status: 200
              - body.success: { equals: true }
              - headers.etag: { notEquals: '0' }

        # Second create against a player that now exists. Proves the sentinel
        # really means create-only and not "overwrite whatever is there".
        - admin_create_again:
            Method: PUT
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *static_headers
              If-Match: '0'
            Body:
              state:
                suite: payloadstash
                shouldNotPersist: true
            Expect:
              - status: 409
              - body.errorCode: { equals: 'STATE_CONFLICT' }
              - body.currentEtag: { exists: true }

        # Round-trip: what came back is what went in, at the ETag we were given.
        - admin_read_back:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 200
              - headers.etag: { equals: { $pattern: '${captured:adminEtag}' } }
              - body.state.marker: { equals: '__VERIFY_USER__' }
              - body.state.shouldNotPersist: { exists: false }

        - admin_read_not_modified:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *static_headers
              If-None-Match: { $pattern: '${captured:adminEtag}' }
            Expect:
              - status: 304

        # The second admin credential — a different strategy type entirely —
        # reaching the same object. Everything above used the static token.
        - admin_read_via_hs256:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *hs256_headers
            Expect:
              - status: 200
              - body.state.marker: { equals: '__VERIFY_USER__' }

        - admin_write_via_hs256:
            Method: PUT
            URLPath: /v1/memcard/admin/my-game/__VERIFY_USER__/state
            Headers:
              <<: *hs256_headers
              If-Match: { $pattern: '${captured:adminEtag}' }
            Body:
              state:
                suite: payloadstash
                route: admin
                marker: __VERIFY_USER__
                writtenBy: hs256
            Expect:
              - status: 200
              - body.success: { equals: true }

    # ------------------------------------------------------------------
    # 4. The allow/deny side of the same tokens that were refused in `authn`.
    #    A claim that denies one route must not deny every route, or the tests
    #    above would pass for the wrong reason.
    #
    #    Reads only: a GET against a player with no state creates nothing, so
    #    these leave no objects behind.
    # ------------------------------------------------------------------
    - Name: path_claims
      Type: Concurrent
      ConcurrencyLimit: 2
      Requests:
        # blacklist covers /v1/memcard/admin/* only, so the player route is open.
        - blacklisted_token_on_player_route:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_BLACKLIST_AUTH }
            Expect:
              - status: 200
              - headers.etag: { exists: true }

        # whitelist names /v1/memcard/me/* explicitly, so this is the path it allows.
        - whitelisted_token_on_player_route:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: HS256_WHITELIST_AUTH }
            Expect:
              - status: 200
              - headers.etag: { exists: true }

        # The RS256 counterpart, through the jwks strategy's whitelistClaim. Its
        # blacklisted sibling is refused in `authn`; together they show the claim
        # is read on that strategy rather than merely configured on it.
        - player_whitelisted_own_route:
            Method: GET
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *json_headers
              Authorization: { $secrets: PLAYER_WHITELIST_AUTH }
            Expect:
              - status: 200
              - headers.etag: { exists: true }

    # ------------------------------------------------------------------
    # 5. A path segment the spec must refuse.
    #
    # `app` and `userId` become S3 key segments, so the spec constrains them to
    # [A-Za-z0-9._-] and rejects `.`/`..` outright. Auth runs before validation,
    # so this reaches the validator with a credential that is allowed here — the
    # 400 is the schema talking, not the auth layer.
    # ------------------------------------------------------------------
    - Name: key_segments
      Type: Concurrent
      ConcurrencyLimit: 4
      Requests:
        - rejects_illegal_character:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/not!a!segment/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 400

        # Percent-encoded on purpose. A bare `/./` or `/../` in the path is the
        # kind of thing an HTTP client may normalize away before the request
        # leaves, which would test the client rather than the service. Encoded,
        # nothing rewrites it and the segment arrives intact for the spec to
        # reject — `.` and `..` are called out explicitly in the pattern because
        # they are the two that would traverse the key layout.
        - rejects_dot_segment:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/%2E/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 400

        - rejects_dotdot_segment:
            Method: GET
            URLPath: /v1/memcard/admin/my-game/%2E%2E/state
            Headers:
              <<: *static_headers
            Expect:
              - status: 400

        # The write side of the same rule. Reads and writes are separate
        # operations in the spec, so validating one says nothing about the other.
        - rejects_illegal_character_on_write:
            Method: PUT
            URLPath: /v1/memcard/admin/my-game/not!a!segment/state
            Headers:
              <<: *static_headers
              If-Match: '0'
            Body:
              state:
                suite: payloadstash
            Expect:
              - status: 400

    # ------------------------------------------------------------------
    # 6. Requests the spec must refuse before anything else looks at them.
    #
    # Every one of these is a write that must NOT happen, so a pass here is also
    # evidence nothing was persisted. They run against the player routes, whose
    # target is fixed by the token — if one of them slipped through, it would
    # corrupt the state the player_state sequence just wrote.
    # ------------------------------------------------------------------
    - Name: malformed_requests
      Type: Concurrent
      ConcurrencyLimit: 3
      Requests:
        # If-Match is required on every write: without it a client cannot express
        # what it believes the current version to be, and the whole concurrency
        # model rests on that. Absent, the request is malformed, not a blind write.
        - put_without_if_match:
            Method: PUT
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
            Body:
              state:
                suite: payloadstash
                shouldNotPersist: true
            Expect:
              - status: 400

        # The update schema is additionalProperties:false over a single `state`
        # key, so a stray sibling is rejected rather than quietly dropped.
        - put_with_unknown_property:
            Method: PUT
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-Match: '0'
            Body:
              state:
                suite: payloadstash
              unexpected: true
            Expect:
              - status: 400

        - put_without_state:
            Method: PUT
            URLPath: /v1/memcard/me/state
            Headers:
              <<: *player_headers
              If-Match: '0'
            Body:
              suite: payloadstash
            Expect:
              - status: 400
