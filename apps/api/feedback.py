"""RCA-guided feedback drafts (P1): assemble, edit, hash-confirm and cancel.

A confirmed record is only a prepared, hash-pinned artifact plus a content
reference. This module never creates a Run, launches an agent or calls a model;
actual injection and receipt verification belong to a later phase.
"""
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from .analyst_context import SECRET, SECRET_FIELD
from .importer import digest, uid
from .storage import dumps, payload

SCHEMA = 'feedback-1.0'
MAX_FEEDBACK_BYTES = 24_000
SECTION_KEYS = ('task', 'failures', 'rca', 'evidence', 'guidance', 'verification')
SECTION_TITLES = {
    'task': '1. 原任务',
    'failures': '2. 上轮失败事实',
    'rca': '3. RCA候选原因（待验证）',
    'evidence': '4. 相关证据',
    'guidance': '5. 修复指导（建议，未执行）',
    'verification': '6. 复验要求',
}
# failure-first budgets: derived sections are squeezed before factual indexes.
SHRINK_ORDER = (('rca', 1500), ('guidance', 1500), ('task', 1000),
                ('verification', 1000), ('failures', 1000))


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class DraftRequest(Strict):
    request_id: str = Field(min_length=16, max_length=80)
    source_diagnosis_id: str | None = Field(default=None, min_length=16, max_length=80)


class SectionEdit(Strict):
    text: str = Field(min_length=0, max_length=8000)


class EditRequest(Strict):
    sections: dict[str, SectionEdit] = Field(min_length=1)


class ConfirmRequest(Strict):
    content_sha256: str = Field(min_length=64, max_length=64)


class CancelRequest(Strict):
    reason: str = Field(default='', max_length=200)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def redact(value):
    """Return (redacted_text, secret_match_count). Banning happens before hashing."""
    text = str(value or '')
    matches = len(SECRET.findall(text)) + len(SECRET_FIELD.findall(text))
    text = SECRET.sub('[REDACTED]', text)
    text = SECRET_FIELD.sub(lambda m: m.group(1) + '[REDACTED]', text)
    return text, matches


def clip(value, limit, trunc, section, field):
    """Redact, then cut by characters with an explicit truncation ledger entry."""
    text, matches = redact(value)
    if len(text) > limit:
        kept = text[:limit] + '…[truncated]'
        trunc['items'].append({'section': section, 'field': field,
                               'original_bytes': len(text.encode('utf-8')),
                               'kept_bytes': len(kept.encode('utf-8')),
                               'reason': 'field_budget'})
        text = kept
    return text, matches


def shrink(text, max_bytes, trunc, section, field):
    """Byte-safe last-resort cut; factual indexes never go through this."""
    raw = text.encode('utf-8')
    if len(raw) <= max_bytes:
        return text
    cut = raw[:max_bytes].decode('utf-8', errors='ignore').rstrip() + '…[truncated]'
    trunc['items'].append({'section': section, 'field': field,
                           'original_bytes': len(raw),
                           'kept_bytes': len(cut.encode('utf-8')),
                           'reason': 'total_budget'})
    return cut


def report_kind(report):
    if report.get('origin') == 'imported':
        return 'historical'
    if report.get('mode') == 'analyst_rca' or report.get('format') == 'agenttether-analyst':
        return 'hypothesis'
    if report.get('format') == 'agenttether-hgt' or report.get('origin') == 'recomputed':
        return 'localization'
    return 'historical'


