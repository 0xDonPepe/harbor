# Design: the operation queue (decision 183)

**Status:** approved direction (Carlos, 2026-10-15): "install/uninstall/update apps must be able to be queued,
we don't want users to see blurred buttons. Also the queue should be able to be managed." Choices made with him:
same-app actions are queued and **planned at their turn**; managing = **cancel waiting items** (no reorder, no pause);
the **tray becomes the queue**, plus `harbor queue` in the CLI.
**Supersedes:** the console part of decision 173 for the queueable kinds below (other kinds keep its wait).
**Keeps:** decision 12 (no replay after interruption), one serial runner, plan → review → approve → operation.

## 1. What changes for the operator

- No action button is ever disabled because *another* operation runs. Buttons are disabled only for their own
  reasons (form validity, a confirm word, their own request in flight).
- Approving a reviewed plan always works when the app is free, whatever else is running: the operation waits its turn
  in the queue (this already worked in the engine; only the console greyed the buttons).
- An app that is busy (an operation of its own is running or waiting) still accepts **Start, Stop, Restart, Update,
  Remove, Reinstall, Uninstall completely** (`purge`). The console asks once ("Queue: Update Immich — it runs after
  Immich's install"), and the action joins the queue **without a plan**. When its turn comes Harbor makes the plan
  against the app as it is *then* and runs it, exactly like auto-update does. If that plan needs something only a
  person can give (a permission to accept, a value to type, a passphrase), the item stops as **Needs your review**
  (`failed`, code `REVIEW_NEEDED`) and nothing changes; any other planning error fails the item with that error.
- Other kinds on a busy app (configure, publish/withdraw, main address, move, restore, encrypt, link changes) keep
  decision 173: their review waits for the app, then plans.
- The tray lists the queue: the running item (phase, progress), the waiting items in run order (each with **Cancel**
  when it may be cancelled) and the items this console saw finish (results, shown-once credentials and recovery
  words, errors), each dismissible. It collapses to one line.
- `harbor queue` lists it, `harbor queue cancel <operation>` cancels a waiting item. A CLI action on a busy app of a
  queueable kind offers to queue it (`--yes` accepts) instead of waiting.

## 2. Engine model

### 2.1 Storage (SCHEMA_VERSION 13, `migrateV12toV13`, table rebuild)

`operations`:
- `state` CHECK gains `'cancelled'` (final).
- `plan_id` becomes **nullable** (still UNIQUE, FK plans): NULL while a queued action waits to be planned.
- new `request_json TEXT` (nullable): the queued action `{kind, instanceId}` for an operation created without a plan.
  It never holds a secret (queueable kinds take no values).
- Run order is `ORDER BY created_at, rowid` (rowid = insertion order; `created_at` has second precision and `id` is a
  random UUID, so the old `created_at, id` order shuffled same-second bursts such as Update all). The rebuild copies
  rows `ORDER BY created_at, rowid` so the order survives.
- `started_at` now means **picked by the runner** (set atomically when the runner claims the head of the queue,
  before any side effect), no longer "first `applying` phase". `started_at IS NULL` ⇔ nothing has been done yet.

### 2.2 Who owns an app while it is busy

`instances.active_operation_id` stays one column, meaning "the first not-final operation of this app, in run order".
It is recomputed (`syncActiveOperation(instanceId)`) whenever an operation of the app is accepted, finishes, is
cancelled or is recovered, so it moves to the next waiting item instead of becoming NULL while items wait. Every
existing BUSY guard and every background actor's "skip a busy app" keep working unchanged.

### 2.3 Accepting

- `POST /v1/operations {planId, …}` — unchanged (a reviewed plan; same-app BUSY still refused, decision 173 waits).
- `POST /v1/operations {action: {kind, instanceId}}` with an Idempotency-Key — **queues an action** of a queueable kind
  (`start|stop|restart|update|remove|reinstall|purge`) for an existing app, busy or not. Inserts an operation row with
  `plan_id NULL`, `request_json`, actor = the caller, state `queued`, phase `queued`, event "<kind> queued for <app>;
  planned when its turn comes". Refused: unknown app (NOT_FOUND), a kind outside the list (INVALID_REQUEST), an app
  being uninstalled completely ahead in the queue (INVALID_STATE "… is being removed completely"). No plan-time
  checks run now; they run at its turn.
- `applyAllUpdates` queues an action for a busy app instead of skipping it ("another operation is running").

### 2.4 Running (runner loop)

1. Claim the head atomically: `UPDATE operations SET started_at=? WHERE id=(head) AND state='queued' AND started_at IS NULL`.
   0 rows → it was cancelled meanwhile; take the next.
2. If `plan_id` is NULL: plan it now (`createPlan` as the operation's actor, allowed although the app's
   `active_operation_id` is this very operation), then accept it the way `submit` would with no typed values and
   permissions not accepted (port claims, generation, consume the plan with this operation id, set `plan_id`).
   A refusal a person can resolve (`SECRET_MISSING`, `PERMISSION_REQUIRED`, `MACHINE_KEY_LOCKED`, a required
   install-location passphrase, `SETTING_INVALID`) finishes it `failed` with `REVIEW_NEEDED` ("Update Immich needs
   your review: …", next action "Open Immich and choose Update to review it."); any other error finishes it `failed`
   with that error. Nothing was changed, so the app's generation is **not** bumped for these.
3. Execute as today.

### 2.5 Cancelling

`POST /v1/operations/:id/cancel` → the cancelled `OperationDto`.
- Only while `state='queued' AND started_at IS NULL` (atomic UPDATE); otherwise `NOT_CANCELLABLE` (409) "… is already
  running; a running step cannot be stopped safely." Finished → `NOT_CANCELLABLE` "… has finished".
- Not cancellable by a person (`NOT_CANCELLABLE`, says why): operations queued by Harbor to protect something —
  actors `drive-guard`, `link-guard`, `lock-guard` and the backup `scheduler`'s cold pass. Owner, CLI and `auto-update`
  items are cancellable. `OperationDto.cancellable` tells the client.
- Effects (one transaction): state `cancelled`, `finished_at`, error `{code: 'CANCELLED', message: 'Cancelled by you
  before it started; nothing was changed.', nextAction: ''}`, event; drop its in-memory handovers (operator secrets,
  submitted settings, install-location/Start passphrase, adopt unlock hold); release what accepting reserved:
  a **queued install** frees its instance row, name and port claims exactly like the PLAN_STALE path
  (`purgeInstance(id, '<name>~cancelled~<id8>')`) and also cancels that app's queued follow-ups; a non-install
  releases fixed-port claims it made that the app's current release does not use. `syncActiveOperation`. No
  generation bump (nothing changed). Background actors' one-attempt memories for that app are reset, so a guard
  may act again.

### 2.6 Restart (decision 12 refined)

On daemon start: operations with `started_at IS NULL` (never picked) become `cancelled` with error
`{code: 'CANCELLED', message: 'Harbor restarted before this ran; nothing was changed.', nextAction: 'Queue it again.'}`;
their app is left as it was (a queued install's row is freed as in 2.5). Picked operations (`started_at` set) become
`needs_action` exactly as before. No replay either way.

### 2.7 Final states

`succeeded | failed | needs_action | cancelled`. Every hard-coded final list learns `cancelled`: runner/backups
`waitOperation` (a cancelled cold pass ends that backup run as failed/"cancelled"), tailnet-all collect, CLI `waitOp`,
web `isFinal`, tray maps, plain-status words.

## 3. API contract

- `OperationState` += `'cancelled'`.
- `OperationDto` += `actor: string`, `instanceName: string` (display name, kept for freed install rows),
  `cancellable: boolean`, `queuedAction: boolean` (true while it waits to be planned); `planId: string | null`.
- `GET /v1/operations?recent=<0..50, default 10>` → `OperationQueueDto { active: OperationDto[] /* run order, the
  running one first */, recent: OperationDto[] /* finished, newest first */ }`. List items carry `events: []`
  (fetch `GET /v1/operations/:id` for events and one-time results).
- `POST /v1/operations` body: `oneOf [{planId, passphrase?, secrets?, settings?, acceptPermissions?}, {action: {kind, instanceId}}]`.
- `POST /v1/operations/:id/cancel` → `OperationDto`.
- New error codes: `NOT_CANCELLABLE` (409), `REVIEW_NEEDED` (409, appears on operations), `CANCELLED` (409, appears on operations).
- `SystemDto.busyOperationId` stays (compatibility).

## 4. Console

- `store.ts`: no global `busy`. `c.queue` (from `GET /v1/operations`, polled every 2 s while anything is active, 10 s
  otherwise), `c.activeFor(instanceId)` (first active op of an app), `c.cancelOperation(id)`. `start(action)`: for a
  queueable kind on a busy app → the review dialog in **queue mode** (no plan: text "Immich is <installing> right now.
  Harbor will <update> it as soon as that finishes, planning it then. It stops and asks you only if it needs something
  new from you." and the button **Queue <verb>**); on approve → `POST /v1/operations {action}` with one idempotency key
  per dialog. Otherwise as today (reviewed plans; decision 173 wait for the other kinds).
- Every `disabled={busy…}` that refers to another operation goes; navigation buttons (Install page, Publish…,
  Manage, Change the settings, Add another copy, Reinstall… that opens the drawer) are never disabled for busy.
- Tray = queue panel (§1). Finished items the console saw keep their own results until dismissed (approving a new
  plan no longer hides an unacknowledged shown-once result). Waiting items have **Cancel** with an accessible name
  (`Cancel <verb> <app>`); not-cancellable ones say why in one quiet line.
- Home tiles show the app's active operation: running → "Updating…/Removing…/Starting…/…", waiting → "Waiting…".
- `pnpm dev:ui` mocks: a running install, two waiting items (one not cancellable), cancel works.

## 5. Tests

Unit: migration v12→v13 (order, nullable plan, cancelled), run order, the queueable-kind list, error codes.
Integration (hold an operation with `h.fake.behaviour.respond = () => 503`, flip to 200): different-app approval
while busy runs after; same-app queued action plans at its turn and applies against the post-first-op state;
REVIEW_NEEDED (an update needing a new permission or secret); cancel a waiting install frees name + ports +
follow-ups; cancel a running op → NOT_CANCELLABLE; guard ops not cancellable; restart: never-picked → cancelled,
app untouched, picked → needs_action; `GET /v1/operations` order and recent; applyAllUpdates queues busy apps;
backups cold pass cancelled ends the run. openapi route list. e2e: a slow fake operation (dev-only knob in
`src/dev.ts`), buttons stay enabled, queue a second app's install and a same-app update, cancel one, the tray lists them.
