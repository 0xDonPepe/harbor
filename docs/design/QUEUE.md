# Design: the operation queue (decision 183)

**Status:** approved direction (Carlos, 2026-10-15): "install/uninstall/update apps must be able to be queued,
we don't want users to see blurred buttons. Also the queue should be able to be managed." Choices made with him:
same-app actions are queued and **planned at their turn**; managing = **cancel waiting items** (no reorder, no pause);
the **tray becomes the queue**, plus `harbor queue` in the CLI. Implemented in 0.35.0.
**Supersedes:** the console part of decision 173 for the queueable kinds below (other kinds keep its wait).
**Keeps:** decision 12 (no replay after interruption), one serial runner, plan → review → approve → operation.

## 1. What changes for the operator

- No action button is ever disabled because *another* operation runs. Buttons are disabled only for their own
  reasons (form validity, a confirm word, their own request in flight).
- Approving a reviewed plan always works when the app is free, whatever else is running: the operation waits its turn
  in the queue (this already worked in the engine; only the console greyed the buttons).
- An app that is busy (an operation of its own is running or waiting, an install included) still offers **Start,
  Stop, Restart, Update, Remove, Reinstall, Uninstall completely** (`purge`, typed confirm kept) where they make sense
  after what is ahead (after a waiting Remove only Uninstall completely; after a waiting purge nothing). The console
  asks once (dialog *Queue: Update Immich*, "Harbor is installing Immich right now." or "Immich is waiting to restart
  first.", then "Harbor will update it as soon as that finishes, planning it then. It stops and asks you only if it
  needs something new from you."), and the action joins the queue **without a plan**. When its turn comes Harbor makes
  the plan against the app as it is *then* and runs it, exactly like auto-update does. If that plan needs something
  only a person can give (a permission to accept, a value to type, a passphrase), the item stops as **Needs your
  review** (`failed`, code `REVIEW_NEEDED`) and nothing changes; any other planning error fails the item with that
  error.
- Each action on a busy app is judged by what the items ahead leave behind: Start only if the app ends up stopped,
  Restart only if it ends up running (a busy app whose desired state is running counts as running), Update only for an
  installed or installing app with no update ahead.
- The same action is not queued twice when it would change nothing: if the app's **last** unfinished item is the same
  kind, still waiting, and was queued by a person (not by Harbor's own actors, `INTERNAL_ACTORS`), the dialog says
  *Already queued: Update Immich* with its Cancel and *Keep it*, and the API returns that item (`created: false`).
  Anything else is a new item behind, so the last request always wins and a person's Stop never folds into a drive
  guard's. An update is the exception: any unfinished update of the app, wherever it is and whoever queued it
  (auto-update too), stands for a second one (*Already running: Update Immich* while it runs), because a second
  update could only fail with "already runs revision N".
- A review where the operator typed values, accepted permissions or changed settings never drops them into a queued
  action: if the app became busy meanwhile, the review waits for it and shows again (decision 173).
- Other kinds on a busy app (configure, publish/withdraw, main address, move, restore, encrypt, link changes) keep
  decision 173: their review waits for the app, then plans.
- The tray lists the queue: the running item (phase, progress), the waiting items in run order (each with **Cancel**
  when it may be cancelled, else one line saying why) and finished items: every item a person started (decided by its
  actor, so Update all, adopt, another tab or a reload count), anything showing a value once, failures of any actor.
  Successful items of Harbor's own actors leave by themselves. Each is dismissible; **Clear finished** clears all but shown-once values. It collapses to one line.
- `harbor queue` lists it, `harbor queue cancel <operation>` cancels a waiting item. A CLI action of a queueable kind
  on a busy app offers to queue it (`--yes` accepts) only when nothing comes with it; with `--accept-permissions`,
  `--passphrase-stdin` or values (`--set`, `--secret`, `--link`, storage) it waits for the app, then plans and
  reviews as before. `harbor start` on a locked app asks for its passphrase (or reads `--passphrase-stdin`), unlocks
  it for this boot first, then plans (and queues, if the app is busy); an app meant to be running starts by itself
  once its key is back, and the CLI follows that start instead of planning a second one.

## 2. Engine model

### 2.1 Storage (SCHEMA_VERSION 13, `migrateV12toV13`, table rebuild)

`operations`:
- `state` CHECK gains `'cancelled'` (final).
- `plan_id` becomes **nullable** (still UNIQUE, FK plans): NULL while a queued action waits to be planned.
- new `request_json TEXT` (nullable): the queued action `{kind, instanceId}` for an operation created without a plan.
  It never holds a secret (queueable kinds take no values).
- new `seq INTEGER NOT NULL UNIQUE`: the run order, `MAX(seq)+1` inside each INSERT. The migration numbers existing
  rows by `created_at, rowid`. The old `created_at, id` order shuffled same-second bursts (Update all; `id` is a random
  UUID), and any wall-clock order breaks when the clock steps back, which matters now that one app can have several
  items waiting.
- `started_at` now means **picked by the runner** (set atomically when it claims the head of the queue). Right before
  its kind's first step the runner moves the item to `applying` with phase `preparing`; until then (`state='queued'`,
  picked or not) nothing has been done.

### 2.2 Who owns an app while it is busy

`instances.active_operation_id` stays one column, meaning "the first not-final operation of this app, in run order".
It is recomputed (`syncActiveOperation(instanceId)`) whenever an operation of the app is accepted, finishes, is
cancelled or is recovered, so it moves to the next waiting item instead of becoming NULL while items wait. Every
existing BUSY guard and every background actor's "skip a busy app" keep working unchanged.

### 2.3 Accepting

- `POST /v1/operations {planId, …}`: unchanged (a reviewed plan; same-app BUSY still refused, decision 173 waits).
- `POST /v1/operations {action: {kind, instanceId}}` with an Idempotency-Key **queues an action** of a queueable kind
  (`start|stop|restart|update|remove|reinstall|purge`) for an existing app, busy or not. Inserts an operation row with
  `plan_id NULL`, `request_json`, actor = the caller, state `queued`, event "<kind> queued for <app>; planned when its
  turn comes". A duplicate per §1 (the app's last unfinished item, same kind, still waiting, not an internal actor's;
  for update any unfinished update) returns that item (`created: false`); its idempotency key is remembered in memory
  (bounded) so a retry with that key returns the same item, and the same key with another request is
  `IDEMPOTENCY_CONFLICT`. Refused:
  unknown app (NOT_FOUND), a kind outside the list (INVALID_REQUEST), an app whose full uninstall waits ahead
  (INVALID_STATE). No plan-time checks run now; they run at its turn.
