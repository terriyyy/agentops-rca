"""P1 feedback contract tests: draft/edit/confirm/cancel, all model-free."""
import json
import sqlite3
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from apps.api.storage import MIGRATION, Store, dumps, payload


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'feedback.sqlite3')) as c:
        yield c


def run_with_check(client, check_status='failed', events_extra=None, goal='test'):
    """A completed run: one successful tool pair plus one verification event."""
    from tests.integration.test_live import create, event, send, finish
    run, headers, _ = create(client, goal=goal)
    items = [event(1),
             event(2, kind='tool_return', ok=True, output={'returncode': 0})]
    if check_status:
        items.append(event(3, kind='verification', name='OUTCOME_EVIDENCE',
                           input={'status': check_status, 'source': 'pytest',
                                  'basis': '10/14 checks passed'}))
    items += events_extra or []
    assert send(client, run, headers, items).status_code == 200
    assert finish(client, run, headers, producers={'test': len(items)}).status_code == 200
    return run['run_id']


def draft(client, run_id, diagnosis_id='__omit__', request_id=None):
    body = {'request_id': request_id or uuid4().hex}
    if diagnosis_id != '__omit__':
        body['source_diagnosis_id'] = diagnosis_id
    return client.post(f'/api/runs/{run_id}/feedback/drafts', json=body)


def confirm(client, record, sha=None):
    return client.post(f"/api/feedback/{record['feedback_id']}/confirm",
                       json={'content_sha256': sha or record['content_sha256']})


def cancel(client, record, reason=None):
    return client.post(f"/api/feedback/{record['feedback_id']}/cancel",
                       json={} if reason is None else {'reason': reason})


def patch_text(client, record, **sections):
    return client.patch(f"/api/feedback/{record['feedback_id']}",
                        json={'sections': {k: {'text': v} for k, v in sections.items()}})


def insert_diagnosis(client, run_id, report, diagnosis_id=None):
    did = diagnosis_id or uuid4().hex
    report = {'diagnosis_id': did, 'run_id': run_id, **report}
    with client.app.state.store.connect() as db:
        db.execute('INSERT INTO diagnoses VALUES (?,?,?)', (did, run_id, dumps(report)))
    return did


ANALYST_REPORT = {
    'origin': 'recomputed', 'format': 'agenttether-analyst', 'mode': 'analyst_rca',
    'summary': '假设减法被写成了加法的反向符号错误', 'boundary': '仅适用于同步计算路径',
    'model_confidence_uncalibrated': 0.42,
    'guidance': '把 add 实现中的减号改成加号',
    'verification_suggestion': '重跑 add(2,3)==5 的断言',
    'findings': [],
}


# 1. 验收第5条：工具全部成功、仅独立检查失败，也能生成反馈
def test_draft_from_check_failure_with_all_tools_succeeded(client):
    run_id = run_with_check(client)
    rec = draft(client, run_id).json()
    assert rec['state'] == 'draft'
    facts = rec['sections']['failures']['items']
    assert [f['type'] for f in facts] == ['check_failure']
    assert facts[0]['failure_class'] == 'verification'
    assert facts[0]['evidence_id']
    assert facts[0]['source'] == 'pytest'
    assert rec['sections']['rca']['status'] == 'no_diagnosis'
    rendered = rec['rendered_text']
    assert '10/14 checks passed' in rendered
    assert 'RCA 文字不替代检查结果' in rendered
    assert rec['to_run_id'] is None and rec['content_ref'] is None
    assert rec['iteration_source'] == 'platform_rca'


# 2. 无诊断时可确认；确认版固化为 artifact 且哈希可核验
def test_confirm_without_diagnosis_pins_artifact(client):
    run_id = run_with_check(client)
    rec = draft(client, run_id).json()
    conf = confirm(client, rec).json()
    assert conf['state'] == 'confirmed' and conf['confirmed_at']
    ref = conf['content_ref']
    assert ref['kind'] == 'feedback_content' and ref['sha256'] == conf['content_sha256']
    stored = client.get('/api/evidence/' + ref['evidence_id']).json()
    assert stored['sha256'] == conf['content_sha256']
    assert stored['content']['rendered_text'] == conf['rendered_text']


