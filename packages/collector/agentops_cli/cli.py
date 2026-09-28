import argparse
import codecs
import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from .spool import Spool, clean


class Transport:
    def __init__(self,url,token):
        parsed=urlparse(url)
        if parsed.scheme!='http' or parsed.hostname not in ('localhost','127.0.0.1') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('','/'):
            raise ValueError('V0.2 仅支持本机 http://127.0.0.1:<端口> 服务')
        self.url=url.rstrip('/');self.token=token
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def post(self,path,data):
        request=urllib.request.Request(self.url+path,data=json.dumps(data,ensure_ascii=False).encode('utf-8'),headers={'Content-Type':'application/json','Authorization':'Bearer '+self.token},method='POST')
        try:
            with self.opener.open(request,timeout=2) as response: return json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'平台拒绝采集请求（HTTP {exc.code}），请检查会话和数据契约') from None


def flush_once(spool,transport):
    rows=spool.pending()
    if rows:
        transport.post('/api/live/runs/'+spool.get('run_id')+'/events',{'events':[json.loads(r['body']) for r in rows]})
        spool.acknowledge(rows)
    return bool(rows)


def drain(spool,transport,seconds=10):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            if not flush_once(spool,transport):
                finish=spool.get('finish')
                if finish: transport.post('/api/live/runs/'+spool.get('run_id')+'/finish',finish)
                return True
        except (OSError,RuntimeError): time.sleep(0.5)
    return False


def relay(pipe,target,spool,producer):
    decoder=codecs.getincrementaldecoder('utf-8')(errors='replace');pending='';discarding=False
    def record(text):
        if text and not spool.append(producer,'log',producer,output=text):
            spool.set('collection_error',True)
    try:
        while True:
            chunk=os.read(pipe.fileno(),4096)
            if not chunk: break
            text=decoder.decode(chunk)
            try: target.write(text);target.flush()
            except (OSError,UnicodeError): pass
            if discarding:
                if '\n' not in text:continue
                text=text.split('\n',1)[1];discarding=False
            pending+=text
            while '\n' in pending:
                line,pending=pending.split('\n',1); record(line)
            if len(pending)>8000:
                # Do not persist fragments of potential secrets split across chunks.
                record('[TRUNCATED: oversized unterminated output]');pending='';discarding=True
                spool.set('collection_error',True)
        pending+=decoder.decode(b'',final=True)
        record(pending)
    except Exception:
        spool.set('collection_error',True)
    finally: pipe.close()


