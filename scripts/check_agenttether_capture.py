"""No-model end-to-end capture check. Creates an explicitly synthetic Run."""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from agentops_cli import verification
from agentops_cli.agenttether import AgentTetherCapture
from agentops_cli.session import CaptureSession


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agenttether-source', required=True)
    parser.add_argument('--server', default='http://127.0.0.1:8000')
    parser.add_argument('--spool-dir', default='.agentops/tether-check')
    args = parser.parse_args()
    with AgentTetherCapture(args.agenttether_source) as capture:
        with CaptureSession(server=args.server, goal='AgentTether 采集桥接自检（合成）',
                            spool_dir=args.spool_dir, sample_kind='synthetic') as session:
            with tempfile.TemporaryDirectory(prefix='agentops-tether-check-') as directory:
                def write_solution():
                    path = Path(directory) / 'solution.py'
                    path.write_text('def add(a, b):\n    return a + b - 1\n', encoding='utf-8')
                    return {'success': True, 'file': 'solution.py'}
                capture.wrap(write_solution, name='write_solution')()
                check = "from solution import add; assert add(2,3) == 5, 'addition failed'"
                result = capture.wrap(subprocess.run, name='run_tests', signal='tool')(
                    [sys.executable, '-c', check], cwd=directory, capture_output=True, text=True)
                verification('passed' if result.returncode == 0 else 'failed', source='python-assertion',
                             basis={'check': 'add(2,3) == 5', 'returncode': result.returncode},
                             summary='Synthetic fixture; independent subprocess assertion')
            print(session.url)
        if not session.finished:
            raise SystemExit('Upload incomplete; resume the spool before inspecting the Run')


if __name__ == '__main__':
    main()
