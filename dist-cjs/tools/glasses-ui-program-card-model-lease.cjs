const { createRequire } = require("node:module");

const fs = require("node:fs");

const path = require("node:path");
const requireBuiltin = createRequire(__filename);
const leases                   = (globalThis       )[Symbol.for('ocuclaw.card-model.leases')] ||= new Map();
const DB = '.program-card-model-owner.sqlite';
const LEGACY_DELETE = '.program-card-model-delete-guard';
function close(root        , entry     ) {
  if (leases.get(root) !== entry) return;
  leases.delete(root);
  entry.db.close();
}
function createProgramCardModelLease(root        ) {
  const owner = {};
  let reason = 'library_in_use';
  return {
    held: () => leases.get(root)?.owner === owner,
    reason: () => reason,
    acquire() {
      const current = leases.get(root);
      if (current) { reason = 'library_in_use'; return current.owner === owner; }
      let db     ;
      try {
        let DatabaseSync     ;
        try { ({ DatabaseSync } = requireBuiltin('node:sqlite')); }
        catch (_) { reason = 'unsupported_runtime'; return false; }
        if (typeof DatabaseSync !== 'function') { reason = 'unsupported_runtime'; return false; }
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (fs.existsSync(path.join(root, LEGACY_DELETE))) { reason = 'library_in_use'; return false; }
        db = new DatabaseSync(path.join(root, DB));
        fs.chmodSync(path.join(root, DB), 0o600);
        db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');

        if (fs.existsSync(path.join(root, LEGACY_DELETE))) { db.close(); reason = 'library_in_use'; return false; }
        leases.set(root, { owner, db, borrowers: 0, releaseRequested: false });
        reason = ''; return true;
      } catch (error     ) {
        try { db?.close(); } catch (_) {}
        reason = /locked|busy/i.test(String(error?.message)) ? 'library_in_use' : 'storage_unavailable';
        return false;
      }
    },
    release() {
      const entry = leases.get(root);
      if (entry?.owner !== owner) return;
      if (entry.borrowers) entry.releaseRequested = true;
      else close(root, entry);
    },
  };
}

function withProgramCardModelDeleteLease(root        , action           )      {
  const entry = leases.get(root);
  if (entry) {
    entry.borrowers++;
    try { return { ok: true, value: action() }; }
    finally { if (--entry.borrowers === 0 && entry.releaseRequested) close(root, entry); }
  }

  if (!fs.existsSync(path.join(root, DB))) return withoutModelOwner(root, action);
  const lease = createProgramCardModelLease(root);
  if (lease.acquire()) {
    try { return { ok: true, value: action() }; }
    finally { lease.release(); }
  }
  if (lease.reason() !== 'unsupported_runtime') return { ok: false };
  return { ok: false };
}
function withoutModelOwner(root        , action           ) {

  const guard = path.join(root, LEGACY_DELETE);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch (_) { return { ok: false }; }
  try { return fs.existsSync(path.join(root, DB)) ? { ok: false } : { ok: true, value: action() }; }
  finally { fs.rmdirSync(guard); }
}

function programCardModelDeleted(root        , appId        ) {
  return fs.existsSync(path.join(root, 'program-card-model-deleted-v1', appId))
    && !fs.existsSync(path.join(root, 'apps-v1', `${appId}.json`));
}
function markProgramCardModelDeleted(root        , appId        ) {
  const dir = path.join(root, 'program-card-model-deleted-v1');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, appId), '', { mode: 0o600 });
}

module.exports = { createProgramCardModelLease, withProgramCardModelDeleteLease, programCardModelDeleted, markProgramCardModelDeleted };