def run(args):
    command=args.command
    if command and command[0]=='--': command=command[1:]
    if not command: raise ValueError('请在 -- 后提供 Agent 启动命令')
    token=secrets.token_urlsafe(32); request_id=uuid4().hex
    transport=Transport(args.server,token)
    directory=Path(args.spool_dir).resolve();path=directory/(request_id+'.sqlite3')
    spool=Spool(path)
    goal=args.goal or '本地 Agent 任务'
    create={'request_id':request_id,'write_token':token,'goal':clean(goal),'sample_kind':args.sample_kind,'adapter':args.adapter,'task_id':args.task_id}
    spool.initialize({'server':transport.url,'token':token,'create':create})
    result=None
    for _ in range(3):
        try: result=transport.post('/api/live/runs',create);break
        except (OSError,RuntimeError): time.sleep(0.5)
    if result is None:
        print('平台未连接，Agent 尚未启动。请先启动平台服务。',file=sys.stderr);return 2
    spool.set('run_id',result['run_id'])
    print('执行页面：'+transport.url+result['url'],flush=True)
    print('任务 ID：'+result['task_id'],flush=True)
    env=os.environ.copy();env['AGENTOPS_SPOOL']=str(path);env['PYTHONUNBUFFERED']='1';env['PYTHONIOENCODING']='utf-8'
    # Explicit SDK import works in another Python environment without patching it.
    env['PYTHONPATH']=str(Path(__file__).resolve().parent.parent)+os.pathsep+env.get('PYTHONPATH','')
    stop=threading.Event()
    def upload():
        while not stop.is_set():
            try:
                flush_once(spool,transport)
                transport.post('/api/live/runs/'+result['run_id']+'/heartbeat',{})
            except (OSError,RuntimeError): pass
            stop.wait(0.5)
    sender=threading.Thread(target=upload,daemon=True);sender.start()
    spool.append('runner','event','RUN_START',input={'adapter':args.adapter})
    child=None;readers=[];reason='exit';code=127
    try:
        child=subprocess.Popen(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0,start_new_session=os.name!='nt')
        spool.set('child_pid',child.pid)
        for pipe,target,name in [(child.stdout,sys.stdout,'stdout'),(child.stderr,sys.stderr,'stderr')]:
            thread=threading.Thread(target=relay,args=(pipe,target,spool,name),daemon=True);thread.start();readers.append(thread)
        # A bounded wait lets Python dispatch console signals on Windows.
        while True:
            try:code=child.wait(timeout=0.2);break
            except subprocess.TimeoutExpired:pass
    except KeyboardInterrupt:
        reason='interrupted';code=130
        if child:
            try:
                child.send_signal(signal.CTRL_BREAK_EVENT if os.name=='nt' else signal.SIGINT)
                child.wait(timeout=3)
            except (OSError,subprocess.TimeoutExpired):
                child.terminate()
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:child.kill();child.wait()
    except OSError:
        reason='launch_failed';print('Agent 启动失败，请检查命令和解释器。',file=sys.stderr)
    finally:
        for thread in readers: thread.join(timeout=3)
        if any(t.is_alive() for t in readers):spool.set('collection_error',True)
        spool.append('runner','event','RUN_END',input={'exit_code':code,'reason':reason})
        stop.set();sender.join(timeout=5)
        finish={'exit_code':code,'reason':reason,'producers':spool.counts(),'dropped':spool.get('dropped',0)+int(bool(spool.get('collection_error',False)))}
        spool.set('finish',finish)
        if not drain(spool,transport):
            print(f'采集尚有待补传数据；恢复平台后执行：agentops resume "{path}"',file=sys.stderr)
        elif finish['dropped']:
            print('采集存在丢失或截断，请查看完整性状态。',file=sys.stderr)
    return code if 0<=code<=255 else 1


def main():
    if os.name=='nt': signal.signal(signal.SIGBREAK,signal.default_int_handler)
    parser=argparse.ArgumentParser(description='AgentOps 本机实时采集')
    sub=parser.add_subparsers(dest='action',required=True)
    start=sub.add_parser('run');start.add_argument('--server',default='http://127.0.0.1:8000')
    start.add_argument('--goal');start.add_argument('--task-id')
    start.add_argument('--sample-kind',choices=['live','synthetic'],default='live')
    start.add_argument('--adapter',choices=['python-sdk','process-only'],default='python-sdk')
    start.add_argument('--spool-dir',default='.agentops/spool')
    start.add_argument('command',nargs=argparse.REMAINDER)
    resume=sub.add_parser('resume');resume.add_argument('spool')
    args=parser.parse_args()
    try:
        if args.action=='run': code=run(args)
        else:
            spool=Spool(Path(args.spool).resolve())
            if not spool.get('run_id'):raise ValueError('该记录未成功创建执行；请重新启动 Agent')
            transport=Transport(spool.get('server'),spool.get('token'))
            success=drain(spool,transport)
            print('补传完成' if success else '仍有待补传记录；请检查本机服务和会话有效期')
            if not spool.get('finish'): print('没有执行结束证据；保留执行未知／失联状态。')
            code=0 if success else 2
    except (ValueError,OSError,RuntimeError) as exc:
        print(str(clean(str(exc))),file=sys.stderr);code=2
    return code


if __name__=='__main__':sys.exit(main())
