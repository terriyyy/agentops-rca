import asyncio
import json
import os
from pathlib import Path

import pytest

from agentops_cli import tool
from agentops_cli.spool import Spool, clean
from agentops_cli.cli import Transport


def test_sdk_returns_exceptions_async_and_redaction(tmp_path,monkeypatch):
    path=tmp_path/'spool.sqlite3';spool=Spool(path);spool.initialize({})
    monkeypatch.setenv('AGENTOPS_SPOOL',str(path))
    @tool
    def outer(password): return inner()
    @tool
    def inner(): return {'returncode':1,'api_key':'secret-value'}
    @tool
    async def async_tool(): raise ValueError('intentional failure')
    assert outer('secret-password')['returncode']==1
    with pytest.raises(ValueError):asyncio.run(async_tool())
    rows=[json.loads(r['body']) for r in spool.pending()]
    assert len(rows)==6
    assert rows[1]['parent_source_id']==rows[0]['source_span_id']
    assert rows[0]['input']['password']=='[REDACTED]'
    assert rows[2]['output']['api_key']=='[REDACTED]'
    assert rows[2]['ok'] is False and rows[-1]['ok'] is False
    assert 'secret-password' not in json.dumps(rows)


def test_spool_capacity_marks_loss_and_reopen(tmp_path,monkeypatch):
    import agentops_cli.spool as module
    monkeypatch.setattr(module,'LIMIT_EVENTS',2)
    path=tmp_path/'spool.sqlite3';spool=Spool(path);spool.initialize({})
    assert spool.append('p','log','line',output='token=abc123')
    assert spool.append('p','log','line',output='safe')
    assert not spool.append('p','log','line',output='lost')
    assert spool.get('dropped')==1
    spool=Spool(path)
    assert spool.counts()=={'p':2}
    rows=spool.pending();assert 'abc123' not in rows[0]['body']
    spool.acknowledge(rows)
    assert spool.pending()==[]


def test_no_session_tool_is_transparent(monkeypatch):
    monkeypatch.delenv('AGENTOPS_SPOOL',raising=False)
    @tool
    def add(x,y):return x+y
    assert add(2,3)==5
    for url in ['https://example.com','http://127.0.0.1.evil','http://user:secret@localhost']:
        with pytest.raises(ValueError):Transport(url,'token')
    assert 'abc123' not in clean('Authorization: Bearer abc123')
    assert 'abc123' not in clean('api_key=abc123')
