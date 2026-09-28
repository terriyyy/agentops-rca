"""Read-only Run projections for the V0.4 workbench.

These views summarize persisted facts. They do not infer a root cause or change
execution, outcome, diagnosis, or capture records.
"""

from .live import live_view
from .storage import payload


FAILED_JOB_STATES = {'failed', 'timed_out', 'interrupted'}
ACTIVE_JOB_STATES = {'queued', 'running'}


def _report_kind(report):
    if report.get('origin') == 'imported':
        return 'historical'
    if report.get('mode') == 'analyst_rca' or report.get('format') == 'agenttether-analyst':
        return 'hypothesis'
    if report.get('format') == 'agenttether-hgt' or report.get('origin') == 'recomputed':
        return 'localization'
    return 'historical'


def run_insight(db, run):
    run_id = run['run_id']
    reports = [payload(row) for row in db.execute(
        'SELECT * FROM diagnoses WHERE run_id=? ORDER BY rowid DESC', (run_id,)
    )]
    job_row = db.execute(
        'SELECT * FROM diagnosis_jobs WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        (run_id,),
    ).fetchone()
    job = payload(job_row) if job_row else None
    kinds = {_report_kind(report) for report in reports}
    featured = next((report for report in reports if _report_kind(report) == 'hypothesis'), None)
    if featured is None:
        featured = next((report for report in reports if _report_kind(report) == 'localization'), None)
    if featured is None and reports:
        featured = reports[0]
    if job and job['state'] in ACTIVE_JOB_STATES:
        diagnosis_state = 'running'
    elif 'hypothesis' in kinds:
        diagnosis_state = 'hypothesis'
    elif 'localization' in kinds:
        diagnosis_state = 'localization'
    elif 'historical' in kinds:
        diagnosis_state = 'historical'
    elif job and job['state'] in FAILED_JOB_STATES:
        diagnosis_state = 'failed'
    else:
        diagnosis_state = 'none'
    diagnosis = {
        'state': diagnosis_state,
        'report_count': len(reports),
        'report_kinds': sorted(kinds),
        'featured_report': ({
            'diagnosis_id': featured['diagnosis_id'],
            'kind': _report_kind(featured),
            'summary': str(featured.get('summary') or '')[:350],
            'origin': featured.get('origin'),
        } if featured else None),
        'latest_job': ({
            'job_id': job['job_id'], 'mode': job.get('mode', 'offline_hgt'),
            'state': job['state'], 'error': job.get('error'),
        } if job else None),
    }

    signals = []
    if run['execution_status'] == 'failed':
        signals.append({'kind': 'execution', 'title': '执行异常结束', 'event_id': None,
                        'evidence_id': None})
    for row in db.execute('''
        SELECT * FROM events WHERE run_id=? AND
          (json_extract(payload,'$.tool_status')='failed' OR
           (json_extract(payload,'$.error_signature') IS NOT NULL AND
            json_extract(payload,'$.error_signature')!=''))
        ORDER BY position LIMIT 3
    ''', (run_id,)):
        event = payload(row)
        signals.append({'kind': 'event', 'title': event.get('name') or '失败步骤',
                        'event_id': event['event_id'], 'evidence_id': event.get('evidence_id'),
                        'event_kind': event.get('kind'),
                        'error_signature': event.get('error_signature')})
    if run['outcome_status'] == 'failed':
        outcomes = [payload(row) for row in db.execute(
            'SELECT * FROM outcomes WHERE run_id=?', (run_id,)
        )]
        outcome = next((item for item in outcomes if item.get('status') == 'failed'), None)
        signals.append({'kind': 'outcome', 'title': '独立任务验收未通过',
                        'event_id': None, 'evidence_id': outcome.get('evidence_id') if outcome else None})

    attention = []
    if run['execution_status'] == 'failed':
        attention.append('execution_failed')
    if run['outcome_status'] == 'failed':
        attention.append('task_failed')
    if run.get('origin') == 'live' and run['execution_status'] != 'running' and run.get('capture_integrity') in ('pending', 'partial'):
        attention.append('capture_incomplete')
    if job and job['state'] in FAILED_JOB_STATES:
        attention.append('diagnosis_job_failed')

    return {'diagnosis': diagnosis, 'failure_signals': signals,
            'attention_reasons': attention}


def projected_run(db, row, task=None):
    run = live_view(db, payload(row))
    if task is None:
        task = db.execute('SELECT * FROM tasks WHERE id=?', (run['task_id'],)).fetchone()
    return {**run, 'task_goal': task['goal'], 'task_external_id': task['external_id'],
            'insight': run_insight(db, run)}


def overview(db, limit=20):
    # Query each bucket independently so an old, still-running Run is not
    # displaced by a large number of newer completed Runs.
    active_rows = db.execute('''
        SELECT * FROM runs WHERE json_extract(payload,'$.execution_status')='running'
        ORDER BY rowid DESC LIMIT ?
    ''', (limit,)).fetchall()
    attention_rows = db.execute('''
        SELECT * FROM runs AS r WHERE
          json_extract(r.payload,'$.execution_status')='failed' OR
          json_extract(r.payload,'$.outcome_status')='failed' OR
          (json_extract(r.payload,'$.origin')='live' AND
           json_extract(r.payload,'$.execution_status')!='running' AND
           json_extract(r.payload,'$.capture_integrity') IN ('pending','partial')) OR
          EXISTS (SELECT 1 FROM diagnosis_jobs AS j WHERE j.run_id=r.id AND
            j.id=(SELECT j2.id FROM diagnosis_jobs AS j2 WHERE j2.run_id=r.id
                  ORDER BY j2.created_at DESC,j2.rowid DESC LIMIT 1) AND
            j.state IN ('failed','timed_out','interrupted'))
        ORDER BY r.rowid DESC LIMIT ?
    ''', (limit,)).fetchall()
    recent_rows = db.execute('SELECT * FROM runs ORDER BY rowid DESC LIMIT ?', (limit,)).fetchall()
    cache = {}

    def project(rows, exclude=None):
        items = []
        for row in rows:
            if exclude and row['id'] in exclude:
                continue
            if row['id'] not in cache:
                cache[row['id']] = projected_run(db, row)
            items.append(cache[row['id']])
        return items

    running = project(active_rows)
    running_ids = {run['run_id'] for run in running}
    attention = project(attention_rows, running_ids)
    occupied = running_ids | {run['run_id'] for run in attention}
    recent = project(recent_rows, occupied)
    return {'running': running, 'attention': attention, 'recent': recent}
