"""Build a bounded, previewable analyst request from a persisted HGT result."""
import re
import ast
from pathlib import Path

from .importer import digest
from .storage import dumps

MAX_PROMPT_BYTES=24_000
SECRET=re.compile(r'(?i)(?:bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})')
SECRET_FIELD=re.compile(r'''(?ix)(["']?(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)''')


def request_body(config,context,connection):
    """Read the upstream instruction as data, without importing/executing algorithm code."""
    source=Path(config['source'])/'agent_tether/recovery/llm_analyst.py'
    if source.stat().st_size>128*1024:raise ValueError('analyst_instruction_unavailable')
    tree=ast.parse(source.read_text(encoding='utf-8'))
    instruction=None
    for node in tree.body:
        if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='_SYSTEM_PROMPT' for target in node.targets):
            instruction=ast.literal_eval(node.value);break
    if not isinstance(instruction,str):raise ValueError('analyst_instruction_unavailable')
    body={'model':connection['model'],'messages':[{'role':'system','content':instruction},
         {'role':'user','content':dumps(context['prompt'])}],connection['token_parameter']:2500}
    if len(dumps(body).encode('utf-8'))>32_000:raise ValueError('analyst_prompt_too_large')
    return body


def clipped(value,limit):
    value=SECRET.sub('[REDACTED]',str(value or ''))
    value=SECRET_FIELD.sub(lambda match:match.group(1)+'[REDACTED]',value)
    return value[:limit]+('…[truncated]' if len(value)>limit else '')


def build_prompt(snapshot,hgt):
    selected=hgt.get('selected_units') or []
    evidence=snapshot.get('evidence_map') or {}
    if not selected:raise ValueError('hgt_selected_units_missing')
    candidates=[]
    for unit in selected[:12]:
        ids=unit.get('span_ids') or []
        if not ids or any(item not in evidence for item in ids):raise ValueError('hgt_evidence_unresolved')
        tid=unit.get('transition_id')
        if not isinstance(tid,str) or not tid:raise ValueError('hgt_transition_invalid')
        candidates.append({'transition_id':tid,'event_ids':ids[:4],'tool':clipped(unit.get('tool'),100),
                           'status':clipped(unit.get('status'),32),'action':clipped(unit.get('action'),900),
                           'feedback':clipped(unit.get('feedback'),1400),'error_signature':clipped(unit.get('error_signature'),280)})
    if len({c['transition_id'] for c in candidates})!=len(candidates):raise ValueError('hgt_transition_duplicate')
    prompt={'task':'diagnose_recovery_turning_point_from_graph_evidence',
            'response_language':'Simplified Chinese for explanatory text; preserve IDs and JSON keys',
            'run_id':snapshot['run_id'],
            'selected_subtrajectory':candidates,
            'required_output_schema':{
                'turning_point_transition_id':'one selected_subtrajectory.transition_id',
                'rca_summary':'specific root-cause hypothesis',
                'failed_assumption':'string',
                'evidence_chain':['event_id or transition_id'],
                'recovery_plan':{'target':'string','operation':'string','verification':'test to run, not completed','boundary':'string'},
                'confidence':'0_to_1_uncalibrated_number'}}
    encoded=dumps(prompt)
    size=len(encoded.encode('utf-8'))
    if size>MAX_PROMPT_BYTES:raise ValueError('analyst_prompt_too_large')
    return {'prompt':prompt,'prompt_sha256':digest(encoded),'prompt_bytes':size,
            'candidate_ids':[c['transition_id'] for c in candidates],
            'evidence_map':{eid:evidence[eid] for c in candidates for eid in c['event_ids']},
            'truncated':len(selected)>12}