- `applyAllUpdates` queues an action for a busy app instead of skipping it, and skips one with an update already
  queued.

### 2.4 Running (runner loop)

1. Claim the head atomically (`ORDER BY seq`, `state='queued' AND started_at IS NULL`, set `started_at`). A head
   cancelled meanwhile is skipped.
2. If `plan_id` is NULL: plan it now (`createPlan` as the operation's actor, allowed although the app's
   `active_operation_id` is this very operation), then accept it the way `submit` would with no typed values and
   permissions not accepted (port claims, consume the plan with this operation id, set `plan_id`).
   A refusal a person can resolve (`SECRET_MISSING`, `PERMISSION_REQUIRED`, `MACHINE_KEY_LOCKED`, a locked app's
   passphrase, `SETTING_INVALID`) finishes it `failed` with `REVIEW_NEEDED` ("Update Immich needs your review: …",
   next action "Open Immich and choose Update to review it."); any other error finishes it `failed` with that error.
   Nothing was changed, so the app's generation is **not** bumped. Only `auto-update` items ring the bell for this.
3. Defense in depth: a reviewed (non-install) plan whose app generation moved since it was accepted fails
   `STATE_CHANGED` ("<app> changed since this plan was reviewed; nothing was changed") and gives back its claims.
   Nothing legitimate moves a generation in between today (only finishing operations and recovery bump it, and a busy
   app refuses a reviewed plan), so this only catches an order bug.