def gather_failures(db, run, trunc, redaction):
    """Execution errors and independent check failures, kept as structured items."""
    items = []
    run_id = run['run_id']
    if run['execution_status'] == 'failed':
        items.append({'type': 'execution_error', 'failure_class': 'execution',
                      'title': '执行异常结束', 'event_id': None, 'evidence_id': None,
                      'source_final_status': run.get('source_final_status'),
                      'exit_code': run.get('exit_code')})
    where = ("json_extract(payload,'$.tool_status')='failed' OR "
             "(json_extract(payload,'$.error_signature') IS NOT NULL AND "
              "json_extract(payload,'$.error_signature')!='')")
    total = db.execute(f'SELECT count(*) FROM events WHERE run_id=? AND ({where})',
                       (run_id,)).fetchone()[0]
    rows = db.execute(f'SELECT payload FROM events WHERE run_id=? AND ({where}) '
                      'ORDER BY position LIMIT 3', (run_id,)).fetchall()
    for row in rows:
        event = payload(row)
        detail, m1 = clip(event.get('output') if event.get('output') is not None else event.get('input'),
                          900, trunc, 'failures', 'tool_detail')
        signature, m2 = clip(event.get('error_signature'), 280, trunc, 'failures', 'error_signature')
        redaction['matches'] += m1 + m2
        items.append({'type': 'tool_failure', 'failure_class': 'execution',
                      'title': str(event.get('name') or '失败步骤'),
                      'event_id': event.get('event_id'), 'evidence_id': event.get('evidence_id'),
                      'position': event.get('position'), 'error_signature': signature,
                      'detail': detail})
    if total > len(rows):
        trunc['omissions'].append({'kind': 'tool_failure_not_listed', 'total': total,
                                   'included': len(rows), 'reason': 'failed_tool_events_cap_3'})
    if run['outcome_status'] == 'failed':
        # Every failed independent check is evidence for the next round; no LIMIT here.
        for row in db.execute('SELECT payload FROM outcomes WHERE run_id=?', (run_id,)).fetchall():
            outcome = payload(row)
            if outcome.get('status') != 'failed':
                continue
            basis, m1 = clip(outcome.get('basis'), 900, trunc, 'failures', 'check_basis')
            summary, m2 = clip(outcome.get('summary'), 500, trunc, 'failures', 'check_summary')
            source, m3 = redact(outcome.get('source'))
            redaction['matches'] += m1 + m2 + m3
            items.append({'type': 'check_failure', 'failure_class': 'verification',
                          'title': '独立任务验收未通过', 'event_id': None,
                          'evidence_id': outcome.get('evidence_id'), 'source': source,
                          'basis': basis, 'summary': summary,
                          'verification_origin': outcome.get('verification_origin'),
                          'observed_at': outcome.get('observed_at')})
    return items


def build_task(goal, redaction):
    text, matches = redact(goal)
    redaction['matches'] += matches
    body = ('任务目标（原文）：\n' + text +
            '\n\n约束：保持原任务目标与验收标准不变；下一轮在同一任务内完成修复，不得降低原检查要求。')
    return {'key': 'task', 'title': SECTION_TITLES['task'], 'text': body, 'items': []}


def build_failures(items):
    text = ('本节区分两类事实：[执行错误] 宿主进程或工具异常；'
            '[任务检查失败] 独立验收未通过（与进程退出码无关）。'
            '下方失败事实索引由平台自动生成，编辑反馈文本不能删除这些条目，每条均可经证据ID追溯。')
    return {'key': 'failures', 'title': SECTION_TITLES['failures'], 'text': text, 'items': items}


def build_rca(diag, trunc, redaction):
    if not diag:
        return {'key': 'rca', 'title': SECTION_TITLES['rca'], 'status': 'no_diagnosis',
                'text': ('本轮未选择诊断报告，没有可引用的 RCA 候选原因。'
                         '以下反馈仅基于上一轮真实失败事实构建；候选原因需在下一轮执行中先排查、再验证，不得视为结论。'),
                'items': []}
    summary, m1 = clip(diag.get('summary'), 1800, trunc, 'rca', 'summary')
    redaction['matches'] += m1
    lines = ['【待验证假设 · 未经复验 · 不构成确定结论】', summary]
    if diag.get('boundary'):
        boundary, m2 = clip(diag.get('boundary'), 600, trunc, 'rca', 'boundary')
        redaction['matches'] += m2
        lines.append('适用边界：' + boundary)
    if diag.get('model_confidence_uncalibrated') is not None:
        lines.append('模型置信度（未校准，不能当作概率）：' + str(diag.get('model_confidence_uncalibrated')))
    lines.append('诊断来源：' + str(diag.get('origin') or '未知') + ' / ' + str(diag.get('format') or diag.get('source_algorithm') or '未知'))
    findings = []
    for finding in diag.get('findings', []) or []:
        description, m3 = clip(finding.get('description'), 1800, trunc, 'rca', 'findings_description')
        redaction['matches'] += m3
        findings.append({'title': str(finding.get('title') or ''),
                         'severity': finding.get('severity'), 'description': description,
                         'origin': diag.get('origin'), 'kind': report_kind(diag)})
    return {'key': 'rca', 'title': SECTION_TITLES['rca'], 'status': 'hypothesis',
            'text': '\n'.join(lines), 'items': findings}


