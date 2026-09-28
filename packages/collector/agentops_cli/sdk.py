import functools
import inspect
import os
import sys
import time
from contextvars import ContextVar
from uuid import uuid4

from .spool import Spool

_parent=ContextVar('agentops_parent',default=None)
_producer=None
_warned=False


def emit(kind,name,**fields):
    """Emit an event when launched by agentops. Outside a session this is a no-op."""
    global _producer,_warned
    path=os.environ.get('AGENTOPS_SPOOL')
    if not path: return
    if _producer is None: _producer=f'python-{os.getpid()}-{uuid4().hex[:8]}'
    try:
        ok=Spool(path).append(_producer,kind,name,**fields)
        if not ok and not _warned:
            print('[agentops] 采集队列达到上限，记录将标记不完整',file=sys.stderr);_warned=True
    except Exception:
        # Preserve the agent's business result; surface collection failure separately.
        if not _warned:
            print('[agentops] 采集写入失败，请检查本机 spool',file=sys.stderr);_warned=True
        try: Spool(path).set('collection_error',True)
        except Exception: pass


def verification(status,*,source,basis,summary=''):
    """Record the result of an actual independent check, not the agent's own belief."""
    if status not in ('passed','failed','unknown'): raise ValueError('Invalid verification status')
    emit('verification','OUTCOME_EVIDENCE',input={'status':status,'source':source,'basis':basis,'summary':summary})


def tool(fn=None,*,name=None):
    """Wrap a synchronous or asynchronous tool, preserving result and exception."""
    def decorate(func):
        label=name or func.__name__
        def begin(args,kwargs):
            cid=uuid4().hex; span=uuid4().hex
            try: params=dict(inspect.signature(func).bind(*args,**kwargs).arguments)
            except (ValueError,TypeError): params={'args':args,'kwargs':kwargs}
            emit('tool_call',label,source_span_id=span,parent_source_id=_parent.get(),correlation_id=cid,input=params)
            return cid,span,time.perf_counter(),_parent.set(span)
        def end(state,result=None,error=None):
            cid,span,start,token=state
            rc=getattr(result,'returncode',None)
            if isinstance(result,dict): rc=result.get('returncode')
            output={'returncode':rc,'stdout':getattr(result,'stdout',None),'stderr':getattr(result,'stderr',None)} if hasattr(result,'returncode') else result
            emit('tool_return',label,source_span_id=uuid4().hex,correlation_id=cid,output=output,ok=error is None and rc in (None,0),duration_ms=round((time.perf_counter()-start)*1000,3),error_signature=type(error).__name__+': '+str(error) if error else None)
            _parent.reset(token)
        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def wrapped(*args,**kwargs):
                state=begin(args,kwargs)
                try: result=await func(*args,**kwargs)
                except BaseException as exc: end(state,error=exc);raise
                end(state,result);return result
        else:
            @functools.wraps(func)
            def wrapped(*args,**kwargs):
                state=begin(args,kwargs)
                try: result=func(*args,**kwargs)
                except BaseException as exc: end(state,error=exc);raise
                end(state,result);return result
        return wrapped
    return decorate(fn) if fn else decorate
