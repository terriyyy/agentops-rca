"""Bounded, persistent offline diagnosis jobs; worker cannot mutate the platform DB."""
import json
import os
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .importer import uid,digest
from .storage import dumps,payload
from .analyst_context import build_prompt,request_body
from .model_settings import ModelSettings

ROOT=Path(__file__).resolve().parents[2]
CONFIG=ROOT/'.local/diagnosis-config.json'


class JobRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    request_id:str=Field(min_length=16,max_length=80)


class AnalystJobRequest(JobRequest):
    preview_sha256:str=Field(min_length=64,max_length=64)
    hgt_diagnosis_id:str=Field(min_length=16,max_length=80)


def utcnow():
    from datetime import datetime,timezone
    return datetime.now(timezone.utc).isoformat()


def make_snapshot(db,run):
    if run['execution_status']=='running' or run['execution_status']=='unknown':raise HTTPException(409,'执行尚未确认结束，不能诊断')
    if run['origin']=='live' and run.get('capture_integrity')!='complete':raise HTTPException(409,'采集数据不完整，暂不支持诊断')
    events=[payload(r) for r in db.execute('SELECT * FROM events WHERE run_id=? ORDER BY position',(run['run_id'],))]
    if not events or len(events)>5000:raise HTTPException(409,'诊断仅支持 1–5000 条事件的轨迹')
    active=None;seen=set();adapted=[];adjustments=[]
    for index,event in enumerate(events):
        kind=event['kind'];cid=event.get('correlation_id')
        if kind=='tool_call':
            if active or not cid or cid in seen:raise HTTPException(409,'当前算法适配仅支持无歧义的串行工具调用；请检查并行／重复／缺失关联')
            active=cid;seen.add(cid)
        elif kind=='tool_return':
            if not active or active!=cid:raise HTTPException(409,'调用返回不匹配或到达顺序不适配，暂不诊断')
            active=None
        # Never feed evaluator expected answers/outcomes to the localization model.
        if kind=='verification' or event['name'] in ('OUTCOME_EVIDENCE','RUN_END'):continue
        ok=event.get('raw_ok')
        if kind=='tool_return' and event['tool_status'] in ('failed','succeeded'):
            ok=event['tool_status']=='succeeded'
            output=event['output']
            if isinstance(output,str):
                try:output=json.loads(output)
                except ValueError:output=None
            if ok is False and isinstance(output,dict) and output.get('returncode')==0:
                raise HTTPException(409,'工具失败状态与退出码 0 冲突，当前算法无法可靠解释')
            if ok!=event.get('raw_ok'):adjustments.append({'event_id':event['event_id'],'field':'ok','basis':'normalized_tool_status'})
        adapted.append({'span_id':event['event_id'],'seq':index+1,'step_idx':index+1,'ts':event['occurred_at'],
                        'kind':kind,'name':event['name'],'correlation_id':cid,'input':event['input'],
                        'output_text':event['output'],'ok':ok,'duration_ms':event['duration_ms'],
                        'error_signature':event['error_signature']})
        if event.get('capture') is not None:
            adapted[-1]['capture'] = event['capture']
    if active or not seen:raise HTTPException(409,'缺少完整工具调用返回，不能运行 HGT 定位')
    if len(seen)>500:raise HTTPException(409,'首版离线定位最多 500 个工具转换')
    return {'schema_version':'0.3','adapter_version':'agenttether-hgt-0.3.1','run_id':run['run_id'],'task_id':run['task_id'],
            'attempt_index':run['attempt_index'],'source_snapshot_hash':run['snapshot_hash'],'events':adapted,'adjustments':adjustments,
            'evidence_map':{e['event_id']:e['evidence_id'] for e in events},'policy':'serial_only; evaluator_events_excluded; normalized_tool_status'}