# 3. 带诊断：待验证帽、边界、resolved/unresolved 证据显式区分
def test_draft_with_diagnosis_marks_hypothesis_and_unresolved(client):
    run_id = run_with_check(client)
    with client.app.state.store.connect() as db:
        outcome = payload(db.execute(
            'SELECT payload FROM outcomes WHERE run_id=?', (run_id,)).fetchone())
    resolved_eid = outcome['evidence_id']
    report = {**ANALYST_REPORT,
              'findings': [{'title': '根因假设', 'severity': 'warn', 'description': '符号错误',
                            'evidence': [
                                {'evidence_id': resolved_eid, 'event_id': None,
                                 'resolution_status': 'resolved', 'label': '失败检查证据'},
                                {'evidence_id': 'g' + '0' * 31, 'event_id': None,
                                 'resolution_status': 'unresolved', 'label': '无法解析的模型引用'}]}]}
    did = insert_diagnosis(client, run_id, report)
    rec = draft(client, run_id, diagnosis_id=did).json()
    rca = rec['sections']['rca']
    assert rca['status'] == 'hypothesis'
    assert rca['text'].startswith('【待验证假设')
    assert '仅适用于同步计算路径' in rca['text']
    assert '0.42' in rca['text']
    statuses = {i['evidence_id']: i['resolution_status']
                for i in rec['sections']['evidence']['items']}
    assert statuses[resolved_eid] == 'resolved'
    assert 'g' + '0' * 31 in statuses and statuses['g' + '0' * 31] == 'unresolved'
    assert rec['unresolved_refs'] and rec['unresolved_refs'][0]['resolution_status'] == 'unresolved'
    assert '[unresolved]' in rec['rendered_text']
    assert '把 add 实现中的减号改成加号' in rec['sections']['guidance']['text']
    assert '重跑 add(2,3)==5 的断言' in rec['sections']['verification']['text']


# 4. 编辑后哈希变化；旧哈希 409，新哈希确认成功并可回查
def test_edit_changes_hash_then_confirm(client):
    run_id = run_with_check(client)
    rec = draft(client, run_id).json()
    old_sha = rec['content_sha256']
    edited = patch_text(client, rec, rca='人工补充：先核对运算符符号').json()
    assert edited['content_sha256'] != old_sha
    assert edited['updated_at'] >= rec['updated_at']
    assert confirm(client, rec, sha=old_sha).status_code == 409
    conf = confirm(client, edited).json()
    assert conf['state'] == 'confirmed'
    stored = client.get('/api/evidence/' + conf['content_ref']['evidence_id']).json()
    assert stored['sha256'] == conf['content_sha256']
    assert '人工补充' in stored['content']['rendered_text']


# 5. confirmed 不可改；重复确认幂等；confirmed 可取消（P1 无投递），取消后锁定
def test_confirmed_immutable_idempotent_and_cancellable(client):
    run_id = run_with_check(client)
    rec = confirm(client, draft(client, run_id).json()).json()
    fid, sha, evidence_id = rec['feedback_id'], rec['content_sha256'], rec['content_ref']['evidence_id']
    assert patch_text(client, rec, rca='x').status_code == 409
    assert client.post(f'/api/feedback/{fid}/confirm',
                       json={'content_sha256': '0' * 64}).status_code == 409
    again = confirm(client, rec).json()
    assert again['state'] == 'confirmed' and again['content_sha256'] == sha
    cancelled = cancel(client, rec).json()
    assert cancelled['state'] == 'cancelled' and cancelled['cancelled_at']
    assert cancelled['content_ref'] is None
    assert client.get('/api/evidence/' + evidence_id).status_code == 404
    assert patch_text(client, rec, rca='x').status_code == 409
    assert confirm(client, rec).status_code == 409


