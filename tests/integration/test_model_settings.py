"""No real credentials/network/model inference. Every store is under tmp_path."""
import json
import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from apps.api.main import create_app
from apps.api.model_settings import ModelSettings,ConnectionRequest
from apps.api.storage import dumps,payload
from tests.integration.test_analyst import scenario


SECRET='fixture-private-key-123456'


def save(client,**changes):
    current=client.get('/api/settings/rca-model').json()
    spec={'name':'测试代理','base_url':'https://fixture.example/v1','model':'model-a',
          'api_key':SECRET,'expected_revision':current['revision']}
    return client.put('/api/settings/rca-model',json=spec|changes)


def test_two_databases_in_same_directory_do_not_share_credentials_or_local_config(tmp_path):
    with TestClient(create_app(tmp_path/'first.sqlite3')) as first,TestClient(create_app(tmp_path/'second.sqlite3')) as second:
        assert save(first).status_code==200
        assert not second.get('/api/settings/rca-model').json()['configured']
        assert first.app.state.diagnosis.models.path!=second.app.state.diagnosis.models.path
        assert first.app.state.diagnosis.config_path!=second.app.state.diagnosis.config_path
        production_directory=tmp_path/'rca-credentials'
        assert first.app.state.diagnosis.models.directory!=production_directory


def test_encrypted_persistence_no_echo_and_delete_no_env_fallback(tmp_path):
    legacy=tmp_path/'legacy.env'
    legacy.write_text('OPS_OPENAI_API_BASE_URL=https://legacy.example/v1\nOPS_OPENAI_API_KEY=legacy-fixture-key\nOPS_OPENAI_MODEL=legacy-model\n')
    app=create_app(tmp_path/'data.sqlite3',legacy_env_file=legacy)
    with TestClient(app) as client:
        value=client.get('/api/settings/rca-model');assert value.headers['cache-control']=='no-store'
        assert value.json()['connection']['source']=='environment'
        response=save(client);assert response.status_code==200,response.text
        assert SECRET not in response.text and 'legacy-fixture-key' not in response.text
        config=response.json();assert config['call_status']=='configured' and config['key_configured']
        service=app.state.diagnosis.models
        assert SECRET not in service.path.read_text()
        assert SECRET.encode() not in service.key_path.read_bytes()
        assert service.read()['api_key']==SECRET
        if os.name!='nt':assert service.path.stat().st_mode & 0o777==0o600
        # Restart reads persisted config without changing the revision.
        with TestClient(create_app(tmp_path/'data.sqlite3',legacy_env_file=legacy)) as other:
            assert other.get('/api/settings/rca-model').json()['revision']==config['revision']
        assert save(client,api_key='',model='model-b').status_code==200
        assert service.read()['api_key']==SECRET
        wrong=save(client,api_key='',base_url='https://different.example/v1')
        assert wrong.status_code==422 and SECRET not in wrong.text
        revision=client.get('/api/settings/rca-model').json()['revision']
        deleted=client.request('DELETE','/api/settings/rca-model',json={'expected_revision':revision})
        assert deleted.status_code==200 and not deleted.json()['configured']
        assert legacy.exists() and not service.key_path.exists()
    with TestClient(create_app(tmp_path/'data.sqlite3',legacy_env_file=legacy)) as client:
        assert not client.get('/api/settings/rca-model').json()['configured']
        assert save(client,api_key='').status_code==422


@pytest.mark.parametrize('url',['http://remote.example/v1','https://user:secret@example.com/v1',
                              'https://example.com/v1?api_key=secret','https://example.com/v1#key',
                              'https://example.com/v1/chat/completions','https://example.com:invalid/v1'])
def test_endpoint_validation_never_reflects_credentials(tmp_path,url):
    with TestClient(create_app(tmp_path/'data.sqlite3')) as client:
        response=save(client,base_url=url)
        assert response.status_code==422 and SECRET not in response.text and url not in response.text
        assert not client.get('/api/settings/rca-model').json()['configured']


def test_stale_edits_foreign_origins_and_corrupt_store(tmp_path):
    with TestClient(create_app(tmp_path/'data.sqlite3')) as client:
        first=save(client).json()
        assert save(client,expected_revision=None).status_code==409
        for method in ('PUT','DELETE'):
            response=client.request(method,'/api/settings/rca-model',headers={'Origin':'https://foreign.example'},json={})
            assert response.status_code==403
        assert save(client,base_url='http://127.0.0.1:11434/v1',api_key=SECRET).status_code==200
        service=client.app.state.diagnosis.models
        service.key_path.write_bytes(b'corrupt-key')
        unavailable=client.get('/api/settings/rca-model')
        assert unavailable.status_code==503 and SECRET not in unavailable.text
        # Explicit deletion enables recovery without falling back to any environment.
        assert client.request('DELETE','/api/settings/rca-model',json={'expected_revision':None}).status_code==200
        assert save(client).status_code==200
        assert service.public()['revision']!=first['revision']


