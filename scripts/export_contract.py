"""Export the runtime-validated import manifest contract to JSON Schema."""
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from apps.api.contracts import ImportManifest
from apps.api.live_contracts import CreateRun, Batch, Finish

target=ROOT/'packages/contracts/import-manifest.schema.json'
target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(ImportManifest.model_json_schema(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(target.relative_to(ROOT))
live_target=ROOT/'packages/contracts/live.schema.json'
live_target.write_text(json.dumps({'create':CreateRun.model_json_schema(),'batch':Batch.model_json_schema(),'finish':Finish.model_json_schema()},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(live_target.relative_to(ROOT))
