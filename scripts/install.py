"""Mount Agent Messenger across detected Codex, Antigravity, and Pi clients."""
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 24.9+ is required.')
    script = Path(__file__).resolve().with_name('install.mjs')
    result = subprocess.run([node, str(script), *sys.argv[1:]])
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