def build_evidence(db, run_id, failure_items, diag, redaction, unresolved, data_quality):
    refs = []
    for item in failure_items:
        if item.get('evidence_id'):
            refs.append({'evidence_id': item['evidence_id'], 'event_id': item.get('event_id'),
                         'label': item['title'], 'from_section': 'failures',
                         'resolution_status': item.get('resolution_status')})
    if diag:
        if diag.get('raw_evidence_id'):
            refs.append({'evidence_id': diag['raw_evidence_id'], 'event_id': None,
                         'label': '诊断报告原件', 'from_section': 'rca',
                         'resolution_status': None})
        for finding in diag.get('findings', []) or []:
            for ev in finding.get('evidence', []) or []:
                refs.append({'evidence_id': ev.get('evidence_id'), 'event_id': ev.get('event_id'),
                             'label': ev.get('label'), 'from_section': 'rca',
                             'resolution_status': ev.get('resolution_status')})
    items = []
    seen = set()
    for ref in refs:
        eid = ref.get('evidence_id')
        if not eid or eid in seen:
            continue
        seen.add(eid)
        row = db.execute('SELECT 1 FROM evidence WHERE id=? AND run_id=?', (eid, run_id)).fetchone()
        status = 'unresolved' if (not row or ref.get('resolution_status') == 'unresolved') else 'resolved'
        label, matches = redact(ref.get('label'))
        redaction['matches'] += matches
        entry = {'evidence_id': eid, 'event_id': ref.get('event_id'), 'label': label,
                 'from_section': ref.get('from_section'), 'resolution_status': status}
        items.append(entry)
        if status == 'unresolved':
            unresolved.append({'section': 'evidence', 'label': label,
                               'event_id': ref.get('event_id'), 'resolution_status': 'unresolved'})
    text = ('以下引用均可在平台经证据ID回查原始事件、输入输出或检查记录；'
            '标注 unresolved 的引用无法追溯到原件，仅供线索，不得当作已证实证据。')
    if 'capture_incomplete' in data_quality:
        text += '注意：上一轮采集不完整（capture_integrity 为 pending/partial），部分证据可能缺失。'
    return {'key': 'evidence', 'title': SECTION_TITLES['evidence'], 'text': text, 'items': items}


def build_guidance(diag, trunc, redaction):
    if diag and diag.get('guidance'):
        advice, matches = clip(diag.get('guidance'), 3000, trunc, 'guidance', 'diagnosis_guidance')
        redaction['matches'] += matches
        text = '以下为诊断侧建议（尚未执行，不代表已完成修改）：\n' + advice
        status = 'from_diagnosis'
    else:
        text = '诊断未提供具体修复指导。'
        status = 'placeholder'
    text += ('\n\n建议顺序：先复查第②节失败检查的实际输入/输出与断言差异；'
             '在最小范围内修改；保留与失败无关的既有行为，避免无关改动。')
    return {'key': 'guidance', 'title': SECTION_TITLES['guidance'], 'status': status,
            'text': text, 'items': []}


def build_verification(db, run_id, diag, trunc, redaction):
    items = []
    for row in db.execute('SELECT payload FROM outcomes WHERE run_id=?', (run_id,)).fetchall():
        outcome = payload(row)
        basis, m1 = clip(outcome.get('basis'), 500, trunc, 'verification', 'rerun_basis')
        source, m2 = redact(outcome.get('source'))
        redaction['matches'] += m1 + m2
        items.append({'kind': 'rerun_original', 'source': source, 'basis': basis,
                     'evidence_id': outcome.get('evidence_id')})
    directed = None
    if diag and diag.get('verification_suggestion'):
        directed, matches = clip(diag.get('verification_suggestion'), 1500, trunc,
                                 'verification', 'directed_check')
        redaction['matches'] += matches
    if items:
        text = '必须重跑下方"原检查复验清单"中的每一项，由原测试/validator/检查程序实际执行并上报。'
    else:
        text = '未记录到独立检查条目；至少需复跑触发本次失败判定的原检查程序并实际上报结果。'
    text += '\n定向检查：' + (directed if directed else '诊断未提供。')
    text += ('\n\nRCA 文字不替代检查结果；所有检查必须实际执行并上报，'
             '通过/失败/未知以新的验收记录为准。')
    return {'key': 'verification', 'title': SECTION_TITLES['verification'],
            'text': text, 'items': items}


def _short(value):
    return str(value)[:8] if value else '-'


