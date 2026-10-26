interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Hyperliquid MCP — read-only market data from Hyperliquid's public info API.
 *
 * Hyperliquid is the largest onchain perpetuals exchange (and also runs a spot
 * market), and its market-data "info" endpoint (`POST api.hyperliquid.xyz/info`)
 * is keyless and public — no account, no signature, no wallet. This pack proxies
 * that endpoint live, per request; it never mirrors or bulk-copies Hyperliquid's
 * data (mirror-needs-grant-proxy-does-not, fleet #1389 — a live per-request proxy
 * of a public keyless upstream needs no grant).
 *
 * SCOPE, ON PURPOSE: read-only. Market data (perps/spot metadata, mid prices,
 * L2 order book, candles, funding history, live funding/open-interest context)
 * and PUBLIC ACCOUNT STATE read by wallet address (perp margin and positions,
 * spot balances, account value history) -- Hyperliquid serves these to anyone,
 * unauthenticated, because positions are on a public ledger. An address is a
 * pseudonymous on-chain identifier; nothing here links one to a person, and the
 * pack never accepts a key or signature. Nothing signs, trades or places an
 * order -- Hyperliquid's "exchange" endpoint (signed requests) is out of scope.
 *
 * All tool names prefixed `hyperliquid_` to avoid collisions with other
 * exchange/market-data packs (binance, coinmarketcap, etc).
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */


const UA = 'pipeworx-mcp-hyperliquid/1.0 (+https://pipeworx.io)';
const INFO_URL = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetchWithTimeout(
    INFO_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
    },
    'Hyperliquid',
  );
  if (!res.ok) throw await httpError(res, 'Hyperliquid');
  return res.json();
}

interface PerpAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  isDelisted?: boolean;
}

interface AssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs?: string[];
  dayBaseVlm: string;
}

/** Shared universe cache so hyperliquid_asset_context doesn't re-fetch `meta`
 *  on every call just to find a coin's index into the parallel assetCtxs array. */
let universeCache: { at: number; universe: PerpAsset[] } | null = null;
const UNIVERSE_TTL_MS = 60_000;

async function getPerpUniverse(): Promise<PerpAsset[]> {
  if (universeCache && Date.now() - universeCache.at < UNIVERSE_TTL_MS) return universeCache.universe;
  const data = (await hlInfo({ type: 'meta' })) as { universe: PerpAsset[] };
  const universe = data.universe ?? [];
  universeCache = { at: Date.now(), universe };
  return universe;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`"${key}" is required, e.g. ${example}`);
  }
  return v.trim();
}

/** Accepts ISO date/datetime or unix seconds/milliseconds, returns unix ms. */
function toMs(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) throw new Error(`Could not parse time "${s}" — use an ISO date/datetime or unix seconds/milliseconds.`);
  return parsed;
}


const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function reqAddress(args: Record<string, unknown>): string {
  const v = typeof args.address === 'string' ? args.address.trim() : '';
  if (!ADDRESS_RE.test(v)) {
    throw new Error('"address" must be a 0x-prefixed 42-character Hyperliquid wallet address, e.g. 0x31dea2516beee92135b96f464eeec3cf292a13f2. A key or signature is never needed or accepted.');
  }
  return v.toLowerCase();
}
const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) ? n : null;
};
const ACCOUNT_NOTE = 'Hyperliquid mainnet (its own L1, not Ethereum). Values in USD (USDC-margined). Account state is public on-chain data read live; "time" is the exchange\'s own snapshot time.';

/** Two separate facts about a perp account (fleet #3465).
 *  hasBalance: the account value is non-zero -- idle dust counts.
 *  hasOpenPositions: a position is open, or notional / margin is non-zero --
 *  current perp exposure; dust with nothing open is false. */
export function accountFlags(ms: Record<string, string | undefined>, positionCount: number): { hasBalance: boolean; hasOpenPositions: boolean } {
  const n = (v: string | undefined): number => {
    const x = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(x) ? x : 0;
  };
  return {
    hasBalance: n(ms.accountValue) !== 0,
    hasOpenPositions: positionCount > 0 || n(ms.totalNtlPos) !== 0 || n(ms.totalMarginUsed) !== 0,
  };
}

