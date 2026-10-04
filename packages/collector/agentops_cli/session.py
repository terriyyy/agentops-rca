"""Explicit single-process capture session for an embedded benchmark attempt."""
import os
import secrets
import threading
from pathlib import Path
from uuid import uuid4

from .cli import Transport, drain, flush_once
from .spool import Spool, clean


class CaptureSession:
    """Create one Run; callers, rather than the API, execute the agent.

    This context is intentionally serial: AGENTOPS_SPOOL is process-wide.
    Concurrent benchmark attempts must run in separate processes.
    """

    def __init__(self, *, server, goal, spool_dir, task_id=None, sample_kind='live'):
        if sample_kind not in ('live', 'synthetic'):
            raise ValueError('Invalid capture sample kind')
        self.server = server
        self.goal = goal
        self.task_id = task_id
        self.sample_kind = sample_kind
        self.directory = Path(spool_dir).resolve()
        self.stopped = threading.Event()
        self.upload_error = False
        self.finished = False

    def __enter__(self):
        if os.environ.get('AGENTOPS_SPOOL'):
            raise RuntimeError('CaptureSession requires a serial, non-nested process')
        self.directory.mkdir(parents=True, exist_ok=True)
        request_id = uuid4().hex
        token = secrets.token_urlsafe(32)
        self.transport = Transport(self.server, token)
        self.path = self.directory / (request_id + '.sqlite3')
        self.spool = Spool(self.path)
        create = dict(request_id=request_id, write_token=token, goal=clean(self.goal),
                      sample_kind=self.sample_kind, adapter='python-sdk', task_id=self.task_id)
        self.spool.initialize(dict(server=self.transport.url, token=token, create=create))
        result = self.transport.post('/api/live/runs', create)
        self.run_id = result['run_id']
        self.task_id = result['task_id']
        self.url = self.transport.url + result['url']
        self.spool.set('run_id', self.run_id)
        self.spool.append('runner', 'event', 'RUN_START', input={'adapter': 'python-sdk'})
        os.environ['AGENTOPS_SPOOL'] = str(self.path)
        self.sender = threading.Thread(target=self._upload, daemon=True)
        self.sender.start()
        return self

    def _upload(self):
        while not self.stopped.is_set():
            try:
                flush_once(self.spool, self.transport)
                self.transport.post('/api/live/runs/' + self.run_id + '/heartbeat', {})
            except (OSError, RuntimeError):
                # Outbox retains unacknowledged events for drain/resume.
                self.upload_error = True
            self.stopped.wait(.5)

    def __exit__(self, exc_type, exc_value, traceback):
        code = 0 if exc_type is None else 130 if exc_type is KeyboardInterrupt else 1
        reason = 'exit' if exc_type is None else 'interrupted' if code == 130 else 'exit'
        try:
            self.stopped.set()
            self.sender.join(timeout=5)
            self.spool.append('runner', 'event', 'RUN_END', input={'exit_code': code, 'reason': reason})
            dropped = self.spool.get('dropped', 0) + int(bool(self.spool.get('collection_error', False)))
            if self.sender.is_alive():
                dropped += 1
            finish = dict(exit_code=code, reason=reason, producers=self.spool.counts(), dropped=dropped)
            self.spool.set('finish', finish)
            self.finished = drain(self.spool, self.transport)
        finally:
            os.environ.pop('AGENTOPS_SPOOL', None)
        return False