# 6. draft 取消幂等、取消后不可确认/编辑；列表可按状态筛选
def test_cancel_draft_idempotent_and_list_filter(client):
    run_id = run_with_check(client)
    rec = draft(client, run_id).json()
    first = cancel(client, rec, reason='误生成').json()
    assert first['state'] == 'cancelled' and first['cancel_reason'] == '误生成'
    second = cancel(client, rec).json()
    assert second['cancelled_at'] == first['cancelled_at']
    assert confirm(client, rec).status_code == 409
    assert patch_text(client, rec, rca='x').status_code == 409
    listing = client.get(f'/api/runs/{run_id}/feedback?state=cancelled').json()
    assert listing['total'] == 1 and listing['items'][0]['feedback_id'] == rec['feedback_id']


# 7. 同 request_id 幂等返回旧版；不同 request_id 生成第二份
def test_draft_idempotency_by_request_id(client):
    run_id = run_with_check(client)
    request_id = uuid4().hex
    first = draft(client, run_id, request_id=request_id).json()
    second = draft(client, run_id, request_id=request_id).json()
    assert second['feedback_id'] == first['feedback_id']
    assert second['content_sha256'] == first['content_sha256']
    third = draft(client, run_id).json()
    assert third['feedback_id'] != first['feedback_id']
    assert client.get(f'/api/runs/{run_id}/feedback').json()['total'] == 2


# 8. 密钥/认证头不进入反馈与确认存档
def test_secrets_are_redacted_from_feedback_and_artifact(client):
    from tests.integration.test_live import create, event, send, finish
    run, headers, _ = create(client)
    items = [
        event(1),
        event(2, kind='tool_return', ok=False,
              output={'returncode': 1, 'note': 'Bearer abcdefghijklmnop token here'},
              error_signature='Bearer abcdefghijklmnop'),
        event(3, kind='verification', name='OUTCOME_EVIDENCE',
              input={'status': 'failed', 'source': 'pytest', 'basis': 'x',
                     'summary': 'key sk-xxxxxxxxxxxxxxxx leaked'}),
    ]
    send(client, run, headers, items)
    finish(client, run, headers, producers={'test': 3})
    rec = draft(client, run['run_id']).json()
    body = json.dumps(rec, ensure_ascii=False)
    assert 'abcdefghijklmnop' not in body and 'sk-xxxxxxxxxxxxxxxx' not in body
    assert '[REDACTED]' in body
    assert rec['redaction']['applied'] is True
    conf = confirm(client, rec).json()
    stored = client.get('/api/evidence/' + conf['content_ref']['evidence_id']).json()
    archive = json.dumps(stored['content'], ensure_ascii=False)
    assert 'abcdefghijklmnop' not in archive and 'sk-xxxxxxxxxxxxxxxx' not in archive


# 9. 超长内容截断留痕：总账不超、失败事实/证据索引不缺、omissions 有账
def test_truncation_is_ledgered_without_losing_failure_facts(client):
    from tests.integration.test_live import create, event, send, finish
    run, headers, _ = create(client)
    items = []
    seq = 0
    for i in range(4):
        seq += 1
        items.append(event(seq, correlation_id=f'c{i}'))
        seq += 1
        items.append(event(seq, kind='tool_return', correlation_id=f'c{i}', ok=False,
                           output='X' * 2000, error_signature='E' * 400))
    seq += 1
    items.append(event(seq, kind='verification', name='OUTCOME_EVIDENCE',
                       input={'status': 'failed', 'source': 'pytest',
                              'basis': '检查未通过'}))
    send(client, run, headers, items)
    finish(client, run, headers, producers={'test': len(items)})
    report = {**ANALYST_REPORT, 'guidance': '改' * 20000}
    did = insert_diagnosis(client, run['run_id'], report)
    rec = draft(client, run['run_id'], diagnosis_id=did).json()
    rendered = rec['rendered_text']
    assert len(rendered.encode('utf-8')) <= 24000
    assert rec['truncation']['applied'] is True
    assert any(i['section'] == 'guidance' and i['reason'] == 'field_budget'
               for i in rec['truncation']['items'])
    omission = next(o for o in rec['truncation']['omissions']
                    if o['kind'] == 'tool_failure_not_listed')
    assert omission['total'] == 4 and omission['included'] == 3
    assert rendered.count('[执行错误/工具]') == 3
    assert '[任务检查失败]' in rendered
    assert '检查未通过' in rendered