4. If Harbor is stopping, a picked item that has not reached its first step is cancelled (§2.5 release, "Harbor
   stopped before this ran; nothing was changed.").
5. Mark `applying`/`preparing`, execute as today. A hand-made withdrawal of an app's main tailnet address adds the
   app to the every-app policy's exceptions when the withdrawal runs, not when it is approved, so a cancelled one
   leaves the policy alone.

### 2.5 Cancelling

`POST /v1/operations/:id/cancel` → the cancelled `OperationDto`.
- Only while `state='queued' AND started_at IS NULL` (atomic UPDATE); otherwise `NOT_CANCELLABLE` (409) "… is already
  running; a running step cannot be stopped safely." Finished → `NOT_CANCELLABLE` "… has finished".
- Not cancellable by a person (`NOT_CANCELLABLE`, says why): operations Harbor queues to protect something: actors
  `drive-guard`, `link-guard`, `lock-guard` and the backup `scheduler`'s cold pass (manual *Back up now* runs too).
  Person, CLI and `auto-update` items are cancellable. `OperationDto.cancellable` tells the client. New accounts may
  not take an internal actor name as their username (`INTERNAL_ACTORS` in `src/contracts/api.ts`); `enroll --reset`
  may keep an existing one.
- One release helper (`cancelNeverRun`) serves a person's cancel, the shutdown path (§2.4) and restart recovery
  (§2.6): state `cancelled`, `finished_at`, error `{code: 'CANCELLED', message, nextAction}`, event; drop its in-memory
  handovers (operator secrets, submitted settings, install-location/Start passphrase; the adopt key is locked again);
  release what accepting reserved: a **queued install** frees its instance row, name and port claims like the
  PLAN_STALE path and cancels that app's queued follow-ups; a **queued adopt** stays adoptable (the purged
  never-installed row with the drive's id is revived by the next adopt); a non-install gives back fixed-port claims
  its plan made that the app's current release does not publish. `syncActiveOperation`. No generation bump. The
  observer's one-attempt memories for that app are reset so a guard may act again; auto-update's `autoTried` is kept
  (otherwise it would queue the same update again at once).

### 2.6 Restart (decision 12 refined)

On daemon start every operation still in state `queued` (picked or not) becomes `cancelled` through the same helper,
with "Harbor restarted before this ran; nothing was changed." / "Queue it again."; its app is left as it was.
`applying`/`verifying` operations become `needs_action` exactly as before. No replay either way. A backup run whose
cold pass was cancelled this way fails with the restart message; the app was not stopped.

### 2.7 Final states

`succeeded | failed | needs_action | cancelled`. Every hard-coded final list knows `cancelled`: runner/backups
`waitOperation`, tailnet-all collect, CLI `waitOp`, the catalog-smoke and VM scripts, web `isFinal`, tray maps,
plain-status words.

## 3. API contract

- `OperationState` += `'cancelled'`.
- `OperationDto` += `actor: string`, `instanceName: string` (display name, kept for freed install rows),
  `cancellable: boolean`, `queuedAction: boolean` (true while it waits to be planned); `planId: string | null`.
- `GET /v1/operations?recent=<0..50, default 10>` → `OperationQueueDto { active: OperationDto[] /* run order, the
  running one first */, recent: OperationDto[] /* finished, newest first */ }`. List items carry `events: []`
  (fetch `GET /v1/operations/:id` for events and one-time results).
- `POST /v1/operations` body: `oneOf [{planId, passphrase?, secrets?, settings?, acceptPermissions?}, {action: {kind, instanceId}}]`.
- `POST /v1/operations/:id/cancel` → `OperationDto`.
- New error codes: `NOT_CANCELLABLE`, `REVIEW_NEEDED`, `CANCELLED` (all 409, CLI exit 3).
- `SystemDto.busyOperationId` stays (compatibility).

## 4. Console

- `store.ts`: no global `busy`. `c.queue` (`GET /v1/operations` every 2 s while anything is active, 10 s otherwise;
  the full refresh stays at 10 s and also runs when a tracked item finishes), `c.activeFor(instanceId)`,
  `c.cancelOperation(id)`. `start(action)`: a queueable kind on a busy app → the review dialog in **queue mode** (no
  plan; one idempotency key per dialog; the duplicate case shows *Already queued*); a BUSY at plan time does the same;
  a BUSY at approve after values were typed waits and re-reviews instead. Other kinds as before.
- Gates per app (`appActionGates`): a free app keeps its old gating; a busy one offers the queueable actions that can
  follow what is ahead. Navigation buttons are never disabled for busy.
- Tray = queue panel (§1). Waiting items have **Cancel** (`Cancel <verb> <app>`); not-cancellable ones say why in one
  quiet line (*Part of a backup run; it cannot be cancelled.*).
- Home tiles show the app's active operation: running → "Updating…/Removing…/Starting…/…", waiting → "Waiting…".
- `pnpm dev:ui` mocks: a running install, two waiting items (one not cancellable), cancel and dedupe work.

## 5. Tests

Unit: migration v12→v13 (seq order, nullable plan, cancelled), insertion order under a backward clock step, claim
and cancel, the queueable kinds, error codes, `needsReview`, reserved usernames, CLI `canQueueAction` and wording,
the console's pure queue helpers (`tests/unit/web-queue.test.ts`), the fake pull hold.
Integration (`tests/integration/queue.test.ts`; hold an operation with `h.fake.behaviour.respond = () => 503`):
different-app approval while busy; same-app queued action planned at its turn against the post-first-op state;
REVIEW_NEEDED; cancel a waiting install (name, ports, follow-ups freed); cancel running → NOT_CANCELLABLE; guard items
not cancellable; restart (never-run → cancelled, app untouched; picked-but-not-started → cancelled; applying →
needs_action); shutdown while planning; fixed-port release on cancel and restart; same-kind dedupe; the generation
guard; Update all queues busy apps; a waiting backup cold pass across a real restart; adopt cancelled then adopted
again (`app-homes.test.ts`); a cancelled tailnet withdrawal leaves the policy alone (`tailnet-all.test.ts`).
e2e (`ui.spec.ts` › queue): a held install (dev-only `HARBOR_DEV_FAKE_CONTROL` `{hold, match}`), buttons stay
enabled, the installing app's drawer queues *Uninstall completely* and it is cancelled, a second install and a
same-app Stop queue in order, the duplicate Stop shows *Already queued*, Cancel, release, results, Clear finished.
