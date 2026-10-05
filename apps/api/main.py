import json
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from .contracts import ImportManifest
from .importer import ImportConflict, import_package
from .normalizer import object_json
from .storage import Store, payload
from .live import router as live_router, live_view
from .diagnosis import DiagnosisManager, router as diagnosis_router
from .model_settings import ModelSettings, router as model_settings_router
from .workbench import overview as workbench_overview, projected_run
from .run_metrics import run_metrics

ROOT=Path(__file__).resolve().parents[2]
MAX_BODY=32*1024*1024
MAX_FILE=10*1024*1024


class LocalRequestGuard:
    def __init__(self,app): self.app=app
    async def __call__(self,scope,receive,send):
        if scope['type']!='http': return await self.app(scope,receive,send)
        headers=dict(scope['headers'])
        if scope['method'] in ('POST','PUT','PATCH','DELETE'):
            origin=headers.get(b'origin',b'').decode()
            allowed_origins={'http://'+headers.get(b'host',b'').decode(),'http://127.0.0.1:5173','http://localhost:5173'}
            if origin and origin not in allowed_origins:
                return await JSONResponse({'detail':'本地工作台拒绝其他来源的写入请求'},403)(scope,receive,send)
            chunks=[]
            total=0
            while True:
                message=await receive()
                if message['type']=='http.disconnect': return
                body=message.get('body',b'')
                total+=len(body)
                if total>MAX_BODY:
                    return await JSONResponse({'detail':'请求超过 32 MiB 上限'},413)(scope,receive,send)
                chunks.append(body)
                if not message.get('more_body'): break
            sent=False
            async def bounded_receive():
                nonlocal sent
                if not sent:
                    sent=True
                    return {'type':'http.request','body':b''.join(chunks),'more_body':False}
                return await receive()
            return await self.app(scope,bounded_receive,send)
        return await self.app(scope,receive,send)


