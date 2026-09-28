"""Real TCP/child-process checks using a deterministic, model-free tool agent."""
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from agentops_cli.spool import Spool

ROOT=Path(__file__).resolve().parents[2]


@pytest.fixture
def server(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env={**os.environ,'AGENTOPS_DB':str(tmp_path/'server.sqlite3'),'PYTHONIOENCODING':'utf-8'}
    processes=[]
    class Server:
        url=f'http://127.0.0.1:{port}'
        def start(self):
            self.process=subprocess.Popen([sys.executable,'-m','uvicorn','apps.api.main:app','--host','127.0.0.1','--port',str(port)],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            processes.append(self.process)
            with httpx.Client(trust_env=False,timeout=1) as client:
                for _ in range(80):
                    try:
                        if client.get(self.url+'/api/health').status_code==200:return
                    except httpx.HTTPError:pass
                    time.sleep(.1)
            raise RuntimeError('test server did not start')
        def stop(self):self.process.terminate();self.process.wait(timeout=10)
    instance=Server();instance.start()
    yield instance
    for process in processes:
        if process.poll() is None:process.terminate();process.wait(timeout=10)


def start_agent(server,tmp_path,*extra):
    return subprocess.Popen([sys.executable,'-m','agentops_cli.cli','run','--server',server.url,'--spool-dir',str(tmp_path/'spool'),'--sample-kind','synthetic','--',sys.executable,str(ROOT/'examples/local_agent.py'),*extra],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env={**os.environ,'PYTHONIOENCODING':'utf-8'},creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)


def wait_run(server):
    with httpx.Client(trust_env=False) as client:
        for _ in range(80):
            tasks=client.get(server.url+'/api/tasks').json()
            if tasks and tasks[0]['runs'][0]['event_count']>=2:return tasks[0]['runs'][0]
            time.sleep(.1)
    raise AssertionError('no live events')


@pytest.mark.parametrize('failed',[False,True])
def test_real_child_cli_and_finish(server,tmp_path,failed):
    p=start_agent(server,tmp_path,*(['--fail'] if failed else []))
    try:
        out,err=p.communicate(timeout=30)
        assert p.returncode==0,err
        with httpx.Client(trust_env=False) as client:
            run=client.get(server.url+'/api/tasks').json()[0]['runs'][0]
        assert run['execution_status']=='completed'
        assert run['outcome_status']==('failed' if failed else 'passed')
        assert run['capture_integrity']=='complete' and run['confirmed_pairs']==2
        assert server.url+'/runs/' in out
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_server_outage_durable_resume_and_sse_cursor(server,tmp_path):
    p=start_agent(server,tmp_path,'--delay','3')
    try:
        run=wait_run(server);rid=run['run_id']
        with httpx.Client(trust_env=False,timeout=5) as c:
            with c.stream('GET',server.url+f'/api/runs/{rid}/stream') as stream:
                lines=stream.iter_lines();first=next(lines);assert first.startswith('id: ')
                cursor=first.split(': ')[1]
        server.stop()
        p.communicate(timeout=30)
        path=next((tmp_path/'spool').glob('*.sqlite3'));spool=Spool(path)
        assert spool.pending()
        server.start()
        resumed=subprocess.run([sys.executable,'-m','agentops_cli.cli','resume',str(path)],cwd=ROOT,capture_output=True,timeout=30)
        assert resumed.returncode==0,resumed.stderr
        with httpx.Client(trust_env=False,timeout=5) as c:
            result=c.get(server.url+f'/api/runs/{rid}').json()
            assert result['capture_integrity']=='complete' and result['outcome_status']=='passed'
            with c.stream('GET',server.url+f'/api/runs/{rid}/stream',headers={'Last-Event-ID':cursor}) as stream:
                assert int(next(stream.iter_lines()).split(': ')[1])>int(cursor)
        assert spool.pending()==[]
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_interrupt_records_cancelled(server,tmp_path):
    p=start_agent(server,tmp_path,'--delay','20')
    try:
        run=wait_run(server)
        p.send_signal(signal.CTRL_BREAK_EVENT if os.name=='nt' else signal.SIGINT)
        try:
            out,err=p.communicate(timeout=20)
        except subprocess.TimeoutExpired as exc:
            raise AssertionError(f'interrupt timeout: returncode={p.poll()}, stdout={exc.stdout!r}, stderr={exc.stderr!r}') from exc
        with httpx.Client(trust_env=False) as client:
            result=client.get(server.url+'/api/runs/'+run['run_id']).json()
        assert result['execution_status']=='cancelled'
        assert result['outcome_status']=='unknown'
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_hard_kill_reports_disconnection_not_failure(server,tmp_path):
    p=start_agent(server,tmp_path,'--delay','40')
    child_pid=None
    try:
        run=wait_run(server)
        spool=Spool(next((tmp_path/'spool').glob('*.sqlite3')))
        child_pid=spool.get('child_pid')
        p.kill();p.wait(timeout=5)
        # These are only processes created by this test and recorded by its CLI.
        if child_pid:
            try:os.kill(child_pid,signal.SIGTERM)
            except OSError:pass
        with httpx.Client(trust_env=False) as client:
            for _ in range(100):
                result=client.get(server.url+'/api/runs/'+run['run_id']).json()
                if result['capture_status']=='disconnected':break
                time.sleep(.2)
        assert result['capture_status']=='disconnected'
        assert result['execution_status']=='running' and result['outcome_status']=='unknown'
        assert result['capture_integrity']=='pending'
    finally:
        if p.poll() is None:p.kill();p.wait()


def test_process_only_nonzero_exit(server,tmp_path):
    result=subprocess.run([sys.executable,'-m','agentops_cli.cli','run','--server',server.url,'--adapter','process-only','--spool-dir',str(tmp_path/'spool'),'--',sys.executable,'-c','import sys; print("actual failure"); sys.exit(7)'],cwd=ROOT,capture_output=True,timeout=25)
    assert result.returncode==7
    with httpx.Client(trust_env=False) as client:run=client.get(server.url+'/api/tasks').json()[0]['runs'][0]
    assert run['execution_status']=='failed' and run['outcome_status']=='unknown'
    assert run['capture_integrity']=='complete'
