"""Deterministic tool-agent fixture: real file/test operations, NO model inference.

Always launch with --sample-kind synthetic. This is not evidence of LLM quality.
"""
import argparse
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agentops_cli import tool, verification


@tool
def write_solution(directory,fail,delay=0.3):
    time.sleep(delay)
    path=Path(directory)/'solution.py'
    path.write_text('def add(a, b):\n    return a '+('-' if fail else '+')+' b\n',encoding='utf-8')
    return {'file':'solution.py','bytes':path.stat().st_size}


@tool
def run_tests(directory):
    time.sleep(0.3)
    return subprocess.run([sys.executable,'-c','from solution import add; assert add(2, 3) == 5, "addition failed"; print("1 test passed")'],cwd=directory,capture_output=True,text=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--fail',action='store_true');parser.add_argument('--delay',type=float,default=1);parser.add_argument('--tool-delay',type=float,default=0.3)
    args=parser.parse_args()
    print('确定性工具 Agent 夹具：真实文件与测试操作，不调用模型。',flush=True)
    with tempfile.TemporaryDirectory(prefix='agentops-example-') as directory:
        write_solution(directory,args.fail,args.tool_delay)
        time.sleep(args.delay)
        result=run_tests(directory)
        print(result.stdout or result.stderr,flush=True)
        verification('passed' if result.returncode==0 else 'failed',source='python-assertion',basis='独立子进程断言 add(2, 3) == 5',summary='1 passed' if result.returncode==0 else 'assertion failed')
    # Intentional: successful host exit does not mean task acceptance passed.
    return 0


if __name__=='__main__':sys.exit(main())