# 10. 前置校验：running 409、全成功 422、诊断归属/不存在、资源 404
def test_draft_and_record_guards(client):
    from tests.integration.test_live import create
    run, _, _ = create(client)  # 不 finish：仍在 running
    assert draft(client, run['run_id']).status_code == 409

    passed_run = run_with_check(client, check_status='passed')
    assert draft(client, passed_run).status_code == 422

    target_run = run_with_check(client)
    other_run = run_with_check(client)
    did = insert_diagnosis(client, other_run, ANALYST_REPORT)
    assert draft(client, target_run, diagnosis_id=did).status_code == 422
    assert draft(client, target_run, diagnosis_id=uuid4().hex).status_code == 404
    assert client.post('/api/runs/nonexistent/feedback/drafts',
                       json={'request_id': uuid4().hex}).status_code == 404
    assert client.get('/api/feedback/' + uuid4().hex).status_code == 404


# 11. v3→v4 迁移：备份、建表、数据保留
def test_v3_to_v4_migration(tmp_path):
    path = tmp_path / 'migrate.sqlite3'
    Store(path)
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO tasks VALUES ('t','ns','ext','keep','synthetic')")
        db.execute('DROP TABLE feedback_records')
        db.execute('PRAGMA user_version=3')
    Store(path)
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 4
        assert db.execute('SELECT goal FROM tasks').fetchone()[0] == 'keep'
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_records'").fetchone()
    assert path.with_name(path.name + '.v3-backup.sqlite3').exists()


def test_fresh_v1_schema_upgrades_directly_to_v4(tmp_path):
    path = tmp_path / 'v1.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript(MIGRATION)
        assert db.execute('PRAGMA user_version').fetchone()[0] == 1
    Store(path)
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 4


# 12. 清空段文本不能删除自动生成的失败事实与证据索引
def test_editing_cannot_remove_factual_indexes(client):
    run_id = run_with_check(client)
    rec = draft(client, run_id).json()
    evidence_id = rec['sections']['failures']['items'][0]['evidence_id']
    edited = patch_text(client, rec, failures='', evidence='', rca='').json()
    rendered = edited['rendered_text']
    assert '失败事实索引' in rendered
    assert '证据索引' in rendered
    assert '[任务检查失败]' in rendered
    assert evidence_id[:8] in rendered


def structured_basis(failed=1, passed=0):
    checks = []
    for i in range(failed):
        checks.append({'name': '失败检查 %d' % i, 'type': 'database_state',
                       'basis': {'expected_value': 'expected-%d' % i},
                       'result': {'passed': False, 'expected': 'expected-%d' % i,
                                  'actual': 'actual-%d' % i, 'comparison_type': 'equals',
                                  'details': '差异说明 %d' % i}})
    for i in range(passed):
        checks.append({'name': '通过检查 %d' % i, 'type': 'database_state',
                       'basis': {'expected_value': 1},
                       'result': {'passed': True, 'expected': 1, 'actual': 1,
                                  'comparison_type': 'equals', 'details': '一致 %d' % i}})
    return {'checks': checks, 'platform_reran_checks': False}


