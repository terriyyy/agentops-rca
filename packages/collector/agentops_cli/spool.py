"""Bounded SQLite outbox shared by the CLI and instrumented child."""
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

LIMIT_BYTES = 32*1024*1024
LIMIT_EVENTS = 19000  # Below the server's 20,000 event limit.
SECRET_KEYS = re.compile(r'(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie)')
TEXT_SECRET = re.compile(r'''(?ix)(\b(?:api[_-]?key|password|secret|token|authorization)\b\s*[=:]\s*["']?)(?:Bearer\s+)?([^\s,"'{}]+)|\bBearer\s+[A-Za-z0-9._~+/-]+|\bsk-[A-Za-z0-9_-]{12,}''')


def clean(value, depth=0):
    if depth>8: return '[DEPTH LIMIT]'
    if isinstance(value,dict):
        result={str(k)[:200]: '[REDACTED]' if SECRET_KEYS.search(str(k)) else clean(v,depth+1) for k,v in list(value.items())[:50]}
        if len(value)>50:result['_agentops_truncated_fields']=len(value)-50
        return result
    if isinstance(value,(list,tuple)):
        return [clean(v,depth+1) for v in value[:50]]+(['[TRUNCATED ITEMS]'] if len(value)>50 else [])
    if isinstance(value,(bool,int)) or value is None: return value
    if isinstance(value,float):
        import math
        return value if math.isfinite(value) else str(value)
    text=value if isinstance(value,str) else repr(value)
    text=TEXT_SECRET.sub(lambda m:(m.group(1) or '')+'[REDACTED]',text)
    return text[:8000]+('[TRUNCATED]' if len(text)>8000 else '')


class Spool:
    def __init__(self,path): self.path=Path(path)

    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=10)
        db.row_factory=sqlite3.Row
        try:
            with db: yield db
        finally: db.close()

    def initialize(self,metadata):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        # Exclusive creation prevents overwriting another run's credentials.
        fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.close(fd)
        with self.db() as db:
            db.executescript('''CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
              CREATE TABLE queue(id INTEGER PRIMARY KEY,producer TEXT,seq INTEGER,body TEXT,sent INTEGER DEFAULT 0);
              CREATE UNIQUE INDEX producer_seq ON queue(producer,seq);''')
            for key,value in {**metadata,'dropped':0}.items():
                db.execute('INSERT INTO meta VALUES (?,?)',(key,json.dumps(value)))

    def get(self,key,default=None):
        with self.db() as db:
            row=db.execute('SELECT value FROM meta WHERE key=?',(key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set(self,key,value):
        with self.db() as db: db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',(key,json.dumps(value)))

    def append(self,producer,kind,name,**fields):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            count,size=db.execute('SELECT count(*),coalesce(sum(length(CAST(body AS BLOB))),0) FROM queue').fetchone()
            seq=db.execute('SELECT coalesce(max(seq),0)+1 FROM queue WHERE producer=?',(producer,)).fetchone()[0]
            event={'schema_version':'0.2','event_id':uuid4().hex,'producer_id':producer,'producer_seq':seq,'occurred_at':datetime.now(timezone.utc).isoformat(),'kind':kind,'name':str(clean(name))[:200],**clean(fields)}
            body=json.dumps(event,ensure_ascii=False,allow_nan=False)
            if count>=LIMIT_EVENTS or size+len(body.encode('utf-8'))>LIMIT_BYTES or len(body.encode('utf-8'))>60000:
                db.execute("UPDATE meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='dropped'")
                return False
            db.execute('INSERT INTO queue(producer,seq,body) VALUES (?,?,?)',(producer,seq,body))
            return True

    def pending(self):
        with self.db() as db: return [dict(r) for r in db.execute('SELECT id,body FROM queue WHERE sent=0 ORDER BY id LIMIT 50')]

    def acknowledge(self,rows):
        with self.db() as db: db.executemany('UPDATE queue SET sent=1 WHERE id=?',[(r['id'],) for r in rows])

    def counts(self):
        with self.db() as db: return {r[0]:r[1] for r in db.execute('SELECT producer,max(seq) FROM queue GROUP BY producer')}
