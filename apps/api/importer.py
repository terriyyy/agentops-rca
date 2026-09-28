import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4

from .contracts import ImportManifest
from .normalizer import (
    ADAPTER_VERSION, correlate, normalize_events, normalize_outcomes,
    normalize_report, object_json, telemetry_rows, readable,
)
from .storage import dumps, payload


def uid():
    return uuid4().hex


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ImportConflict(ValueError):
    pass


def import_package(store, manifest: ImportManifest, files: dict[str, str]):
    required = {name for r in manifest.runs for name in (r.telemetry,r.report,r.outcome,r.feedback) if name}
    if required != set(files):
        raise ValueError("上传文件必须与清单完全一致；检查缺失或多余文件")
    serialized = manifest.model_dump()
    package_hash = digest(dumps({"manifest":serialized,"files":{k:digest(v) for k,v in sorted(files.items())}}))
    now = datetime.now(timezone.utc).isoformat()
    with store.connect() as db:
        # Lock before identity checks, so simultaneous imports remain idempotent.
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM imports WHERE package_hash=?",(package_hash,)).fetchone()
        if existing:
            return {**payload(existing),"duplicate":True}
        task = db.execute("SELECT * FROM tasks WHERE namespace=? AND external_id=?",(manifest.source_namespace,manifest.task_id)).fetchone()
        task_id = task["id"] if task else uid()
        if task and (task["goal"]!=manifest.goal or task["sample_kind"]!=manifest.sample_kind):
            raise ImportConflict("同一任务的目标或样例类型已变化，请使用新的来源命名空间")
        if not task:
            db.execute("INSERT INTO tasks VALUES (?,?,?,?,?)",(task_id,manifest.source_namespace,manifest.task_id,manifest.goal,manifest.sample_kind))
        run_ids, package_warnings = [], []
        for spec in sorted(manifest.runs,key=lambda r:r.attempt_index):
            names = {key:getattr(spec,key) for key in ("telemetry","report","outcome","feedback") if getattr(spec,key)}
            snapshot = digest(dumps({"spec":spec.model_dump(),"files":{k:digest(files[v]) for k,v in names.items()}}))
            existing = db.execute("SELECT * FROM runs WHERE task_id=? AND external_id=?",(task_id,spec.run_key)).fetchone()
            if existing:
                if existing["snapshot_hash"]!=snapshot: raise ImportConflict("相同 run_key 的内容已变化；请使用新的 run_key 和轮次，原记录不会被覆盖")
                run_ids.append(existing["id"])
                package_warnings.extend(payload(existing)["warnings"])
                continue
            if db.execute("SELECT id FROM runs WHERE task_id=? AND attempt_index=?",(task_id,spec.attempt_index)).fetchone():
                raise ImportConflict("该任务的轮次已存在，不能使用其他 run_key 覆盖")
            run_id=uid()
            db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?)",(run_id,task_id,spec.run_key,spec.attempt_index,snapshot,'{}'))
            artifacts={}
            for kind,name in names.items():
                artifact_id=uid()
                db.execute("INSERT INTO artifacts VALUES (?,?,?,?,?,?)",(artifact_id,run_id,name,kind,digest(files[name]),files[name]))
                artifacts[kind]=artifact_id

            def evidence(kind, line=None, pointer=None, event_id=None, status="resolved", original=None):
                eid=uid()
                data={"evidence_id":eid,"run_id":run_id,"artifact_id":artifacts[kind],"filename":names[kind],"line":line,"json_pointer":pointer,"event_id":event_id,"resolution_status":status,"original_reference":original}
                db.execute("INSERT INTO evidence VALUES (?,?,?,?)",(eid,run_id,artifacts[kind],dumps(data)))
                return eid

            rows=telemetry_rows(files[spec.telemetry])
            report=object_json(files[spec.report],"诊断报告") if spec.report else {}
            outcome_doc=object_json(files[spec.outcome],"验收记录") if spec.outcome else {}
            events,warnings=normalize_events(rows,run_id,uid,lambda line,event:evidence("telemetry",line=line,event_id=event))
            by_line={e["line"]:e for e in events}
            for event in events:
                db.execute("INSERT INTO events VALUES (?,?,?,?,?,?)",(event["event_id"],run_id,event["position"],event["kind"],event["name"],dumps(event)))
            links,link_warnings=correlate(events)
            warnings.extend(link_warnings)
            for link in links:
                link.update(link_id=uid(),run_id=run_id)
                db.execute("INSERT INTO links VALUES (?,?,?)",(link["link_id"],run_id,dumps(link)))
            raw_attempts=list({dumps(row.get("attempt")) for _,row in rows})
            if any(json.loads(value)!=spec.attempt_index for value in raw_attempts): warnings.append("attempt_overridden_by_manifest")
            outcomes,status,outcome_warnings=normalize_outcomes(outcome_doc,report,rows,spec.attempt_index)
            warnings.extend(outcome_warnings)
            for outcome in outcomes:
                kind=outcome["source_kind"]
                line=outcome.get("line")
                outcome.update(outcome_id=uid(),run_id=run_id,evidence_id=evidence(kind,line=line,pointer=outcome["locator"] if not line else None,event_id=by_line[line]["event_id"] if line else None))
                db.execute("INSERT INTO outcomes VALUES (?,?,?)",(outcome["outcome_id"],run_id,dumps(outcome)))
            meta=report.get("run_meta") if isinstance(report.get("run_meta"),dict) else {}
            if meta.get('ok') is not None and not isinstance(meta['ok'],bool):
                raise ValueError('报告 run_meta.ok 必须是布尔值')
            if meta.get("ok") is not None and status != "unknown" and (meta["ok"] is True)!=(status=="passed"):
                warnings.append("report_ok_differs_from_outcome")
            diagnosis_id=None
            model_status="unknown"
            if spec.report:
                def build_ref(pointer,ref,matches,resolution):
                    if resolution=="resolved":
                        match=matches[0]
                        return {"evidence_id":match["evidence_id"],"resolution_status":"resolved","event_id":match["event_id"],"label":f"L{match['line']} · {match['name']}"}
                    warnings.append("diagnosis_evidence_"+resolution)
                    return {"evidence_id":evidence("report",pointer=pointer,status=resolution,original=ref),"resolution_status":resolution,"event_id":None,"label":"报告原始引用"}
                diagnosis=normalize_report(report,events,build_ref)
                diagnosis_id=uid()
                model_status=diagnosis["model_status"]
                diagnosis.update(diagnosis_id=diagnosis_id,run_id=run_id,origin="imported",source_algorithm=spec.source_algorithm,input_snapshot_hash=snapshot,engine_version=None,raw_evidence_id=evidence("report",pointer=""))
                db.execute("INSERT INTO diagnoses VALUES (?,?,?)",(diagnosis_id,run_id,dumps(diagnosis)))
            else:
                warnings.append("diagnosis_missing")
            final_status=meta.get("final_status")
            if not final_status:
                end=next((r for _,r in reversed(rows) if r.get("name")=="RUN_END"),{})
                end_input=end.get("input") if isinstance(end.get("input"),dict) else {}
                final_status=end_input.get("final_status") or end_input.get("status")
            final_status=readable(final_status) or None
            state=str(final_status or "unknown").lower()
            execution_status="completed" if state in {"submitted","completed","success","finished"} else "failed" if state in {"error","failed","crashed"} else "cancelled" if state=="cancelled" else "unknown"
            feedback={"text":files[spec.feedback],"evidence_id":evidence("feedback",pointer=None),"origin":"imported","injection_verified":False} if spec.feedback else None
            run={"schema_version":"0.1","run_id":run_id,"task_id":task_id,"external_run_id":spec.run_key,"attempt_index":spec.attempt_index,"attempt_source":"manifest","raw_attempts":[json.loads(v) for v in sorted(raw_attempts)],"execution_status":execution_status,"source_final_status":final_status,"report_ok":meta.get("ok"),"outcome_status":status,"model_status":model_status,"source_algorithm":spec.source_algorithm,"origin":"imported","adapter_version":ADAPTER_VERSION,"sample_kind":manifest.sample_kind,"event_count":len(events),"tool_call_count":sum(e['kind']=='tool_call' for e in events),"failed_tool_count":sum(e['tool_status']=='failed' for e in events),"confirmed_pairs":sum(l['relation']=='call_return' and l['status']=='confirmed' for l in links),"intervention_count":sum('INTERVENTION' in e['name'].upper() for e in events),"diagnosis_id":diagnosis_id,"feedback":feedback,"warnings":sorted(set(warnings)),"created_at":now,"snapshot_hash":snapshot,"artifacts":[{"artifact_id":artifacts[k],"kind":k,"filename":name,"sha256":digest(files[name])} for k,name in names.items()]}
            db.execute("UPDATE runs SET payload=? WHERE id=?",(dumps(run),run_id))
            run_ids.append(run_id)
            package_warnings.extend(warnings)
        result={"import_id":uid(),"task_id":task_id,"run_ids":run_ids,"status":"completed","duplicate":False,"package_hash":package_hash,"created_at":now,"warnings":sorted(set(package_warnings)),"manifest":serialized}
        db.execute("INSERT INTO imports VALUES (?,?,?,?)",(result["import_id"],package_hash,now,dumps(result)))
    return result
