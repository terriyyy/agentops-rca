"""Local live ingestion. Committed SQLite changes are the SSE replay log."""
import asyncio
import json
import secrets
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .importer import uid, digest
from .live_contracts import Batch, CreateRun, Finish
from .normalizer import correlate, normalize_events
from .storage import dumps, payload


def now():
    return datetime.now(timezone.utc).isoformat()


def live_view(db, run):
    if run.get('origin') != 'live':
        return run
    session = db.execute('SELECT * FROM capture_sessions WHERE run_id=?', (run['run_id'],)).fetchone()
    age = (datetime.now(timezone.utc)-datetime.fromisoformat(session['last_seen_at'])).total_seconds()
    capture = 'finished' if session['finish'] and run['capture_integrity'] in ('complete','partial') else 'disconnected' if age>15 else 'connected'
    return {**run, 'capture_status':capture, 'last_seen_at':session['last_seen_at']}


def router(store):
    api = APIRouter()

    def session_for(db, run_id, authorization):
        row = db.execute('SELECT * FROM capture_sessions WHERE run_id=?',(run_id,)).fetchone()
        token = authorization.removeprefix('Bearer ') if authorization else ''
        if not row or not secrets.compare_digest(row['token_hash'], digest(token)):
            raise HTTPException(401,'采集会话凭据无效')
        if datetime.fromisoformat(row['expires_at']) < datetime.now(timezone.utc):
            raise HTTPException(401,'采集会话已过期（24 小时）')
        return row

    def change(db,run_id,kind):
        db.execute('INSERT INTO live_changes(run_id,kind) VALUES (?,?)',(run_id,kind))

    def save(db,run):
        db.execute('UPDATE runs SET payload=?,snapshot_hash=? WHERE id=?',(dumps(run),run['snapshot_hash'] or '',run['run_id']))

    def finalize(db,run,finish):
        receipts = db.execute('SELECT producer_id,seq,hash FROM live_receipts WHERE run_id=? ORDER BY producer_id,seq',(run['run_id'],)).fetchall()
        actual = {}
        for row in receipts:
            actual.setdefault(row['producer_id'],[]).append(row['seq'])
        expected = finish['producers']
        if any(p not in expected or max(seqs)>expected[p] for p,seqs in actual.items()):
            raise HTTPException(409,'结束序号与已接收事件冲突')
        complete = all(actual.get(p,[])==list(range(1,count+1)) for p,count in expected.items())
        run['capture_integrity'] = ('partial' if finish['dropped'] else 'complete') if complete else 'pending'
        run['dropped_events'] = finish['dropped']
        run['snapshot_hash'] = digest(dumps([dict(r) for r in receipts])) if complete else None

    @api.get('/api/contracts/live')
    def schema():
        return {'create':CreateRun.model_json_schema(),'batch':Batch.model_json_schema(),'finish':Finish.model_json_schema()}

    @api.post('/api/live/runs')
    def create(spec:CreateRun):
        request_hash = digest(dumps(spec.model_dump(exclude={'write_token'})))
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT * FROM capture_sessions WHERE request_id=?',(spec.request_id,)).fetchone()
            if existing:
                session_for(db,existing['run_id'],'Bearer '+spec.write_token)
                if existing['request_hash']!=request_hash: raise HTTPException(409,'创建请求内容发生变化')
                run=payload(db.execute('SELECT * FROM runs WHERE id=?',(existing['run_id'],)).fetchone())
            else:
                task_id=spec.task_id or uid()
                if spec.task_id:
                    task=db.execute('SELECT * FROM tasks WHERE id=?',(task_id,)).fetchone()
                    if not task: raise HTTPException(404,'任务不存在')
                    if task['sample_kind'] != spec.sample_kind or task['goal'] != spec.goal:
                        raise HTTPException(409,'任务目标／样例类型不一致')
                else:
                    db.execute('INSERT INTO tasks VALUES (?,?,?,?,?)',(task_id,'live',task_id[:12],spec.goal,spec.sample_kind))
                attempt=db.execute('SELECT coalesce(max(attempt_index),0)+1 FROM runs WHERE task_id=?',(task_id,)).fetchone()[0]
                rid=uid(); created=now()
                run={'schema_version':'0.2','run_id':rid,'task_id':task_id,'external_run_id':rid[:12],
                     'attempt_index':attempt,'attempt_source':'live_session','raw_attempts':[],
                     'execution_status':'running','source_final_status':None,'report_ok':None,
                     'outcome_status':'unknown','model_status':'unknown','source_algorithm':spec.adapter,
                     'origin':'live','adapter_version':'collector-0.2.0','sample_kind':spec.sample_kind,
                     'event_count':0,'tool_call_count':0,'failed_tool_count':0,'confirmed_pairs':0,
                     'intervention_count':0,'diagnosis_id':None,'feedback':None,'warnings':[],
                     'created_at':created,'snapshot_hash':None,'artifacts':[], 'capture_integrity':'pending',
                     'exit_code':None,'ended_at':None,'dropped_events':0}
                db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?)',(rid,task_id,rid,attempt,'',dumps(run)))
                db.execute('INSERT INTO capture_sessions VALUES (?,?,?,?,?,?,NULL)',(rid,spec.request_id,request_hash,digest(spec.write_token),(datetime.now(timezone.utc)+timedelta(hours=24)).isoformat(),created))
                change(db,rid,'created')
            return {'run_id':run['run_id'],'task_id':run['task_id'],'url':'/runs/'+run['run_id']}

    @api.post('/api/live/runs/{run_id}/events')
    def ingest(run_id:str,batch:Batch,authorization:str|None=Header(None)):
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            session=session_for(db,run_id,authorization)
            run=payload(db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone())
            accepted=0
            for item in batch.events:
                raw=item.model_dump(mode='json')
                # Preserve the byte/hash contract of pre-bridge 0.2 receipts.
                # A new optional default must not invalidate an old retry.
                if raw.get('capture') is None:
                    raw.pop('capture', None)
                encoded=dumps(raw)
                if len(encoded.encode('utf-8'))>65536: raise HTTPException(413,'单条事件超过 64 KiB')
                hashed=digest(encoded)
                previous=db.execute('SELECT * FROM live_receipts WHERE run_id=? AND (source_id=? OR (producer_id=? AND seq=?))',(run_id,item.event_id,item.producer_id,item.producer_seq)).fetchall()
                if previous:
                    if len(previous)!=1 or previous[0]['source_id']!=item.event_id or previous[0]['hash']!=hashed:
                        raise HTTPException(409,'事件 ID 或生产者序号内容冲突')
                    continue
                if run['capture_integrity'] in ('complete','partial'): raise HTTPException(409,'采集已结束，不能追加新事件')
                if run['event_count']>=20000: raise HTTPException(413,'每轮最多 20,000 条事件')
                event_id=uid(); artifact_id=uid(); evidence_id=uid()
                filename=f'event-{item.event_id}.json'
                db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(artifact_id,run_id,filename,'live_event',hashed,encoded))
                evidence={'evidence_id':evidence_id,'run_id':run_id,'artifact_id':artifact_id,'filename':filename,'line':None,'json_pointer':'','event_id':event_id,'resolution_status':'resolved','original_reference':None}
                db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(evidence_id,run_id,artifact_id,dumps(evidence)))
                normalized,_=normalize_events([(1,{'kind':item.kind,'name':item.name,'span_id':item.source_span_id,'parent_span_id':item.parent_source_id,'correlation_id':item.correlation_id,'ts':raw['occurred_at'],'input':item.input,'output_text':item.output,'ok':item.ok,'error_signature':item.error_signature,'duration_ms':item.duration_ms})],run_id,lambda:event_id,lambda *_:evidence_id)
                event=normalized[0]
                if item.capture is not None:
                    event['capture'] = item.capture
                event.update(position=run['event_count'],line=None,producer_id=item.producer_id,producer_seq=item.producer_seq,received_at=now())
                db.execute('INSERT INTO events VALUES (?,?,?,?,?,?)',(event_id,run_id,event['position'],item.kind,item.name,dumps(event)))
                db.execute('INSERT INTO live_receipts VALUES (?,?,?,?,?,?)',(run_id,item.event_id,item.producer_id,item.producer_seq,hashed,event_id))
                if item.kind=='verification':
                    result=item.input
                    if not isinstance(result,dict) or result.get('status') not in ('passed','failed','unknown') or not result.get('source') or not result.get('basis'):
                        raise HTTPException(422,'验收事件需要 status、source 和 basis')
                    outcome={'outcome_id':uid(),'run_id':run_id,'status':result['status'],'source':result['source'],'basis':result['basis'],'summary':str(result.get('summary','')),'authoritative':True,'evidence_id':evidence_id,'reward':None,'verification_origin':'evaluated','observed_at':raw['occurred_at']}
                    db.execute('INSERT INTO outcomes VALUES (?,?,?)',(outcome['outcome_id'],run_id,dumps(outcome)))
                run['event_count']+=1; accepted+=1
            if accepted:
                events=[payload(r) for r in db.execute('SELECT * FROM events WHERE run_id=? ORDER BY position',(run_id,))]
                links,warnings=correlate(events)
                db.execute('DELETE FROM links WHERE run_id=?',(run_id,))
                for link in links:
                    link.update(link_id=uid(),run_id=run_id)
                    db.execute('INSERT INTO links VALUES (?,?,?)',(link['link_id'],run_id,dumps(link)))
                run.update(tool_call_count=sum(e['kind']=='tool_call' for e in events),failed_tool_count=sum(e['tool_status']=='failed' for e in events),confirmed_pairs=sum(l['relation']=='call_return' and l['status']=='confirmed' for l in links),warnings=sorted(set(warnings)))
                outcomes=[payload(r)['status'] for r in db.execute('SELECT * FROM outcomes WHERE run_id=?',(run_id,))]
                run['outcome_status']=outcomes[0] if outcomes and len(set(outcomes))==1 else 'unknown'
                if len(set(outcomes))>1: run['warnings'].append('outcome_conflict')
                if session['finish']: finalize(db,run,json.loads(session['finish']))
                save(db,run); change(db,run_id,'events')
            db.execute('UPDATE capture_sessions SET last_seen_at=? WHERE run_id=?',(now(),run_id))
            return {'accepted':accepted,'total':run['event_count']}

    @api.post('/api/live/runs/{run_id}/heartbeat')
    def heartbeat(run_id:str,authorization:str|None=Header(None)):
        with store.connect() as db:
            session_for(db,run_id,authorization)
            db.execute('UPDATE capture_sessions SET last_seen_at=? WHERE run_id=?',(now(),run_id))
        return {'ok':True}

    @api.post('/api/live/runs/{run_id}/finish')
    def finish(run_id:str,spec:Finish,authorization:str|None=Header(None)):
        try: spec.validate_counts()
        except ValueError as exc: raise HTTPException(422,str(exc)) from exc
        data=spec.model_dump()
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            session=session_for(db,run_id,authorization)
            if session['finish'] and json.loads(session['finish'])!=data: raise HTTPException(409,'执行结束信息冲突')
            run=payload(db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone())
            finalize(db,run,data)
            run.update(exit_code=spec.exit_code,execution_status='cancelled' if spec.reason=='interrupted' else 'completed' if spec.exit_code==0 and spec.reason=='exit' else 'failed',source_final_status=spec.reason,ended_at=run['ended_at'] or now())
            db.execute('UPDATE capture_sessions SET finish=?,last_seen_at=? WHERE run_id=?',(dumps(data),now(),run_id))
            save(db,run); change(db,run_id,'finished')
            return live_view(db,run)

    @api.get('/api/runs/{run_id}/stream')
    async def stream(run_id:str,request:Request,after:int=Query(0,ge=0),last_event_id:str|None=Header(None)):
        try: cursor=max(after,int(last_event_id or 0))
        except ValueError: raise HTTPException(422,'无效的续传游标')
        if cursor<0: raise HTTPException(422,'无效的续传游标')
        with store.connect() as db:
            if not db.execute('SELECT 1 FROM runs WHERE id=?',(run_id,)).fetchone(): raise HTTPException(404,'执行不存在')
        async def generate():
            nonlocal cursor
            while not await request.is_disconnected():
                with store.connect() as db:
                    rows=db.execute('SELECT * FROM live_changes WHERE run_id=? AND cursor>? ORDER BY cursor LIMIT 100',(run_id,cursor)).fetchall()
                    run=live_view(db,payload(db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone()))
                if rows:
                    cursor=rows[-1]['cursor']
                    yield f'id: {cursor}\nevent: update\ndata: {dumps(run)}\n\n'
                else:
                    yield f'event: status\ndata: {dumps(run)}\n\n'
                await asyncio.sleep(0.5)
        return StreamingResponse(generate(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

    return api