const VALID_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'];

const tools: McpToolExport['tools'] = [
  {
    name: 'hyperliquid_perp_meta',
    description:
      'Perpetuals universe metadata from Hyperliquid\'s public info API ({"type":"meta"}) — every perp contract Hyperliquid lists (currently 190+), each with its symbol, szDecimals (size precision), maxLeverage, and isDelisted when retired. This is the reference list to resolve a human-asked symbol ("BTC", "ETH", "SOL") to a contract Hyperliquid actually trades before calling hyperliquid_mids, hyperliquid_l2_book, hyperliquid_candles or hyperliquid_funding_history with it — those all take the bare coin symbol shown here (e.g. "BTC", not "BTC-PERP"). Pass `coin` to look up one symbol instead of the full list.',
    summary: "Hyperliquid's full list of tradeable perpetual contracts and their leverage/precision limits, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Optional — filter to one perp symbol, e.g. "BTC" or "ETH". Omit to list the whole universe.' },
      },
    },
  },
  {
    name: 'hyperliquid_spot_meta',
    description:
      'Spot market metadata from Hyperliquid\'s public info API ({"type":"spotMeta"}) — every spot trading pair Hyperliquid lists, each with its pair name (e.g. "PURR/USDC"), pair index, the two token ids it is composed of, and whether it is the canonical listing for that token. Hyperliquid names most non-canonical spot pairs generically ("@1", "@2", ...) because the human-readable name belongs to the canonical pair; this tool returns Hyperliquid\'s raw naming as-is. Use the `index` from here as the `coin` argument to hyperliquid_l2_book/hyperliquid_candles for a spot pair, in the form "@<index>" (Hyperliquid\'s own convention for spot coin ids distinct from perp symbols).',
    summary: "Hyperliquid's full list of spot trading pairs and the tokens behind them, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hyperliquid_mids',
    description:
      'Live mid prices (midpoint of best bid/ask) for every asset Hyperliquid tracks — perps by symbol ("BTC", "ETH", ...) and spot pairs by numeric id ("@0", "@1", ...) — in one call, from Hyperliquid\'s public info API ({"type":"allMids"}). This is the cheapest way to get a current price: one request returns 1,000+ symbols. Pass `coin` to get just one symbol\'s mid price instead of the full map.',
    summary: "Every current mid price on Hyperliquid (perps + spot) in one call, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Optional — return only this symbol\'s mid price, e.g. "BTC" or "ETH". Omit to get the full map.' },
      },
    },
  },
  {
    name: 'hyperliquid_asset_context',
    description:
      'Live perp market context for one contract — current funding rate, open interest, mark price, oracle price, mid price, 24h premium, and 24h notional + base volume — from Hyperliquid\'s public info API ({"type":"metaAndAssetCtxs"}, matched to the requested coin by universe index). This is the single call that answers "what is BTC perp funding right now" or "what is Hyperliquid\'s open interest in ETH" — the live numbers next to kalshi_* and polymarket_* for anyone pricing crypto-adjacent prediction markets. For a HISTORY of funding rates rather than the current one, use hyperliquid_funding_history.',
    summary: "A Hyperliquid perp's live funding rate, open interest, mark/oracle price and 24h volume, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Perp symbol, e.g. "BTC", "ETH", "SOL". See hyperliquid_perp_meta for the full list.' },
      },
      required: ['coin'],
    },
  },
  {
    name: 'hyperliquid_l2_book',
    description:
      'Live level-2 order book (bids + asks, each with price, aggregate size, and order count) for one Hyperliquid perp or spot symbol, from Hyperliquid\'s public info API ({"type":"l2Book"}). Returns two arrays — bids (best first, descending price) and asks (best first, ascending price) — each entry {px, sz, n}. Use `depth` to trim to the top N levels per side; Hyperliquid itself returns the full book (often 20+ levels per side) when depth is omitted.',
    summary: "The live bid/ask order book for one Hyperliquid market, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Perp symbol (e.g. "BTC") or spot pair id (e.g. "@0" from hyperliquid_spot_meta, or the canonical name like "PURR/USDC").' },
        depth: { type: 'number', description: 'Levels to keep per side, best-first (default: all levels Hyperliquid returns, typically 20+). Pass e.g. 5 for just the top of book.' },
      },
      required: ['coin'],
    },
  },
  {
    name: 'hyperliquid_candles',
    description:
      'OHLCV candles for one Hyperliquid perp or spot symbol, from Hyperliquid\'s public info API ({"type":"candleSnapshot"}). Each candle: open/high/low/close/volume (base units), trade count, and the interval\'s start/end timestamps. Pass `lookback_hours` for a window ending now (default 24h), or an explicit `start_time`/`end_time` (ISO date/datetime or unix seconds/milliseconds) for a specific historical window — Hyperliquid retains candle history well beyond 24h. `interval` accepts Hyperliquid\'s own granularities: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M.',
    summary: "OHLCV price candles for one Hyperliquid market, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Perp symbol (e.g. "BTC") or spot pair id/name (e.g. "@0" or "PURR/USDC").' },
        interval: { type: 'string', description: '1m | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 8h | 12h | 1d | 3d | 1w | 1M (default "1h")' },
        lookback_hours: { type: 'number', description: 'Window length ending now, in hours (default 24). Ignored when start_time is given.' },
        start_time: { type: 'string', description: 'Window START — ISO date/datetime or unix seconds/milliseconds. Use with end_time for a window that does not end now.' },
        end_time: { type: 'string', description: 'Window END — same formats as start_time. Defaults to now.' },
      },
      required: ['coin'],
    },
  },
  {
    name: 'hyperliquid_funding_history',
    description:
      'Historical funding-rate payments for one Hyperliquid perp — timestamped funding rate and premium at each funding interval (hourly on Hyperliquid), from Hyperliquid\'s public info API ({"type":"fundingHistory"}). Use this to see how funding has trended (e.g. persistently positive BTC funding = longs paying shorts = crowded long), or to reconstruct realized funding cost over a window. For the CURRENT funding rate only, hyperliquid_asset_context is cheaper (one call, no window math).',
    summary: "A Hyperliquid perp's funding-rate history over time, from Hyperliquid's own API.",
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Perp symbol, e.g. "BTC", "ETH", "SOL".' },
        lookback_hours: { type: 'number', description: 'Window length ending now, in hours (default 24, funding pays hourly so this returns ~1 row/hour). Ignored when start_time is given.' },
        start_time: { type: 'string', description: 'Window START — ISO date/datetime or unix seconds/milliseconds. Use with end_time for a window that does not end now.' },
        end_time: { type: 'string', description: 'Window END — same formats as start_time. Defaults to now.' },
      },
      required: ['coin'],
    },
  },
  {
    name: 'hyperliquid_account_state',
    description:
      'Perpetuals account state for one Hyperliquid wallet address -- two separate flags (account_has_balance: non-zero account value, idle dust included; account_has_open_perp_positions: a position is open or notional / margin is non-zero), then account value, total notional, margin used, withdrawable, cross-maintenance margin, and every open perp position (coin, signed size where negative = short, entry price, position value, unrealized PnL, ROE, liquidation price, leverage, margin used, cumulative funding). Public on-chain data, keyless. Use for "what is this Hyperliquid wallet\'s position / margin / leverage". Returns aggregates first, positions last. e.g. {address:"0x31dea2516beee92135b96f464eeec3cf292a13f2"}.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: '0x-prefixed 42-character wallet address.' } },
      required: ['address'],
    },
  },
  {
    name: 'hyperliquid_spot_balances',
    description:
      'Spot token balances for one Hyperliquid wallet address -- per token: total, amount on hold in open orders, available (total minus hold) and entry notional in USDC. Includes the spot USDC balance. Public on-chain data, keyless. Use for "what tokens does this Hyperliquid wallet hold". e.g. {address:"0x31dea2516beee92135b96f464eeec3cf292a13f2"}.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '0x-prefixed 42-character wallet address.' },
        limit: { type: 'number', description: 'Max token rows to return, largest first (default 50). Totals always cover every token.' },
      },
      required: ['address'],
    },
  },
  {
    name: 'hyperliquid_account_history',
    description:
      'Account value and PnL history for one Hyperliquid wallet address over a day, week, month or all time -- starting and ending account value, PnL change, trading volume, then a downsampled series. Scope "combined" is perp plus spot; "perp" is perp only. Public on-chain data, keyless. e.g. {address:"0x31dea2516beee92135b96f464eeec3cf292a13f2", period:"week"}.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '0x-prefixed 42-character wallet address.' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'allTime'], description: 'Window (default "week").' },
        scope: { type: 'string', enum: ['combined', 'perp'], description: '"combined" (default) = perp + spot; "perp" = perp only.' },
      },
      required: ['address'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'hyperliquid_perp_meta': {
      const universe = await getPerpUniverse();
      if (typeof args.coin === 'string' && args.coin.trim()) {
        const coin = args.coin.trim().toUpperCase();
        const match = universe.find((a) => a.name.toUpperCase() === coin);
        if (!match) {
          return {
            found: false,
            coin: args.coin,
            universe_size: universe.length,
            hint: `No Hyperliquid perp named "${args.coin}". Call hyperliquid_perp_meta with no "coin" to see the full list.`,
          };
        }
        return { found: true, asset: match, source: 'hyperliquid' };
      }
      return {
        count: universe.length,
        assets: universe,
        source: 'hyperliquid',
        as_of: new Date().toISOString(),
      };
    }

    case 'hyperliquid_spot_meta': {
      const data = (await hlInfo({ type: 'spotMeta' })) as {
        universe?: Array<{ name: string; tokens: number[]; index: number; isCanonical: boolean }>;
        tokens?: Array<{ name: string; index: number; szDecimals: number; weiDecimals: number }>;
      };
      return {
        count: data.universe?.length ?? 0,
        pairs: data.universe ?? [],
        tokens: data.tokens ?? [],
        source: 'hyperliquid',
        as_of: new Date().toISOString(),
        note: 'A spot pair\'s "index" is the id to pass as coin ("@<index>") to hyperliquid_l2_book/hyperliquid_candles. Non-canonical pairs are named "@N" by Hyperliquid itself, not by Pipeworx.',
      };
    }

    case 'hyperliquid_mids': {
      const data = (await hlInfo({ type: 'allMids' })) as Record<string, string>;
      if (typeof args.coin === 'string' && args.coin.trim()) {
        const coin = args.coin.trim();
        const key = coin in data ? coin : coin.toUpperCase();
        if (!(key in data)) {
          return {
            found: false,
            coin,
            total_symbols: Object.keys(data).length,
            hint: `No mid price for "${coin}". Perp symbols use plain names ("BTC"); spot pairs use "@<index>" from hyperliquid_spot_meta. Call hyperliquid_mids with no "coin" to see every symbol.`,
          };
        }
        return { found: true, coin: key, mid_price: data[key], source: 'hyperliquid', as_of: new Date().toISOString() };
      }
      return {
        count: Object.keys(data).length,
        mids: data,
        source: 'hyperliquid',
        as_of: new Date().toISOString(),
        note: 'Keys are perp symbols ("BTC", "ETH", ...) and spot pair ids ("@0", "@1", ...). Use hyperliquid_spot_meta to resolve a spot "@N" id to its pair name.',
      };
    }

    case 'hyperliquid_asset_context': {
      const coin = reqStr(args, 'coin', '"BTC"').toUpperCase();
      const data = (await hlInfo({ type: 'metaAndAssetCtxs' })) as [{ universe: PerpAsset[] }, AssetCtx[]];
      const [{ universe }, ctxs] = data;
      const idx = universe.findIndex((a) => a.name.toUpperCase() === coin);
      if (idx === -1) {
        return {
          found: false,
          coin: args.coin,
          universe_size: universe.length,
          hint: `No Hyperliquid perp named "${args.coin}". Call hyperliquid_perp_meta to see the full list.`,
        };
      }
      const ctx = ctxs[idx];
      return {
        found: true,
        coin: universe[idx].name,
        funding_rate: ctx.funding,
        funding_rate_note: 'Per-interval rate (Hyperliquid pays hourly); multiply by 24 for an approximate daily rate, or see hyperliquid_funding_history for the realized series.',
        open_interest: ctx.openInterest,
        open_interest_unit: 'base asset units (e.g. BTC for the BTC perp), not USD',
        mark_price: ctx.markPx,
        oracle_price: ctx.oraclePx,
        mid_price: ctx.midPx,
        prev_day_price: ctx.prevDayPx,
        premium: ctx.premium,
        day_notional_volume_usd: ctx.dayNtlVlm,
        day_base_volume: ctx.dayBaseVlm,
        max_leverage: universe[idx].maxLeverage,
        source: 'hyperliquid',
        as_of: new Date().toISOString(),
      };
    }

    case 'hyperliquid_l2_book': {
      const coin = reqStr(args, 'coin', '"BTC"');
      const data = (await hlInfo({ type: 'l2Book', coin })) as {
        coin: string;
        time: number;
        levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
      };
      if (!data.levels) {
        return { found: false, coin, hint: `Hyperliquid has no order book for "${coin}". Check the symbol with hyperliquid_perp_meta or hyperliquid_spot_meta.` };
      }
      const depth = typeof args.depth === 'number' && args.depth > 0 ? Math.floor(args.depth) : undefined;
      const [bidsRaw, asksRaw] = data.levels;
      const bids = depth ? bidsRaw.slice(0, depth) : bidsRaw;
      const asks = depth ? asksRaw.slice(0, depth) : asksRaw;
      return {
        found: true,
        coin: data.coin,
        time: data.time,
        as_of: new Date(data.time).toISOString(),
        bids,
        asks,
        bids_levels_available: bidsRaw.length,
        asks_levels_available: asksRaw.length,
        fields: 'px = price, sz = aggregate size at that price, n = number of orders at that price',
        source: 'hyperliquid',
      };
    }

    case 'hyperliquid_candles': {
      const coin = reqStr(args, 'coin', '"BTC"');
      const intervalRaw = typeof args.interval === 'string' && args.interval.trim() ? args.interval.trim() : '1h';
      const interval = VALID_INTERVALS.includes(intervalRaw) ? intervalRaw : '1h';
      const now = Date.now();
      const endTime = toMs(args.end_time, now);
      const lookbackMs = (typeof args.lookback_hours === 'number' && args.lookback_hours > 0 ? args.lookback_hours : 24) * 3_600_000;
      const startTime = args.start_time !== undefined ? toMs(args.start_time, endTime - lookbackMs) : endTime - lookbackMs;
      const data = (await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime },
      })) as Array<{ t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }>;
      if (!data.length) {
        return {
          found: false,
          coin,
          interval,
          interval_invalid: intervalRaw !== interval ? intervalRaw : undefined,
          start_time: new Date(startTime).toISOString(),
          end_time: new Date(endTime).toISOString(),
          hint: `No candles for "${coin}" at interval "${interval}" in this window. Check the symbol with hyperliquid_perp_meta/hyperliquid_spot_meta, widen the window, or confirm interval is one of ${VALID_INTERVALS.join(', ')}.`,
        };
      }
      return {
        found: true,
        coin,
        interval,
        count: data.length,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        candles: data.map((c) => ({
          open_time: new Date(c.t).toISOString(),
          close_time: new Date(c.T).toISOString(),
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
          trades: c.n,
        })),
        source: 'hyperliquid',
      };
    }

    case 'hyperliquid_funding_history': {
      const coin = reqStr(args, 'coin', '"BTC"');
      const now = Date.now();
      const endTime = toMs(args.end_time, now);
      const lookbackMs = (typeof args.lookback_hours === 'number' && args.lookback_hours > 0 ? args.lookback_hours : 24) * 3_600_000;
      const startTime = args.start_time !== undefined ? toMs(args.start_time, endTime - lookbackMs) : endTime - lookbackMs;
      const data = (await hlInfo({ type: 'fundingHistory', coin, startTime, endTime })) as Array<{
        coin: string;
        fundingRate: string;
        premium: string;
        time: number;
      }>;
      if (!data.length) {
        return {
          found: false,
          coin,
          start_time: new Date(startTime).toISOString(),
          end_time: new Date(endTime).toISOString(),
          hint: `No funding history for "${coin}" in this window. Check the symbol with hyperliquid_perp_meta, or widen the window — Hyperliquid pays funding hourly, so a window under 1h can legitimately be empty.`,
        };
      }
      return {
        found: true,
        coin,
        count: data.length,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        funding: data.map((f) => ({ time: new Date(f.time).toISOString(), funding_rate: f.fundingRate, premium: f.premium })),
        source: 'hyperliquid',
      };
    }

    case 'hyperliquid_account_state': {
      const address = reqAddress(args);
      const d = (await hlInfo({ type: 'clearinghouseState', user: address })) as {
        marginSummary?: Record<string, string>;
        crossMarginSummary?: Record<string, string>;
        crossMaintenanceMarginUsed?: string;
        withdrawable?: string;
        assetPositions?: Array<{ position: Record<string, unknown> }>;
        time?: number;
      };
      const ms = d.marginSummary ?? {};
      const positions = (d.assetPositions ?? []).map((a) => {
        const p = a.position ?? {};
        const szi = num(p.szi);
        return {
          coin: p.coin,
          side: szi === null ? null : szi < 0 ? 'short' : 'long',
          size: p.szi,
          entry_price: p.entryPx,
          position_value_usd: p.positionValue,
          unrealized_pnl_usd: p.unrealizedPnl,
          return_on_equity: p.returnOnEquity,
          liquidation_price: p.liquidationPx,
          leverage: p.leverage,
          margin_used_usd: p.marginUsed,
          cumulative_funding: p.cumFunding,
        };
      });
      const flags = accountFlags(ms, positions.length);
      return {
        address,
        // TWO different facts, deliberately two fields (fleet #3465). This used
        // to be one boolean named account_has_perp_activity that was really
        // `positions > 0 OR accountValue != 0`: a wallet holding one dollar of
        // idle margin and no position read as having perp activity, so a caller
        // that routed on it then met an empty positions array.
        account_has_balance: flags.hasBalance,
        account_has_open_perp_positions: flags.hasOpenPositions,
        account_value_usd: ms.accountValue ?? null,
        total_notional_position_usd: ms.totalNtlPos ?? null,
        total_margin_used_usd: ms.totalMarginUsed ?? null,
        withdrawable_usd: d.withdrawable ?? null,
        cross_maintenance_margin_used_usd: d.crossMaintenanceMarginUsed ?? null,
        open_position_count: positions.length,
        positions,
        snapshot_time: d.time ? new Date(d.time).toISOString() : null,
        ...(flags.hasOpenPositions
          ? {}
          : flags.hasBalance
            ? { hint: 'This address holds a perp account balance but has NO open perp positions (zero positions, notional and margin used). The balance is idle margin, not trading activity; past trades would show in hyperliquid_account_history.' }
            : { hint: 'This address has no perp account value or positions on Hyperliquid. It may be new, spot-only (see hyperliquid_spot_balances), or mistyped -- Hyperliquid answers zeros, not an error, for an unknown address.' }),
        note: ACCOUNT_NOTE + ' account_has_balance = the perp account value is non-zero (says nothing about trading); account_has_open_perp_positions = at least one open position, or non-zero notional or margin used (current perp exposure).',
        source: 'hyperliquid',
      };
    }

    case 'hyperliquid_spot_balances': {
      const address = reqAddress(args);
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      const d = (await hlInfo({ type: 'spotClearinghouseState', user: address })) as {
        balances?: Array<{ coin: string; token: number; total: string; hold: string; entryNtl: string }>;
      };
      const rows = (d.balances ?? []).map((b) => {
        const total = num(b.total) ?? 0;
        const hold = num(b.hold) ?? 0;
        return { coin: b.coin, token: b.token, total: b.total, hold: b.hold, available: String(Math.max(total - hold, 0)), entry_notional_usdc: b.entryNtl };
      });
      if (!rows.length) {
        return {
          address,
          found: false,
          token_count: 0,
          hint: 'No spot balances for this address. It may hold only perp margin (see hyperliquid_account_state), be new, or be mistyped -- Hyperliquid answers an empty list, not an error, for an unknown address.',
          note: ACCOUNT_NOTE,
          source: 'hyperliquid',
        };
      }
      rows.sort((a, b) => (num(b.entry_notional_usdc) ?? 0) - (num(a.entry_notional_usdc) ?? 0));
      const usdc = rows.find((r) => r.coin === 'USDC');
      return {
        address,
        found: true,
        token_count: rows.length,
        spot_usdc_total: usdc?.total ?? null,
        total_entry_notional_usdc: String(rows.reduce((t, r) => t + (num(r.entry_notional_usdc) ?? 0), 0)),
        returned: Math.min(limit, rows.length),
        balances: rows.slice(0, limit),
        note: ACCOUNT_NOTE + ' entry_notional_usdc is the cost basis, not a live mark-to-market value; rows are sorted by it.',
        source: 'hyperliquid',
      };
    }

    case 'hyperliquid_account_history': {
      const address = reqAddress(args);
      const period = typeof args.period === 'string' && args.period ? args.period : 'week';
      if (!['day', 'week', 'month', 'allTime'].includes(period)) throw new Error('period must be one of: day, week, month, allTime.');
      const perp = args.scope === 'perp';
      const key = perp ? 'perp' + period[0].toUpperCase() + period.slice(1) : period;
      const d = (await hlInfo({ type: 'portfolio', user: address })) as Array<[string, { accountValueHistory?: Array<[number, string]>; pnlHistory?: Array<[number, string]>; vlm?: string }]>;
      const entry = d.find((e) => e[0] === key)?.[1];
      const av = entry?.accountValueHistory ?? [];
      const pnl = entry?.pnlHistory ?? [];
      if (!entry || av.length === 0) {
        return {
          address, period, scope: perp ? 'perp' : 'combined', found: false,
          hint: 'No account value history for this address in that window. It may be new, inactive, or mistyped.',
          available_windows: d.map((e) => e[0]),
          note: ACCOUNT_NOTE, source: 'hyperliquid',
        };
      }
      const step = Math.max(1, Math.ceil(av.length / 50));
      const series = av.filter((_, i) => i % step === 0 || i === av.length - 1).map(([t, v]) => ({
        time: new Date(t).toISOString(),
        account_value_usd: v,
        pnl_usd: pnl.find((x) => x[0] === t)?.[1] ?? null,
      }));
      const first = num(av[0][1]);
      const last = num(av[av.length - 1][1]);
      return {
        address, period, scope: perp ? 'perp' : 'combined', found: true,
        start_account_value_usd: av[0][1],
        end_account_value_usd: av[av.length - 1][1],
        account_value_change_usd: first !== null && last !== null ? String(last - first) : null,
        pnl_change_usd: pnl.length ? String((num(pnl[pnl.length - 1][1]) ?? 0) - (num(pnl[0][1]) ?? 0)) : null,
        trading_volume_usd: entry.vlm ?? null,
        window_start: new Date(av[0][0]).toISOString(),
        window_end: new Date(av[av.length - 1][0]).toISOString(),
        points_total: av.length,
        series,
        note: ACCOUNT_NOTE + ' account_value_change includes deposits and withdrawals; pnl_change excludes them.',
        source: 'hyperliquid',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