def run_with_structured_outcome(client, basis, *, failed_tool=False, goal='test'):
    from tests.integration.test_live import create, event, send, finish
    run, headers, _ = create(client, goal=goal)
    items = [event(1), event(2, kind='tool_return', ok=True, output={'returncode': 0})]
    if failed_tool:
        items.append(event(3, name='shell', kind='tool_return', ok=False,
                           output={'stderr': 'boom'}, error_signature='AssertionError: 3 != 1'))
    n = len(items) + 1
    items.append(event(n, kind='verification', name='OUTCOME_EVIDENCE',
                       input={'status': 'failed', 'source': 'enterprise-gym',
                              'basis': basis, 'summary': 'aggregate=failed'}))
    assert send(client, run, headers, items).status_code == 200
    assert finish(client, run, headers, producers={'test': len(items)}).status_code == 200
    return run['run_id']


# 13. R4：结构化检查结果必须保留失败项的名称/expected/actual，不被顺序截断埋没
def test_structured_failed_checks_keep_expected_actual(client):
    run_id = run_with_structured_outcome(client, structured_basis(failed=2, passed=5))
    rec = draft(client, run_id).json()
    item = rec['sections']['failures']['items'][0]
    assert item['check_total'] == 7 and item['check_failed_count'] == 2
    names = [c['name'] for c in item['failed_checks']]
    assert names == ['失败检查 0', '失败检查 1']
    rendered = rec['rendered_text']
    assert '失败检查 0' in rendered and 'expected=expected-0' in rendered
    assert 'actual=actual-0' in rendered and '差异说明 0' in rendered
    # 通过检查不占失败索引篇幅
    assert '通过检查 0' not in rendered
    # 复验清单也是结构化的，含失败项与计数
    verify = rec['sections']['verification']['items'][0]
    assert verify['check_total'] == 7 and verify['failed_names'] == ['失败检查 0', '失败检查 1']
    assert '共7项(失败2)' in rendered


# 14. R5：工具错误签名/详情必须出现在“实际投递正文”
def test_tool_error_facts_render_in_body(client):
    run_id = run_with_structured_outcome(client, structured_basis(), failed_tool=True)
    rec = draft(client, run_id).json()
    assert 'AssertionError: 3 != 1' in rec['rendered_text']
    assert rec['sections']['failures']['items'][0]['error_signature'].startswith('AssertionError')


# 15. R3：finding 标题、工具名等非正文文本字段也必须脱敏
def test_titles_and_names_are_redacted_everywhere(client):
    from tests.integration.test_live import create, event, send, finish
    secret_a = 'sk-' + 'a' * 20
    secret_b = 'sk-' + 'b' * 20
    run, headers, _ = create(client)
    items = [event(1, name='leak step ' + secret_a),
             event(2, name='leak step ' + secret_a, kind='tool_return', ok=False,
                   output='bad', error_signature='AssertionError'),
             event(3, kind='verification', name='OUTCOME_EVIDENCE',
                   input={'status': 'failed', 'source': 'pytest', 'basis': 'x'})]
    send(client, run, headers, items)
    finish(client, run, headers, producers={'test': 3})
    report = {**ANALYST_REPORT,
              'findings': [{'title': '标题带凭据 api_key=' + secret_b,
                            'severity': 'warn', 'description': '描述', 'evidence': []}]}
    did = insert_diagnosis(client, run['run_id'], report)
    rec = draft(client, run['run_id'], diagnosis_id=did).json()
    body = json.dumps(rec, ensure_ascii=False)
    assert secret_a not in body and secret_b not in body
    assert rec['redaction']['applied'] is True
    conf = confirm(client, rec).json()
    archive = json.dumps(client.get('/api/evidence/' + conf['content_ref']['evidence_id']).json(),
                         ensure_ascii=False)
    assert secret_a not in archive and secret_b not in archive


