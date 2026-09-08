# whatsapp-baileys

Linked-device WhatsApp ingester. Fills the gap between the iOS WhatsApp backup
(ends Feb 19 2026) and live going-forward sync.

## Pairing

First time only:

```
node pipeline/whatsapp-baileys/pair.mjs
```

A QR code prints in the terminal. On your phone:
WhatsApp -> Settings -> Linked Devices -> Link a Device -> scan.

Auth state is saved under `pipeline/whatsapp-baileys/auth/` (gitignored).
Leave the process running; it listens for new messages and writes them to
`inputs/whatsapp-live/raw/`. Ctrl-C to stop.

## Re-syncing

Just re-run the same command — auth is cached, no re-pair needed:

```
node pipeline/whatsapp-baileys/pair.mjs
```

To pull the initial history once and exit (useful for the first backfill and
for cron-style runs):

```
node pipeline/whatsapp-baileys/pair.mjs --once
```

If the device gets unlinked from your phone, delete `auth/` and re-run.

## Wiring into build-db

Wiring is intentionally deferred. Once you've actually run the pairing, scanned
the QR, and confirmed `inputs/whatsapp-live/raw/` has populated JSONL files,
add to `pipeline/build-db.js`:

```
import { parseWhatsappLiveExport } from './whatsapp-baileys/parse.mjs';
// ...
const liveThreads = parseWhatsappLiveExport();
threads.push(...liveThreads);
```

Threads emitted use `threadId = 'wal:' + jid` and `source: 'whatsapp'`, same
shape as the other ingesters.

## Notes

- `inputs/` is already gitignored at the repo root, so `whatsapp-live/raw/`
  contents won't be committed.
- One file per stream:
  - `messages-YYYYMMDD.jsonl` — appended message events
  - `chats.jsonl` — chat metadata snapshots
  - `contacts.jsonl` — contact pushname updates
- Linked-device sync delivers what your phone has cached recently — typically
  a few weeks to a few months of recent history per chat, not a full archive.
  For deep history, rely on the iOS backup ingest. This module is for the
  rolling tail.