def render_index(key, items, compact=False):
    """Auto-generated, non-editable factual indexes; editing section text cannot remove them."""
    if not items:
        return ''
    lines = []
    if key == 'failures':
        lines.append('失败事实索引（自动生成，不可通过编辑删除）：')
        for item in items:
            if item['type'] == 'check_failure':
                if compact:
                    lines.append(f"- [任务检查失败] source={item.get('source')} · evidence={_short(item.get('evidence_id'))}")
                else:
                    lines.append(f"- [任务检查失败] {item['title']} · source={item.get('source')} · "
                                 f"basis={item.get('basis')} · evidence={_short(item.get('evidence_id'))}")
            elif item['type'] == 'tool_failure':
                lines.append(f"- [执行错误/工具] {item['title']}@{item.get('position')} · "
                             f"event={_short(item.get('event_id'))} · evidence={_short(item.get('evidence_id'))}")
            else:
                lines.append(f"- [执行错误] {item['title']} · exit_code={item.get('exit_code')} · "
                             f"source_final_status={item.get('source_final_status')}")
    elif key == 'evidence':
        lines.append('证据索引（自动生成）：')
        for item in items:
            lines.append(f"- [{item['resolution_status']}] {item['label']} · "
                         f"evidence={_short(item.get('evidence_id'))} · event={_short(item.get('event_id'))}")
    elif key == 'verification':
        lines.append('原检查复验清单（自动生成）：')
        for item in items:
            if item.get('kind') == 'rerun_original':
                if compact:
                    lines.append(f"- [重跑原检查] source={item.get('source')} · evidence={_short(item.get('evidence_id'))}")
                else:
                    lines.append(f"- [重跑原检查] source={item.get('source')} · basis={item.get('basis')} · "
                                 f"evidence={_short(item.get('evidence_id'))}")
    return '\n'.join(lines) if len(lines) > 1 else ''


def render(sections, compact=False):
    blocks = []
    for key in SECTION_KEYS:
        section = sections[key]
        block = section['title'] + '\n' + section['text'].strip()
        index = render_index(key, section.get('items') or [], compact=compact)
        if index:
            block += '\n\n' + index
        blocks.append(block)
    return '\n\n'.join(blocks)


def finalize_rendering(sections, trunc):
    rendered = render(sections)
    if len(rendered.encode('utf-8')) <= MAX_FEEDBACK_BYTES:
        return rendered
    for key, limit in SHRINK_ORDER:
        sections[key]['text'] = shrink(sections[key]['text'], limit, trunc, key, 'section_text')
        rendered = render(sections)
        if len(rendered.encode('utf-8')) <= MAX_FEEDBACK_BYTES:
            break
    if len(rendered.encode('utf-8')) > MAX_FEEDBACK_BYTES:
        # Last resort: compact index rows keep every id/type but drop long inline text.
        rendered = render(sections, compact=True)
        trunc['omissions'].append({'kind': 'index_compacted',
                                   'reason': 'total_budget_inline_text_hidden',
                                   'note': '结构化条目完整保留，可经 API 查看完整字段'})
    return rendered


def canonical(record, sections, rendered):
    return {'schema_version': SCHEMA,
            'feedback_id': record['feedback_id'],
            'from_run_id': record['from_run_id'],
            'task_id': record['task_id'],
            'goal_hash': record['goal_hash'],
            'source_diagnosis_id': record['source_diagnosis_id'],
            'iteration_source': 'platform_rca',
            'sections': sections,
            'rendered_text': rendered}


def load_diagnosis(db, run_id, diagnosis_id):
    if not diagnosis_id:
        return None
    row = db.execute('SELECT payload FROM diagnoses WHERE id=?', (diagnosis_id,)).fetchone()
    if not row:
        raise HTTPException(404, '诊断不存在')
    report = payload(row)
    if report.get('run_id') != run_id:
        raise HTTPException(422, '诊断不属于该执行')
    return report