def create_app(db_path=None, diagnosis_config=None, model_settings_dir=None, legacy_env_file=None):
    store=Store(Path(db_path or os.environ.get('AGENTOPS_DB',ROOT/'data/agentops.sqlite3')))
    isolated=bool(db_path or os.environ.get('AGENTOPS_DB'))
    models=ModelSettings(model_settings_dir or os.environ.get('AGENTOPS_MODEL_SETTINGS_DIR') or
                         (store.path.parent/'rca-credentials'/store.path.stem if isolated else ROOT/'.local/rca-credentials'),
                         legacy_env_file or (None if isolated else ROOT/'.env'))
    isolated_diagnosis=diagnosis_config or os.environ.get('AGENTOPS_DIAGNOSIS_CONFIG') or (store.path.parent/('diagnosis-config-'+store.path.stem+'.json') if isolated else None)
    manager=DiagnosisManager(store, models=models, **({'config_path':isolated_diagnosis} if isolated_diagnosis else {}))
    @asynccontextmanager
    async def lifespan(app):
        manager.recover()
        try:yield
        finally:manager.close()
    app=FastAPI(title='AgentOps RCA',version='0.4.0',lifespan=lifespan)
    app.state.store=store
    app.state.diagnosis=manager
    app.add_middleware(LocalRequestGuard)
    app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','testserver'])
    app.include_router(live_router(store))
    app.include_router(diagnosis_router(manager))
    app.include_router(model_settings_router(manager))

    @app.exception_handler(HTTPException)
    async def http_error(request,exc): return JSONResponse({'detail':exc.detail},exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request,exc):
        # Do not reflect credentials, payloads or non-finite input in error responses.
        detail='；'.join('.'.join(map(str,e['loc']))+': '+e['msg'] for e in exc.errors())
        return JSONResponse({'detail':detail},422)

    def get_row(db,table,id):
        # table is always a source-code constant, never a URL/query value.
        row=db.execute(f'SELECT * FROM {table} WHERE id=?',(id,)).fetchone()
        if row is None: raise HTTPException(404,'记录不存在')
        return row

    @app.get('/api/health')
    def health(): return {'status':'ok','version':'0.4.0','mode':'local','diagnosis_engine':manager.capabilities()['status'],'verification':'evidence_required','collector':'python-sdk','stream':'sse'}

    @app.get('/api/contracts/import-manifest')
    def schema(): return ImportManifest.model_json_schema()

    @app.post('/api/imports')
    async def upload(manifest:UploadFile=File(...),files:list[UploadFile]=File(...)):
        try:
            manifest_bytes=await manifest.read(128*1024+1)
            if len(manifest_bytes)>128*1024: raise HTTPException(413,'导入清单过大')
            spec=ImportManifest.model_validate(object_json(manifest_bytes.decode('utf-8-sig'),'导入清单'))
            if len(files)>40: raise HTTPException(413,'一次导入最多 40 个文件')
            contents={}
            for file in files:
                name=file.filename or ''
                if name in contents: raise ValueError('上传文件名重复')
                if not name or any(c in name for c in '/\\:\x00') or name.startswith('.'):
                    raise ValueError('上传文件名不能包含路径')
                raw=await file.read(MAX_FILE+1)
                if len(raw)>MAX_FILE: raise HTTPException(413,'单个文件超过 10 MiB')
                contents[name]=raw.decode('utf-8')
            return import_package(store,spec,contents)
        except ImportConflict as exc: raise HTTPException(409,str(exc)) from exc
        except ValidationError as exc:
            raise HTTPException(422,'清单字段不符合契约：'+'；'.join('.'.join(map(str,e['loc']))+': '+e['msg'] for e in exc.errors(include_input=False))) from exc
        except UnicodeDecodeError as exc: raise HTTPException(422,'仅支持 UTF-8 文本文件') from exc
        except (ValueError,TypeError,AttributeError,RecursionError) as exc:
            message=str(exc) if isinstance(exc,ValueError) else '源文件字段结构不符合历史格式'
            raise HTTPException(422,message) from exc
        except sqlite3.OperationalError as exc: raise HTTPException(503,'存储暂时不可用，请稍后重试') from exc
        finally:
            await manifest.close()
            for file in files: await file.close()

    @app.get('/api/imports')
    def imports():
        with store.connect() as db:
            return [payload(r) for r in db.execute('SELECT * FROM imports ORDER BY created_at DESC LIMIT 100')]

    @app.post('/api/examples/import')
    def demo():
        directory=ROOT/'tests/fixtures/demo'
        spec=ImportManifest.model_validate_json((directory/'manifest.json').read_text(encoding='utf-8'))
        names={getattr(r,k) for r in spec.runs for k in ('telemetry','report','outcome','feedback') if getattr(r,k)}
        return import_package(store,spec,{name:(directory/name).read_text(encoding='utf-8') for name in names})

    @app.get('/api/imports/{id}')
    def import_detail(id:str):
        with store.connect() as db:return payload(get_row(db,'imports',id))

    @app.get('/api/tasks')
    def tasks():
        with store.connect() as db:
            result=[]
            for task in db.execute('SELECT * FROM tasks ORDER BY rowid DESC'):
                runs=[live_view(db,payload(r)) for r in db.execute('SELECT * FROM runs WHERE task_id=? ORDER BY attempt_index',(task['id'],))]
                result.append({**dict(task),'runs':runs,'outcome_status':runs[-1]['outcome_status'] if runs else 'unknown'})
            return result

    @app.get('/api/overview')
    def overview(limit:int=Query(20,ge=1,le=50), source:Literal['all','live','imported','synthetic']='all', include_summary:bool=False):
        with store.connect() as db:
            db.execute('BEGIN')
            return workbench_overview(db,limit,source,include_summary)

    @app.get('/api/tasks/{id}')
    def task_detail(id:str):
        with store.connect() as db:
            task=get_row(db,'tasks',id)
            return {**dict(task),'runs':[projected_run(db,r,task) for r in db.execute('SELECT * FROM runs WHERE task_id=? ORDER BY attempt_index',(id,))]}

    @app.get('/api/runs/{id}')
    def run_detail(id:str):
        with store.connect() as db:return projected_run(db,get_row(db,'runs',id))

    @app.get('/api/runs/{id}/events')
    def events(id:str,offset:int=Query(0,ge=0),limit:int=Query(60,ge=1,le=200),kind:str|None=None,q:str=''):
        with store.connect() as db:
            get_row(db,'runs',id)
            where='run_id=?'; args=[id]
            if kind:where+=' AND kind=?';args.append(kind)
            if q:where+=" AND (name LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\')"; escaped=q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_');args += ['%'+escaped+'%']*2
            count=db.execute('SELECT count(*) FROM events WHERE '+where,args).fetchone()[0]
            rows=db.execute('SELECT * FROM events WHERE '+where+' ORDER BY position LIMIT ? OFFSET ?',args+[limit,offset])
            return {'items':[payload(r) for r in rows],'total':count,'offset':offset,'limit':limit}

    @app.get('/api/runs/{id}/metrics')
    def metrics(id:str):
        with store.connect() as db:
            run=payload(get_row(db,'runs',id))
            events=[payload(row) for row in db.execute('SELECT * FROM events WHERE run_id=? ORDER BY position',(id,))]
            return run_metrics(run,events)

    @app.get('/api/runs/{id}/diagnoses')
    def diagnoses(id:str):
        with store.connect() as db:
            get_row(db,'runs',id)
            return [payload(r) for r in db.execute('SELECT * FROM diagnoses WHERE run_id=? ORDER BY rowid DESC',(id,))]

    @app.get('/api/runs/{id}/outcomes')
    def outcomes(id:str):
        with store.connect() as db:
            get_row(db,'runs',id)
            return [payload(r) for r in db.execute('SELECT * FROM outcomes WHERE run_id=?',(id,))]

    @app.get('/api/runs/{id}/links')
    def links(id:str):
        with store.connect() as db:
            get_row(db,'runs',id)
            return [payload(r) for r in db.execute('SELECT * FROM links WHERE run_id=?',(id,))]

    @app.get('/api/evidence/{id}')
    def evidence(id:str):
        with store.connect() as db:
            ref=payload(get_row(db,'evidence',id))
            artifact=get_row(db,'artifacts',ref['artifact_id'])
            content=artifact['content']
            if ref['line']:
                lines=content.splitlines(); index=ref['line']-1
                if index>=len(lines): raise HTTPException(409,'证据行号无法解析')
                value=lines[index]
            elif ref['json_pointer'] is not None:
                value=json.loads(content.lstrip('\ufeff'))
                try:
                    for part in ref['json_pointer'].split('/')[1:]:
                        key=part.replace('~1','/').replace('~0','~')
                        value=value[int(key)] if isinstance(value,list) else value[key]
                except (KeyError,IndexError,ValueError,TypeError) as exc: raise HTTPException(409,'报告引用无法解析') from exc
            else: value=content
            return {**ref,'sha256':artifact['sha256'],'content':value}

    dist=ROOT/'apps/web/dist'
    if (dist/'assets').exists():app.mount('/assets',StaticFiles(directory=dist/'assets'),name='assets')

    @app.get('/{path:path}',include_in_schema=False)
    def spa(path:str):
        if path.startswith('api/') or not (dist/'index.html').exists(): raise HTTPException(404,'页面不存在；开发环境请访问前端端口')
        return FileResponse(dist/'index.html')
    return app


app=create_app()