class DiagnosisManager:
    def __init__(self,store,config_path=CONFIG,timeout=120,models=None):
        self.store=store;self.config_path=Path(config_path);self.timeout=timeout
        self.models=models or ModelSettings(store.path.parent/'rca-credentials'/store.path.stem)
        self.lock=threading.Lock();self.processes={};self.threads=[];self.closed=False

    def recover(self):
        with self.store.connect() as db:
            for row in db.execute("SELECT * FROM diagnosis_jobs WHERE state IN ('queued','running')").fetchall():
                job=payload(row);job.update(state='interrupted',error='服务重启，未确认的诊断已中断',finished_at=utcnow())
                self.save(db,job)

    def save(self,db,job):
        db.execute('UPDATE diagnosis_jobs SET state=?,payload=? WHERE id=?',(job['state'],dumps(job),job['job_id']))

    def config(self):
        try:
            config=json.loads(self.config_path.read_text(encoding='utf-8'))
            for key in ('python','source','bundle','source_sha256','weight_sha256','manifest_sha256'):assert config[key]
            if not Path(config['python']).is_file():raise ValueError()
            return config
        except (OSError,ValueError,KeyError,AssertionError):return None

    def analyst_config(self):
        try:record=self.models.read()
        except HTTPException:return None
        if not record or not record.get('enabled'):return None
        return {k:record[k] for k in ('name','base_url','model','revision','source','token_parameter')}|{'provider':record['name']}

    def capabilities(self):
        config=self.config()
        # A recorded probe is valid only for this exact configuration.
        probe=(config or {}).get('probe',{})
        current=digest(dumps({k:v for k,v in (config or {}).items() if k!='probe'}))
        valid=probe.get('config_hash')==current and probe.get('hgt')=='ready'
        analyst=self.analyst_config()
        last=None
        with self.store.connect() as db:
            row=db.execute("SELECT payload FROM diagnosis_jobs WHERE json_extract(payload,'$.mode')='analyst_rca' AND json_extract(payload,'$.config_revision')=? ORDER BY created_at DESC LIMIT 1",(analyst['revision'] if analyst else '',)).fetchone()
            if row:last=payload(row)
        analyst_state='unconfigured' if not analyst else 'last_call_succeeded' if last and last['state']=='succeeded' else 'last_call_failed' if last and last['state'] in ('failed','timed_out') else 'configured'
        return {'status':'ready' if valid and analyst_state=='last_call_succeeded' else 'degraded' if valid else 'unavailable',
                'hgt':'ready' if valid else 'unverified' if config else 'unavailable','analyst':analyst_state,'model':analyst['model'] if analyst else None,
                'provider':analyst['provider'] if analyst else None,'base_url':analyst['base_url'] if analyst else None,
                'config_revision':analyst['revision'] if analyst else None,'config_source':analyst['source'] if analyst else None,
                'reason':'本机定位可用；模型配置与调用状态独立显示' if valid else '定位环境尚未配置' if not config else '定位模型尚未通过独立加载检查',
                'provenance':probe.get('provenance') if valid else None}

    def analyst_material(self,db,run_id):
        row=db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone()
        if not row:raise HTTPException(404,'执行不存在')
        snapshot=make_snapshot(db,payload(row));snapshot_hash=digest(dumps(snapshot))
        config=self.config()
        if not config or self.capabilities()['hgt']!='ready':raise HTTPException(409,'HGT 尚未就绪')
        analyst=self.analyst_config()
        if not analyst:raise HTTPException(409,'原因分析模型尚未配置，请前往模型连接设置')
        for record in db.execute('SELECT * FROM diagnoses WHERE run_id=? ORDER BY rowid DESC',(run_id,)):
            report=payload(record)
            if report.get('format')!='agenttether-hgt' or report.get('origin')!='recomputed' or report.get('input_snapshot_hash')!=snapshot_hash:continue
            ref=db.execute('SELECT * FROM evidence WHERE id=?',(report['raw_evidence_id'],)).fetchone()
            if not ref:continue
            artifact=db.execute('SELECT * FROM artifacts WHERE id=?',(payload(ref)['artifact_id'],)).fetchone()
            if not artifact or digest(artifact['content'])!=artifact['sha256']:continue
            raw=json.loads(artifact['content'])
            provenance=raw.get('provenance') or {}
            if any(provenance.get(key)!=config.get(key) for key in ('source_sha256','weight_sha256','manifest_sha256')):continue
            if not raw.get('selected_units'):continue
            try:context=build_prompt(snapshot,raw)
            except ValueError as exc:raise HTTPException(409,str(exc)) from exc
            credentials=self.models.read()
            if credentials and credentials.get('enabled'):
                # Also redact this connection's exact key, even for nonstandard key formats.
                encoded=dumps(context['prompt']).replace(dumps(credentials['api_key'])[1:-1],'[REDACTED]')
                context.update(prompt=json.loads(encoded),prompt_sha256=digest(encoded),prompt_bytes=len(encoded.encode('utf-8')))
            try:body=request_body(config,context,analyst)
            except (OSError,ValueError,KeyError,SyntaxError):raise HTTPException(409,'分析环境的发送指令无法读取或内容过大，请检查定位环境配置') from None
            context['prompt_sha256']=digest(dumps(body))
            context['prompt_bytes']=len(dumps(body).encode('utf-8'))
            hgt_hash=artifact['sha256']
            preview_hash=digest(dumps({'prompt_sha256':context['prompt_sha256'],'hgt_sha256':hgt_hash,
                                       'hgt_diagnosis_id':report['diagnosis_id'],'model':analyst['model'],
                                       'provider':analyst['provider'],'base_url':analyst['base_url'],
                                       'config_revision':analyst['revision'],'token_parameter':analyst['token_parameter']}))
            return {'mode':'analyst_rca','prompt':context['prompt'],'request':body,'prompt_sha256':context['prompt_sha256'],'preview_sha256':preview_hash,
                    'prompt_bytes':context['prompt_bytes'],'candidate_ids':context['candidate_ids'],
                    'evidence_map':context['evidence_map'],'truncated':context['truncated'],
                    'input_snapshot_hash':snapshot_hash,'input_evidence_id':report['input_evidence_id'],
                    'hgt_diagnosis_id':report['diagnosis_id'],'hgt_sha256':hgt_hash,
                    'model':analyst['model'],'provider':analyst['provider'],'base_url':analyst['base_url'],
                    'config_revision':analyst['revision'],'token_parameter':analyst['token_parameter'],'run_id':run_id}
        raise HTTPException(409,'请先用当前版本重新运行 HGT 定位，生成同快照的候选证据')

    def preview_analyst(self,run_id):
        with self.models.lock,self.store.connect() as db:return self.analyst_material(db,run_id)

    def create_analyst(self,run_id,spec):
        with self.lock:
            if self.closed:raise HTTPException(503,'诊断服务正在关闭')
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                old=db.execute('SELECT * FROM diagnosis_jobs WHERE run_id=? AND request_id=?',(run_id,spec.request_id)).fetchone()
                if old:return payload(old)
                if db.execute("SELECT 1 FROM diagnosis_jobs WHERE state IN ('queued','running')").fetchone():raise HTTPException(409,'已有诊断正在运行')
                material=self.analyst_material(db,run_id)
                if material['preview_sha256']!=spec.preview_sha256 or material['hgt_diagnosis_id']!=spec.hgt_diagnosis_id:
                    raise HTTPException(409,'发送预览已变化，请重新查看后再运行')
                jid=uid();now=utcnow()
                prompt_text=dumps(material['request']);prompt_artifact=uid();prompt_ref=uid()
                db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(prompt_artifact,run_id,'analyst-prompt-'+jid+'.json','analyst_prompt',digest(prompt_text),prompt_text))
                ref={'evidence_id':prompt_ref,'run_id':run_id,'artifact_id':prompt_artifact,'filename':'analyst-prompt-'+jid+'.json',
                     'line':None,'json_pointer':'','event_id':None,'resolution_status':'resolved','original_reference':None}
                db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(prompt_ref,run_id,prompt_artifact,dumps(ref)))
                job={'job_id':jid,'run_id':run_id,'request_id':spec.request_id,'state':'queued','created_at':now,
                     'finished_at':None,'error':None,'diagnosis_id':None,'mode':'analyst_rca',
                     'input_snapshot_hash':material['input_snapshot_hash'],'input_evidence_id':material['input_evidence_id'],
                     'hgt_diagnosis_id':material['hgt_diagnosis_id'],'hgt_sha256':material['hgt_sha256'],
                     'prompt_sha256':material['prompt_sha256'],'prompt_evidence_id':prompt_ref,
                     'preview_sha256':material['preview_sha256'],'model':material['model'],
                     'provider':material['provider'],'base_url':material['base_url'],'config_revision':material['config_revision']}
                db.execute('INSERT INTO diagnosis_jobs VALUES (?,?,?,?,?,?)',(jid,run_id,spec.request_id,'queued',now,dumps(job)))
            config=self.config()
            credentials=self.models.read()
            if not credentials or credentials.get('revision')!=material['config_revision']:
                self.set_terminal(jid,'failed','模型配置已变化，请重新预览');raise HTTPException(409,'发送预览已变化，请重新查看后再运行')
            thread=threading.Thread(target=self.run,args=(jid,material,config,credentials['api_key']),daemon=True)
            self.threads=[t for t in self.threads if t.is_alive()];self.threads.append(thread);thread.start()
            return job

    def create(self,run_id,request_id):
        with self.lock:
            if self.closed:raise HTTPException(503,'诊断服务正在关闭')
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                previous=db.execute('SELECT * FROM diagnosis_jobs WHERE run_id=? AND request_id=?',(run_id,request_id)).fetchone()
                if previous:return payload(previous)
                if self.capabilities()['hgt']!='ready':raise HTTPException(409,'HGT 模型尚未就绪，请检查运行环境')
                if db.execute("SELECT 1 FROM diagnosis_jobs WHERE state IN ('queued','running')").fetchone():raise HTTPException(409,'已有诊断正在运行，首版同时只运行一个作业')
                row=db.execute('SELECT * FROM runs WHERE id=?',(run_id,)).fetchone()
                if not row:raise HTTPException(404,'执行不存在')
                snapshot=make_snapshot(db,payload(row));encoded=dumps(snapshot);snapshot_hash=digest(encoded)
                jid=uid();artifact=uid();ref=uid()
                db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(artifact,run_id,'diagnosis-input-'+jid+'.json','diagnosis_input',snapshot_hash,encoded))
                evidence={'evidence_id':ref,'run_id':run_id,'artifact_id':artifact,'filename':'diagnosis-input-'+jid+'.json','line':None,'json_pointer':'','event_id':None,'resolution_status':'resolved','original_reference':None}
                db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(ref,run_id,artifact,dumps(evidence)))
                job={'job_id':jid,'run_id':run_id,'request_id':request_id,'state':'queued','created_at':utcnow(),'finished_at':None,'error':None,'diagnosis_id':None,'input_snapshot_hash':snapshot_hash,'input_evidence_id':ref,'mode':'offline_hgt'}
                db.execute('INSERT INTO diagnosis_jobs VALUES (?,?,?,?,?,?)',(jid,run_id,request_id,'queued',job['created_at'],dumps(job)))
            thread=threading.Thread(target=self.run,args=(jid,snapshot,self.config()),daemon=True)
            self.threads=[t for t in self.threads if t.is_alive()]
            self.threads.append(thread);thread.start()
            return job

    def set_terminal(self,jid,state,error):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM diagnosis_jobs WHERE id=?',(jid,)).fetchone()
            job=payload(row)
            if job['state'] in ('queued','running'):
                job.update(state=state,error=error,finished_at=utcnow());self.save(db,job)
            return job

    def cancel(self,jid):
        with self.lock:
            with self.store.connect() as db:
                if not db.execute('SELECT 1 FROM diagnosis_jobs WHERE id=?',(jid,)).fetchone():raise HTTPException(404,'诊断作业不存在')
            job=self.set_terminal(jid,'cancelled','用户取消')
            process=self.processes.get(jid)
            if process and process.poll() is None:process.terminate()
            return job

    def run(self,jid,snapshot,config,credential=None):
        directory=self.store.path.parent/'diagnosis-jobs'/jid
        process=None
        try:
            directory.mkdir(parents=True,exist_ok=False)
            (directory/'input.json').write_text(dumps(snapshot),encoding='utf-8')
            (directory/'config.json').write_text(dumps(config),encoding='utf-8')
            env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','TEMP','TMP','PATH','COMSPEC','USERPROFILE')}
            env.update(PYTHONIOENCODING='utf-8',PYTHONDONTWRITEBYTECODE='1')
            with (directory/'worker.log').open('w',encoding='utf-8') as log:
                with self.lock:
                    if self.closed:return
                    with self.store.connect() as db:
                        job=payload(db.execute('SELECT * FROM diagnosis_jobs WHERE id=?',(jid,)).fetchone())
                        if job['state']!='queued':return
                        job['state']='running';self.save(db,job)
                    analyst=job.get('mode')=='analyst_rca'
                    script='analyst_worker.py' if analyst else 'diagnosis_worker.py'
                    process=subprocess.Popen([config['python'],str(ROOT/'apps/api'/script),'--config',str(directory/'config.json'),'--input',str(directory/'input.json'),'--output',str(directory/'output.json')],env=env,cwd=directory,stdin=subprocess.PIPE if analyst else subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    self.processes[jid]=process
                try:
                    if analyst:
                        process.communicate(input=dumps({'api_key':credential}).encode('utf-8'),timeout=self.timeout)
                    else:process.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait();self.set_terminal(jid,'timed_out','诊断超过时间限制');return
            output=directory/'output.json'
            if process.returncode!=0 or not output.exists():
                reason='worker_failed'
                if output.exists() and output.stat().st_size<4096:
                    try:reason=json.loads(output.read_text(encoding='utf-8')).get('error','worker_failed')
                    except (ValueError,OSError):pass
                if reason not in ('provider_http_401','provider_http_403','provider_http_429','provider_timeout','provider_error','invalid_model_output','invalid_turning_point','incomplete_plan','prompt_mismatch','source_hash_mismatch'):
                    reason='worker_failed'
                self.set_terminal(jid,'failed',reason);return
            if output.stat().st_size>16*1024*1024:raise ValueError('report_size')
            result=json.loads(output.read_text(encoding='utf-8'))
            if credential:
                # Do not retain an unexpected provider echo of the key in reports.
                result=json.loads(dumps(result).replace(dumps(credential)[1:-1],'[REDACTED]'))
            if snapshot.get('mode')=='analyst_rca':self.persist_analyst(jid,snapshot,result)
            else:self.persist(jid,snapshot,result)
        except Exception:
            self.set_terminal(jid,'failed','诊断处理失败；未发布报告')
        finally:
            if process and process.poll() is None:process.kill();process.wait()
            with self.lock:self.processes.pop(jid,None)

    def persist(self,jid,snapshot,result):
        if result.get('format')!='agenttether-hgt' or result.get('model_status')!='ready':raise ValueError('invalid_report')
        raw=dumps(result)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job=payload(db.execute('SELECT * FROM diagnosis_jobs WHERE id=?',(jid,)).fetchone())
            if job['state']!='running':return
            did=uid();artifact=uid();ref=uid();rid=job['run_id'];filename='diagnosis-'+did+'.json'
            db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(artifact,rid,filename,'diagnosis_report',digest(raw),raw))
            evidence={'evidence_id':ref,'run_id':rid,'artifact_id':artifact,'filename':filename,'line':None,'json_pointer':'','event_id':None,'resolution_status':'resolved','original_reference':None}
            db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(ref,rid,artifact,dumps(evidence)))
            findings=[]
            for finding in result['findings']:
                refs=[]
                for event_id in finding['event_ids']:
                    eid=snapshot['evidence_map'].get(event_id)
                    refs.append({'evidence_id':eid or ref,'event_id':event_id if eid else None,'resolution_status':'resolved' if eid else 'unresolved','label':('事件 '+event_id[:8]) if eid else '无法解析的模型引用'})
                findings.append({k:finding[k] for k in ('title','severity','description')}|{'evidence':refs})
            report={k:result[k] for k in ('format','model_status','model_reason','summary','graph','runtime_memory','guidance','provenance')}
            report.update(diagnosis_id=did,run_id=rid,origin='recomputed',source_algorithm='AgentTether / offline HGT',raw_evidence_id=ref,findings=findings,input_snapshot_hash=job['input_snapshot_hash'],input_evidence_id=job['input_evidence_id'],created_at=utcnow(),job_id=jid)
            db.execute('INSERT INTO diagnoses VALUES (?,?,?)',(did,rid,dumps(report)))
            job.update(state='succeeded',diagnosis_id=did,finished_at=utcnow());self.save(db,job)
            db.execute('INSERT INTO live_changes(run_id,kind) VALUES (?,?)',(rid,'diagnosis'))

    def persist_analyst(self,jid,material,result):
        if result.get('format')!='agenttether-analyst' or result.get('analysis_status')!='complete':raise ValueError('invalid_analyst_report')
        if result.get('prompt_sha256')!=material['prompt_sha256']:raise ValueError('prompt_mismatch')
        ids=set(material['candidate_ids'])
        if result.get('turning_point_transition_id') not in ids:raise ValueError('invalid_turning_point')
        event_ids=next(c['event_ids'] for c in material['prompt']['selected_subtrajectory'] if c['transition_id']==result['turning_point_transition_id'])
        refs=[{'evidence_id':material['evidence_map'][eid],'event_id':eid,'resolution_status':'resolved','label':'事件 '+eid[:8]} for eid in event_ids]
        raw=dumps(result)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job=payload(db.execute('SELECT * FROM diagnosis_jobs WHERE id=?',(jid,)).fetchone())
            if job['state']!='running':return
            did=uid();aid=uid();ref=uid();rid=job['run_id'];filename='analyst-'+did+'.json'
            db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',(aid,rid,filename,'analyst_report',digest(raw),raw))
            evidence={'evidence_id':ref,'run_id':rid,'artifact_id':aid,'filename':filename,'line':None,'json_pointer':'','event_id':None,'resolution_status':'resolved','original_reference':None}
            db.execute('INSERT INTO evidence VALUES (?,?,?,?)',(ref,rid,aid,dumps(evidence)))
            cited={item['event_id'] for item in refs}
            candidates={c['transition_id']:c['event_ids'] for c in material['prompt']['selected_subtrajectory']}
            for claim in result.get('evidence_chain',[]):
                value=claim.get('claim','')
                ids=candidates.get(value,[value] if value in material['evidence_map'] else [])
                for eid in ids:
                    if eid not in cited:
                        refs.append({'evidence_id':material['evidence_map'][eid],'event_id':eid,'resolution_status':'resolved','label':'引用事件 '+eid[:8]});cited.add(eid)
                if not ids:
                    refs.append({'evidence_id':ref,'event_id':None,'resolution_status':'unresolved','label':'无法核验的模型引用'})
            report={'diagnosis_id':did,'run_id':rid,'origin':'recomputed','format':'agenttether-analyst','mode':'analyst_rca',
                    'analysis_status':'complete',
                    'source_algorithm':'AgentTether HGT + LLMRecoveryAnalyst','model_status':'ready','model_reason':'联网 analyst 已返回结构化假设；未运行独立验收',
                    'summary':result['summary'],'findings':[{'title':'根因假设','severity':'warn','description':result['failed_assumption'],'evidence':refs}],
                    'graph':None,'runtime_memory':None,'guidance':result['guidance'],'verification_suggestion':result['verification_suggestion'],
                    'boundary':result['boundary'],'model_confidence_uncalibrated':result.get('confidence'),
                    'evidence_chain':result.get('evidence_chain',[]),'raw_evidence_id':ref,
                    'input_snapshot_hash':job['input_snapshot_hash'],'input_evidence_id':job['input_evidence_id'],
                    'prompt_evidence_id':job['prompt_evidence_id'],
                    'prompt_sha256':job['prompt_sha256'],'hgt_diagnosis_id':job['hgt_diagnosis_id'],'hgt_sha256':job['hgt_sha256'],
                    'provenance':result['provenance'],'usage':result.get('usage'),'created_at':utcnow(),'job_id':jid}
            db.execute('INSERT INTO diagnoses VALUES (?,?,?)',(did,rid,dumps(report)))
            job.update(state='succeeded',diagnosis_id=did,finished_at=utcnow());self.save(db,job)
            db.execute('INSERT INTO live_changes(run_id,kind) VALUES (?,?)',(rid,'diagnosis'))

    def close(self):
        with self.lock:
            self.closed=True
            with self.store.connect() as db:
                pending=[r['id'] for r in db.execute("SELECT id FROM diagnosis_jobs WHERE state IN ('queued','running')")]
            for jid in pending:self.set_terminal(jid,'interrupted','服务关闭，诊断中断')
            for jid,process in self.processes.items():
                if process.poll() is None:process.terminate()
        for thread in self.threads:thread.join(timeout=5)


def router(manager):
    api=APIRouter()
    @api.get('/api/diagnosis/capabilities')
    def capabilities():return manager.capabilities()
    @api.get('/api/runs/{run_id}/analyst-preview')
    def analyst_preview(run_id:str):return manager.preview_analyst(run_id)
    @api.post('/api/runs/{run_id}/analyst-jobs')
    def analyst_job(run_id:str,spec:AnalystJobRequest):return manager.create_analyst(run_id,spec)
    @api.post('/api/runs/{run_id}/diagnosis-jobs')
    def create(run_id:str,spec:JobRequest):return manager.create(run_id,spec.request_id)
    @api.get('/api/runs/{run_id}/diagnosis-jobs')
    def jobs(run_id:str):
        with manager.store.connect() as db:return [payload(r) for r in db.execute('SELECT * FROM diagnosis_jobs WHERE run_id=? ORDER BY created_at DESC',(run_id,))]
    @api.post('/api/diagnosis-jobs/{jid}/cancel')
    def cancel(jid:str):return manager.cancel(jid)
    return api