@pytest.mark.parametrize('change',[{'model':'new-model'}, {'name':'new-connection'},
                                  {'base_url':'https://other.example/v1','api_key':'other-fixture-key'},
                                  {'api_key':'rotated-fixture-key'},{'token_parameter':'max_completion_tokens'}])
def test_changed_connection_invalidates_existing_preview(scenario,change):
    client,manager,rid,_,_=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview').json()
    current=manager.models.read()
    update={k:current[k] for k in ('name','base_url','model','token_parameter')}
    update.update(api_key='',expected_revision=current['revision']);update.update(change)
    assert client.put('/api/settings/rca-model',json=update).status_code==200
    new=client.get('/api/runs/'+rid+'/analyst-preview').json()
    assert new['preview_sha256']!=preview['preview_sha256']
    response=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':preview['preview_sha256'],'hgt_diagnosis_id':preview['hgt_diagnosis_id']})
    assert response.status_code==409
    assert client.get('/api/runs/'+rid+'/diagnosis-jobs').json()==[]


def test_deleted_connection_prevents_preview_and_submit(scenario):
    client,manager,rid,_,_=scenario
    preview=client.get('/api/runs/'+rid+'/analyst-preview').json()
    assert client.request('DELETE','/api/settings/rca-model',json={'expected_revision':manager.models.public()['revision']}).status_code==200
    assert client.get('/api/runs/'+rid+'/analyst-preview').status_code==409
    response=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':preview['preview_sha256'],'hgt_diagnosis_id':preview['hgt_diagnosis_id']})
    assert response.status_code==409


def test_capability_history_only_applies_to_same_connection_revision(tmp_path):
    with TestClient(create_app(tmp_path/'data.sqlite3')) as client:
        saved=save(client).json();manager=client.app.state.diagnosis
        # No algorithm configured still exposes model configuration honestly.
        assert manager.capabilities()['hgt']=='unavailable'
        assert manager.capabilities()['analyst']=='configured'
        from tests.integration.test_live import create
        run,_,_=create(client)
        with manager.store.connect() as db:
            jid=uuid4().hex
            job={'job_id':jid,'mode':'analyst_rca','state':'succeeded','config_revision':saved['revision']}
            db.execute('INSERT INTO diagnosis_jobs VALUES (?,?,?,?,?,?)',(jid,run['run_id'],uuid4().hex,'succeeded','2026-10-05',dumps(job)))
        assert manager.capabilities()['analyst']=='last_call_succeeded'
        save(client,model='model-b',api_key='')
        assert manager.capabilities()['analyst']=='configured'
        assert SECRET not in json.dumps(manager.capabilities())


@pytest.mark.parametrize('secret',['dummy-key','密钥-fixture-123456'])
def test_exact_connection_key_redacted_from_preview_and_prompt_artifact(scenario,secret):
    client,manager,rid,_,_=scenario
    assert save(client,api_key=secret).status_code==200
    with manager.store.connect() as db:
        row=db.execute("SELECT * FROM artifacts WHERE filename='hgt-fixture.json'").fetchone()
        raw=json.loads(row['content']);raw['selected_units'][0]['feedback']='echo '+secret
        from apps.api.importer import digest
        encoded=dumps(raw);db.execute('UPDATE artifacts SET content=?,sha256=? WHERE id=?',(encoded,digest(encoded),row['id']))
    preview=client.get('/api/runs/'+rid+'/analyst-preview');assert preview.status_code==200,preview.text
    assert secret not in preview.text and '[REDACTED]' in preview.text
    value=preview.json()
    response=client.post('/api/runs/'+rid+'/analyst-jobs',json={'request_id':uuid4().hex,'preview_sha256':value['preview_sha256'],'hgt_diagnosis_id':value['hgt_diagnosis_id']})
    assert response.status_code==200 and secret not in response.text
    job=response.json()
    assert secret not in client.get('/api/evidence/'+job['prompt_evidence_id']).text


@pytest.mark.parametrize('record',[[],None,{'schema_version':1,'revision':123,'enabled':True},
                                 {'schema_version':1,'revision':'fixture','enabled':'true'},
                                 {'schema_version':1,'revision':'fixture','enabled':True,'encrypted_key':None}])
def test_malformed_credential_records_fail_closed_and_can_be_removed(tmp_path,record):
    with TestClient(create_app(tmp_path/'data.sqlite3')) as client:
        service=client.app.state.diagnosis.models
        service._atomic(service.path,json.dumps(record).encode())
        assert client.get('/api/settings/rca-model').status_code==503
        assert client.request('DELETE','/api/settings/rca-model',json={'expected_revision':None}).status_code==200
        assert not service.public()['configured']
