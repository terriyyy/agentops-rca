import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


MIGRATION = """
CREATE TABLE IF NOT EXISTS imports (
 id TEXT PRIMARY KEY, package_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, namespace TEXT NOT NULL, external_id TEXT NOT NULL, goal TEXT NOT NULL,
 sample_kind TEXT NOT NULL, UNIQUE(namespace, external_id)
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), external_id TEXT NOT NULL,
 attempt_index INTEGER NOT NULL, snapshot_hash TEXT NOT NULL, payload TEXT NOT NULL,
 UNIQUE(task_id, external_id), UNIQUE(task_id, attempt_index)
);
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), filename TEXT NOT NULL,
 kind TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL,
 kind TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id, position)
);
CREATE INDEX IF NOT EXISTS events_run_kind ON events(run_id, kind, position);
CREATE TABLE IF NOT EXISTS evidence (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnoses (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outcomes (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL
);
PRAGMA user_version=1;
"""


class Store:
    def __init__(self, path: Path):
        path = path.resolve()
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 3:
                raise RuntimeError("数据库版本高于应用支持版本")
            if version == 0:
                db.executescript(MIGRATION)
            if version < 2:
                if version == 1:
                    backup = path.with_name(path.name + '.v1-backup.sqlite3')
                    if not backup.exists():
                        with sqlite3.connect(backup) as target:
                            db.backup(target)
                db.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS capture_sessions (
                  run_id TEXT PRIMARY KEY REFERENCES runs(id), request_id TEXT UNIQUE NOT NULL,
                  request_hash TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL, finish TEXT
                );
                CREATE TABLE IF NOT EXISTS live_receipts (
                  run_id TEXT NOT NULL REFERENCES runs(id), source_id TEXT NOT NULL,
                  producer_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL,
                  event_id TEXT NOT NULL REFERENCES events(id),
                  PRIMARY KEY(run_id,source_id), UNIQUE(run_id,producer_id,seq)
                );
                CREATE TABLE IF NOT EXISTS live_changes (
                  cursor INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
                  kind TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS live_changes_run ON live_changes(run_id,cursor);
                PRAGMA user_version=2;
                COMMIT;
                ''')
            if version < 3:
                if version == 2:
                    backup=path.with_name(path.name+'.v2-backup.sqlite3')
                    if not backup.exists():
                        with sqlite3.connect(backup) as target:db.backup(target)
                db.executescript('''
                BEGIN IMMEDIATE;
                CREATE TABLE diagnosis_jobs (
                  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
                  request_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
                  payload TEXT NOT NULL, UNIQUE(run_id,request_id)
                );
                PRAGMA user_version=3;
                COMMIT;
                ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()


def payload(row):
    return json.loads(row["payload"])
