"""Import an explicitly selected local package through the same HTTP API as the UI."""
import argparse
import json
from contextlib import ExitStack
from pathlib import Path

import httpx


def upload(directory,api):
    manifest_path=directory/'manifest.json'
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    names={r[k] for r in manifest['runs'] for k in ('telemetry','report','outcome','feedback') if r.get(k)}
    with ExitStack() as stack:
        files=[('manifest',('manifest.json',stack.enter_context(manifest_path.open('rb')),'application/json'))]
        for name in sorted(names):
            path=(directory/name).resolve()
            if path.parent!=directory.resolve():raise ValueError('清单文件名不能含路径')
            files.append(('files',(name,stack.enter_context(path.open('rb')),'application/octet-stream')))
        response=httpx.post(api.rstrip('/')+'/api/imports',files=files,timeout=60,trust_env=False)
        response.raise_for_status()
        return response.json()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--api',default='http://127.0.0.1:8000')
    args=parser.parse_args()
    print(json.dumps(upload(args.directory,args.api),ensure_ascii=False,indent=2))
