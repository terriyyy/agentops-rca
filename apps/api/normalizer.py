"""Historical data adapters. Never imports or executes algorithm/telemetry code."""
import collections
import json
from datetime import datetime


ADAPTER_VERSION = "historical-0.1.0"


def parse_json(text, label):
    def reject_constant(value):
        raise ValueError("非有限数值不被支持")
    try:
        return json.loads(text.lstrip('\ufeff'), parse_constant=reject_constant)
    except (ValueError, RecursionError) as exc:
        raise ValueError(f"{label} 不是有效的 JSON") from exc


def object_json(text, label):
    value = parse_json(text, label)
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必须是 JSON 对象")
    return value


def readable(value):
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def tool_status(row):
    ok = row.get("ok")
    output = row.get("output_text")
    if isinstance(output, str):
        try:
            output = json.loads(output)
        except (ValueError, RecursionError):
            output = None
    rc = output.get("returncode") if isinstance(output, dict) else None
    if ok is False or (isinstance(rc, int) and not isinstance(rc, bool) and rc != 0):
        return "failed", bool(ok is True and rc not in (None, 0))
    if ok is True or rc == 0:
        return "succeeded", False
    return "unknown", False


def telemetry_rows(text):
    rows = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        row = object_json(line, f"轨迹第 {line_no} 行")
        if not isinstance(row.get("kind"), str) or not row["kind"]:
            raise ValueError(f"轨迹第 {line_no} 行缺少 kind")
        for key in ("span_id", "correlation_id", "parent_span_id", "name"):
            if row.get(key) is not None and not isinstance(row[key], str):
                raise ValueError(f"轨迹第 {line_no} 行的 {key} 必须是文本")
        for key in ("ts", "error_signature"):
            if row.get(key) is not None and not isinstance(row[key], str):
                raise ValueError(f"轨迹第 {line_no} 行的 {key} 必须是文本")
        if row.get("duration_ms") is not None and (isinstance(row['duration_ms'],bool) or not isinstance(row['duration_ms'],(int,float)) or row['duration_ms']<0):
            raise ValueError(f"轨迹第 {line_no} 行的 duration_ms 必须是非负数")
        if row.get('ok') is not None and not isinstance(row['ok'],bool):
            raise ValueError(f"轨迹第 {line_no} 行的 ok 必须是布尔值")
        rows.append((line_no, row))
        if len(rows) > 20000:
            raise ValueError("每轮最多支持 20,000 条事件")
    if not rows:
        raise ValueError("轨迹不能为空")
    return rows


def normalize_events(rows, run_id, make_id, evidence_for_line):
    events, warnings = [], []
    for position, (line_no, raw) in enumerate(rows):
        event_id = make_id()
        status, conflict = tool_status(raw) if raw["kind"] == "tool_return" else ("unknown", False)
        if conflict:
            warnings.append("tool_status_conflict")
        ts = raw.get("ts")
        try:
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                warnings.append("timestamp_timezone_missing")
        except (ValueError, TypeError, AttributeError):
            warnings.append("timestamp_missing_or_invalid")
        events.append({
            "event_id": event_id, "run_id": run_id, "position": position, "line": line_no,
            "source_span_id": raw.get("span_id"), "correlation_id": raw.get("correlation_id"),
            "parent_source_id": raw.get("parent_span_id"), "kind": raw["kind"], "name": raw.get("name") or raw["kind"],
            "occurred_at": ts, "seq": raw.get("seq"), "step_idx": raw.get("step_idx"),
            "raw_attempt": raw.get("attempt"), "input": raw.get("input"), "output": raw.get("output_text"),
            "duration_ms": raw.get("duration_ms"), "tool_status": status, "raw_ok": raw.get("ok"),
            "error_signature": raw.get("error_signature"),
            "evidence_id": evidence_for_line(line_no, event_id),
        })
    return events, warnings


def correlate(events):
    calls, returns, spans = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    links, warnings = [], []
    for e in events:
        if e["source_span_id"]:
            spans[e["source_span_id"]].append(e)
        if e["kind"] in ("tool_call", "tool_return"):
            if not e["correlation_id"]:
                warnings.append("missing_correlation_id")
                links.append({"relation":"call_return", "basis":"explicit_id", "status":"unresolved", "event_ids":[e["event_id"]]})
            else:
                (calls if e["kind"] == "tool_call" else returns)[e["correlation_id"]].append(e)
    for key in calls.keys() | returns.keys():
        a, b = calls[key], returns[key]
        status = "confirmed" if len(a) == len(b) == 1 else "ambiguous" if len(a) > 1 or len(b) > 1 else "unresolved"
        links.append({"relation":"call_return", "basis":"explicit_id", "status":status, "correlation_id":key, "event_ids":[e["event_id"] for e in a+b]})
        if status != "confirmed": warnings.append(f"call_return_{status}")
    for e in events:
        if e["parent_source_id"]:
            candidates = spans[e["parent_source_id"]]
            status = "confirmed" if len(candidates)==1 and candidates[0]["event_id"] != e["event_id"] else "ambiguous" if candidates else "unresolved"
            links.append({"relation":"parent", "basis":"explicit_parent", "status":status, "event_ids":[e["event_id"]]+[p["event_id"] for p in candidates]})
    if any(len(items)>1 for items in spans.values()): warnings.append("duplicate_source_span_id")
    return links, warnings