# 16. R6：evidence 表自身为 ambiguous 的引用不得被提升为 resolved
def test_ambiguous_evidence_keeps_ambiguous_status(client):
    from apps.api.importer import digest
    run_id = run_with_check(client)
    with client.app.state.store.connect() as db:
        outcome = payload(db.execute(
            'SELECT payload FROM outcomes WHERE run_id=?', (run_id,)).fetchone())
        aid = 'a' + '1' * 31
        eid = 'e' + '2' * 31
        db.execute('INSERT INTO artifacts VALUES (?,?,?,?,?,?)',
                   (aid, run_id, 'ambiguous.json', 'report', digest('{}'), '{}'))
        ref = {'evidence_id': eid, 'run_id': run_id, 'artifact_id': aid,
               'filename': 'ambiguous.json', 'line': None, 'json_pointer': '',
               'event_id': None, 'resolution_status': 'ambiguous',
               'original_reference': '原始歧义引用'}
        db.execute('INSERT INTO evidence VALUES (?,?,?,?)', (eid, run_id, aid, dumps(ref)))
    report = {**ANALYST_REPORT,
              'findings': [{'title': '根因假设', 'severity': 'warn', 'description': '描述',
                            'evidence': [{'evidence_id': eid, 'event_id': None,
                                          'resolution_status': 'resolved',
                                          'label': '模型给了 resolved 但库内是 ambiguous'},
                                         {'evidence_id': outcome['evidence_id'], 'event_id': None,
                                          'resolution_status': 'resolved', 'label': '失败检查证据'}]}]}
    did = insert_diagnosis(client, run_id, report)
    rec = draft(client, run_id, diagnosis_id=did).json()
    statuses = {i['evidence_id']: i['resolution_status']
                for i in rec['sections']['evidence']['items']}
    assert statuses[eid] == 'ambiguous'
    assert statuses[outcome['evidence_id']] == 'resolved'
    assert any(u['evidence_id'] == eid and u['resolution_status'] == 'ambiguous'
               for u in rec['unresolved_refs'])
    assert '[ambiguous]' in rec['rendered_text']


def insert_failed_outcome(client, run_id, basis, source='enterprise-gym'):
    """Insert an outcome row directly (bypasses the 64 KiB per-event ingestion limit)."""
    from apps.api.importer import uid
    oid = uid()
    outcome = {'outcome_id': oid, 'run_id': run_id, 'status': 'failed', 'source': source,
               'basis': basis, 'summary': 'aggregate=failed', 'authoritative': True,
               'evidence_id': None, 'reward': None, 'verification_origin': 'evaluated',
               'observed_at': '2026-10-01T00:00:00+00:00'}
    with client.app.state.store.connect() as db:
        db.execute('INSERT INTO outcomes VALUES (?,?,?)', (oid, run_id, dumps(outcome)))


# 17. R7：即使失败检查极多，生成与确认都不得超过 24000 字节渲染预算
def test_rendered_budget_is_enforced_at_create_and_confirm(client):
    run_id = run_with_check(client)  # 小的失败验收，使 run 投影为 outcome failed
    insert_failed_outcome(client, run_id, structured_basis(failed=300))
    create_resp = draft(client, run_id)
    assert create_resp.status_code == 200, create_resp.text
    rec = create_resp.json()
    assert len(rec['rendered_text'].encode('utf-8')) <= 24000
    # 结构化字段不丢：300 项失败检查全部保留在 sections
    big = next(i for i in rec['sections']['failures']['items']
               if i.get('check_total') == 300)
    assert len(big['failed_checks']) == 300
    omission = next(o for o in rec['truncation']['omissions']
                    if o['kind'] == 'failed_checks_not_rendered')
    assert omission['total'] == 300 - 20 - 40
    # 编辑阶段超量被明确拒绝（草稿态，422，不会静默压缩）
    too_long = patch_text(client, rec, rca='字' * 8000)
    assert too_long.status_code == 422
    # 草稿内容未被失败的编辑破坏，确认仍成功
    assert confirm(client, rec).status_code == 200
