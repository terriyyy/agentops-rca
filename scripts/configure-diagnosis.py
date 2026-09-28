"""Register trusted local source/weights, then verify in the isolated worker."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from apps.api.diagnosis_worker import sha,source_hash
from apps.api.importer import digest
from apps.api.storage import dumps


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--python',required=True)
    parser.add_argument('--source',required=True)
    parser.add_argument('--bundle',required=True)
    parser.add_argument('--expected-weight-sha256',required=True,help='Trusted weight digest obtained independently')
    args=parser.parse_args()
    source=Path(args.source).resolve();bundle=Path(args.bundle).resolve()
    if not (source/'agent_tether/model/bundle.py').is_file():raise SystemExit('Invalid AgentTether source directory')
    weight_hash=sha(bundle/'hgt_normal_model.pt')
    if weight_hash!=args.expected_weight_sha256:raise SystemExit('Weight checksum mismatch; no model was loaded')
    config={'python':str(Path(args.python).resolve()),'source':str(source),'bundle':str(bundle),
            'source_sha256':source_hash(source),'weight_sha256':weight_hash,'manifest_sha256':sha(bundle/'manifest.json')}
    local=ROOT/'.local';local.mkdir(exist_ok=True)
    pending=local/'diagnosis-probe-config.json';output=local/'diagnosis-probe-result.json'
    pending.write_text(dumps(config),encoding='utf-8')
    env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','TEMP','TMP','PATH','COMSPEC','USERPROFILE')}
    env.update(PYTHONIOENCODING='utf-8',PYTHONDONTWRITEBYTECODE='1')
    completed=subprocess.run([config['python'],str(ROOT/'apps/api/diagnosis_worker.py'),'--config',str(pending),'--output',str(output)],env=env,timeout=120)
    if completed.returncode:raise SystemExit('Probe failed; existing configuration was not replaced')
    result=json.loads(output.read_text(encoding='utf-8'))
    result['config_hash']=digest(dumps(config));config['probe']=result
    pending.write_text(dumps(config),encoding='utf-8');pending.replace(local/'diagnosis-config.json')
    print('HGT ready; analyst disabled. Configuration saved under ignored .local/.')


if __name__=='__main__':main()