def resolve_reference(ref, events):
    if not isinstance(ref, dict): return [], "unresolved"
    if ref.get("span_id"):
        found = [e for e in events if e["source_span_id"] == ref["span_id"]]
    elif ref.get("correlation_id"):
        found = [e for e in events if e["correlation_id"] == ref["correlation_id"] and e["kind"] == (ref.get("kind") or "tool_return")]
    else:
        return [], "unresolved"
    if ref.get("name"): found = [e for e in found if e["name"] == ref["name"]]
    return found, "resolved" if len(found)==1 else "ambiguous" if found else "unresolved"


def normalize_outcomes(outcome_doc, report, rows, attempt):
    """An explicit evaluator file is authoritative; retain other sources as evidence."""
    candidates = []
    def append_rows(doc, origin, authoritative):
        if not isinstance(doc, dict): return
        records = doc.get("outcome_evidence")
        if not isinstance(records, list): records = [doc] if any(k in doc for k in ("resolved", "reward", "status")) else []
        for index, record in enumerate(records):
            if not isinstance(record, dict): continue
            iteration = record.get("iter", record.get("iteration"))
            if iteration is not None and str(iteration) != str(attempt): continue
            status = "passed" if record.get("resolved") is True else "failed" if record.get("resolved") is False else "unknown"
            if record.get("status") in ("missing", "unknown"): status = "unknown"
            reward=record.get('reward')
            if reward is not None and (isinstance(reward,bool) or not isinstance(reward,(int,float))):
                raise ValueError('验收 reward 必须是数值')
            candidates.append({"status":status, "source":readable(record.get("source", "historical_evaluator")), "basis":record.get("reward_basis", record.get("basis", "resolved")), "reward":reward, "summary":readable(record.get("summary", "")), "observed_at":record.get("updated_at"), "verification_origin":"imported", "authoritative":authoritative, "source_kind":origin, "locator":f"/outcome_evidence/{index}" if isinstance(doc.get("outcome_evidence"),list) else "", "raw":record})
    append_rows(outcome_doc,"outcome",True)
    append_rows(report,"report",False)
    if not candidates:
        for line_no, row in rows:
            if row.get("name") == "OUTCOME_EVIDENCE":
                before=len(candidates)
                append_rows(row.get("input"),"telemetry",False)
                for item in candidates[before:]:item["line"]=line_no
    primary = [c for c in candidates if c["authoritative"]] or candidates
    states = {c["status"] for c in primary}
    status = next(iter(states)) if len(states)==1 else "unknown"
    conflict = len(states)>1
    warnings = ["outcome_conflict"] if conflict else []
    if not candidates: warnings.append("outcome_missing")
    if any(c["status"] != status for c in candidates): warnings.append("outcome_sources_disagree")
    return candidates, status, warnings


def normalize_report(report, events, reference_builder):
    enhanced = "hierarchical_trajectory_graph" in report or "runtime_memory" in report
    rca = report.get("rca") if isinstance(report.get("rca"),dict) else {}
    result = rca.get("result", rca)
    result = result if isinstance(result,dict) else {}
    model = report.get("pipeline",{}).get("offline_model_bundle",{}) if isinstance(report.get("pipeline"),dict) else {}
    model_status = "ready" if model.get("ok") is True else "unavailable" if model.get("ok") is False or rca.get("mode")=="bundle_missing" else "unknown"
    findings=[]
    raw_findings = report.get("findings",[])
    if not isinstance(raw_findings,list): raise ValueError("报告 findings 必须为数组")
    for i, item in enumerate(raw_findings):
        if not isinstance(item,dict): raise ValueError("报告 finding 必须为对象")
        refs=[]
        for j, ref in enumerate(item.get("evidence") or []):
            matches,status=resolve_reference(ref,events)
            refs.append(reference_builder(f"/findings/{i}/evidence/{j}",ref,matches,status))
        findings.append({"title":readable(item.get("title") or item.get("type") or "历史发现"), "severity":item.get("severity","info"), "type":item.get("type"), "description":readable(item.get("llm_explanation") or item.get("description") or item.get("detail")), "evidence":refs})
    guidance=report.get("next_iteration_feedback",{}).get("text") if isinstance(report.get("next_iteration_feedback"),dict) else None
    graph=report.get('hierarchical_trajectory_graph')
    if graph is not None:
        if not isinstance(graph,dict): raise ValueError('轨迹图必须是 JSON 对象')
        for key in ('macro_nodes','micro_nodes','edges'):
            if key in graph and (not isinstance(graph[key],list) or any(not isinstance(n,dict) for n in graph[key])):
                raise ValueError(f'轨迹图 {key} 必须是对象数组')
    return {"format":"probe_enhanced" if enhanced else "probe_legacy", "adapter_version":ADAPTER_VERSION,
            "model_status":model_status,"model_reason":readable(model.get("reason")), "mode":rca.get("mode","historical"),
            "summary":readable(result.get("primary_cause") or result.get("rca_summary") or rca.get("reason")) or "历史报告未提供根因摘要",
            "findings":findings,"graph":graph,"runtime_memory":report.get("runtime_memory"),"guidance":readable(guidance)}