def assemble(db, run_id, diagnosis_id):
    row = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
    if not row:
        raise HTTPException(404, '执行不存在')
    run = payload(row)
    if run['execution_status'] in ('running', 'unknown'):
        raise HTTPException(409, '执行尚未确认结束，不能生成反馈')
    task = db.execute('SELECT goal FROM tasks WHERE id=?', (run['task_id'],)).fetchone()
    goal = task['goal'] if task else ''

    trunc = {'applied': False, 'policy': 'failure_first', 'max_rendered_bytes': MAX_FEEDBACK_BYTES,
             'items': [], 'omissions': []}
    redaction = {'applied': False, 'matches': 0,
                 'rules': ['bearer', 'sk_token', 'secret_field']}
    unresolved = []
    data_quality = []
    if run.get('origin') == 'live' and run.get('capture_integrity') in ('pending', 'partial'):
        data_quality.append('capture_incomplete')

    failure_items = gather_failures(db, run, trunc, redaction)
    if not failure_items:
        raise HTTPException(422, '没有可用于反馈的失败事实：执行异常、失败工具事件与失败任务检查均不存在')
    diag = load_diagnosis(db, run_id, diagnosis_id)

    sections = {
        'task': build_task(goal, redaction),
        'failures': build_failures(failure_items),
        'rca': build_rca(diag, trunc, redaction),
        'evidence': None,
        'guidance': build_guidance(diag, trunc, redaction),
        'verification': build_verification(db, run_id, diag, trunc, redaction),
    }
    sections['evidence'] = build_evidence(db, run_id, failure_items, diag, redaction,
                                          unresolved, data_quality)
    rendered = finalize_rendering(sections, trunc)
    trunc['applied'] = bool(trunc['items'] or trunc['omissions'])
    redaction['applied'] = redaction['matches'] > 0

    fid = uid()
    record = {'schema_version': SCHEMA, 'feedback_id': fid, 'from_run_id': run_id,
              'to_run_id': None, 'task_id': run['task_id'],
              'source_diagnosis_id': diagnosis_id, 'iteration_source': 'platform_rca',
              'state': 'draft', 'goal_hash': digest(goal),
              'from_run_snapshot_hash': run.get('snapshot_hash'),
              'sections': sections, 'rendered_text': rendered,
              'content_sha256': None,
              'truncation': trunc, 'redaction': redaction,
              'data_quality': data_quality, 'unresolved_refs': unresolved,
              'content_ref': None, 'delivery': None,
              'created_at': None, 'updated_at': None,
              'confirmed_at': None, 'cancelled_at': None, 'cancel_reason': None}
    record['content_sha256'] = digest(dumps(canonical(record, sections, rendered)))
    return record


def save(db, record):
    db.execute('UPDATE feedback_records SET state=?,updated_at=?,payload=? WHERE id=?',
               (record['state'], record['updated_at'], dumps(record), record['feedback_id']))


def router(store):
    api = APIRouter()

    def get_record(db, feedback_id):
        row = db.execute('SELECT payload FROM feedback_records WHERE id=?', (feedback_id,)).fetchone()
        if not row:
            raise HTTPException(404, '反馈记录不存在')
        return payload(row)

    def rerender(record, trunc):
        redaction = record['redaction']
        rendered = finalize_rendering(record['sections'], trunc)
        record['truncation'] = trunc
        trunc['applied'] = bool(trunc['items'] or trunc['omissions'])
        record['rendered_text'] = rendered
        record['content_sha256'] = digest(dumps(canonical(record, record['sections'], rendered)))
        redaction['applied'] = redaction['matches'] > 0

    @api.post('/api/runs/{run_id}/feedback/drafts')
    def create_draft(run_id: str, spec: DraftRequest):
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute(
                'SELECT payload FROM feedback_records WHERE from_run_id=? AND request_id=?',
                (run_id, spec.request_id)).fetchone()
            if existing:
                return payload(existing)
            record = assemble(db, run_id, spec.source_diagnosis_id)
            now = utcnow()
            record['created_at'] = now
            record['updated_at'] = now
            db.execute('INSERT INTO feedback_records VALUES (?,?,?,?,?,?,?)',
                       (record['feedback_id'], run_id, spec.request_id, 'draft',
                        now, now, dumps(record)))
            return record

    @api.get('/api/feedback/{feedback_id}')
    def get_feedback(feedback_id: str):
        with store.connect() as db:
            return get_record(db, feedback_id)

    @api.get('/api/runs/{run_id}/feedback')
    def list_feedback(run_id: str,
                      state: Literal['draft', 'confirmed', 'cancelled'] | None = None,
                      limit: int = Query(default=50, ge=1, le=100)):
        with store.connect() as db:
            if not db.execute('SELECT 1 FROM runs WHERE id=?', (run_id,)).fetchone():
                raise HTTPException(404, '执行不存在')
            if state:
                rows = db.execute(
                    'SELECT payload FROM feedback_records WHERE from_run_id=? AND state=? '
                    'ORDER BY created_at DESC,rowid DESC LIMIT ?', (run_id, state, limit)).fetchall()
                total = db.execute(
                    'SELECT count(*) FROM feedback_records WHERE from_run_id=? AND state=?',
                    (run_id, state)).fetchone()[0]
            else:
                rows = db.execute(
                    'SELECT payload FROM feedback_records WHERE from_run_id=? '
                    'ORDER BY created_at DESC,rowid DESC LIMIT ?', (run_id, limit)).fetchall()
                total = db.execute(
                    'SELECT count(*) FROM feedback_records WHERE from_run_id=?',
                    (run_id,)).fetchone()[0]
            return {'items': [payload(r) for r in rows], 'total': total}

    @api.patch('/api/feedback/{feedback_id}')
    def edit_feedback(feedback_id: str, spec: EditRequest):
        keys = set(spec.sections)
        unknown = keys - set(SECTION_KEYS)
        if unknown:
            raise HTTPException(422, '未知反馈段落：' + ','.join(sorted(unknown)))
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            record = get_record(db, feedback_id)
            if record['state'] != 'draft':
                raise HTTPException(409, '反馈已确认或已取消，不能修改')
            trunc = record['truncation']
            for key, edit in spec.sections.items():
                text, matches = redact(edit.text)
                record['redaction']['matches'] += matches
                record['sections'][key]['text'] = text
            rerender(record, trunc)
            if len(record['rendered_text'].encode('utf-8')) > MAX_FEEDBACK_BYTES:
                raise HTTPException(422, '反馈总长超过 %d 字节上限，请精简文字；失败事实索引不受影响' % MAX_FEEDBACK_BYTES)
            record['updated_at'] = utcnow()
            save(db, record)
            return record

    @api.post('/api/feedback/{feedback_id}/confirm')
    def confirm_feedback(feedback_id: str, spec: ConfirmRequest):
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            record = get_record(db, feedback_id)
            if record['state'] == 'confirmed':
                if spec.content_sha256 == record['content_sha256']:
                    return record
                raise HTTPException(409, '反馈已确认，不能重复确认不同内容')
            if record['state'] == 'cancelled':
                raise HTTPException(409, '反馈已取消')
            if spec.content_sha256 != record['content_sha256']:
                raise HTTPException(409, '反馈预览已变化，请刷新后重新确认')
            encoded = dumps(canonical(record, record['sections'], record['rendered_text']))
            if digest(encoded) != record['content_sha256']:
                raise HTTPException(409, '反馈预览已变化，请刷新后重新确认')
            fid = record['feedback_id']
            run_id = record['from_run_id']
            artifact_id = uid()
            evidence_id = uid()
            filename = 'feedback-' + fid + '.json'
            db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',
                       (artifact_id, run_id, filename, 'feedback_content', digest(encoded), encoded))
            ref = {'evidence_id': evidence_id, 'run_id': run_id, 'artifact_id': artifact_id,
                   'filename': filename, 'line': None, 'json_pointer': '', 'event_id': None,
                   'resolution_status': 'resolved', 'original_reference': None}
            db.execute('INSERT INTO evidence VALUES (?,?,?,?)',
                       (evidence_id, run_id, artifact_id, dumps(ref)))
            now = utcnow()
            record['state'] = 'confirmed'
            record['confirmed_at'] = now
            record['updated_at'] = now
            record['content_ref'] = {'artifact_id': artifact_id, 'evidence_id': evidence_id,
                                     'filename': filename, 'kind': 'feedback_content',
                                     'sha256': record['content_sha256']}
            save(db, record)
            db.execute('INSERT INTO live_changes(run_id,kind) VALUES (?,?)', (run_id, 'feedback'))
            return record

    @api.post('/api/feedback/{feedback_id}/cancel')
    def cancel_feedback(feedback_id: str, spec: CancelRequest | None = None):
        reason = (spec.reason if spec else '').strip()
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            record = get_record(db, feedback_id)
            if record['state'] == 'cancelled':
                return record
            # P1 has no injection path: a confirmed record cannot have been consumed,
            # so its pinned artifact is still safe to remove. P2 must tighten this.
            if record['state'] == 'confirmed' and record.get('content_ref'):
                ref = record['content_ref']
                db.execute('DELETE FROM evidence WHERE id=?', (ref['evidence_id'],))
                db.execute('DELETE FROM artifacts WHERE id=?', (ref['artifact_id'],))
                record['content_ref'] = None
            text, matches = redact(reason)
            record['redaction']['matches'] += matches
            now = utcnow()
            record['state'] = 'cancelled'
            record['cancelled_at'] = now
            record['updated_at'] = now
            record['cancel_reason'] = text or None
            save(db, record)
            return record

    return api
