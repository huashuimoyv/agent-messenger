"""Mount the tested service in Codex and Antigravity; keep exact backups."""
import datetime
import json
import os
from pathlib import Path
import shutil
import tomllib


def main():
    root = Path(__file__).resolve().parents[1]
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 24.9+ is required.')
    bundle = root / 'dist' / 'agent-messenger.mjs'
    if not bundle.is_file():
        raise SystemExit('Build the server with npm run build before configuring clients.')
    args = ['--disable-warning=ExperimentalWarning', str(bundle)]
    home = Path.home()
    codex = Path(os.environ.get('CODEX_HOME', home / '.codex')) / 'config.toml'
    antigravity = home / '.gemini' / 'config' / 'mcp_config.json'
    pi_mcp = home / '.pi' / 'agent' / 'mcp.json'
    codex_text = codex.read_text(encoding='utf-8-sig')
    codex_parsed = tomllib.loads(codex_text)
    ag_parsed = json.loads(antigravity.read_text(encoding='utf-8-sig'))
    pi_parsed = json.loads(pi_mcp.read_text(encoding='utf-8-sig')) if pi_mcp.is_file() else {'mcpServers': {}}
    entry = {'command': node, 'args': args}
    for existing in (codex_parsed.get('mcp_servers', {}).get('agent-messenger'), ag_parsed.get('mcpServers', {}).get('agent-messenger'), pi_parsed.get('mcpServers', {}).get('agent-messenger')):
        if existing and existing != entry:
            raise SystemExit('An existing agent-messenger entry has different or additional settings; it was preserved. Resolve this name conflict first.')

    # Replace only the old HUD MCP transport. The original app, hooks, approval
    # policy, sandbox and every other server are untouched.
    lines = codex_text.splitlines(keepends=True)
    retained, skipping = [], False
    for line in lines:
        if line.lstrip().startswith('['):
            section = line.strip()
            skipping = section in ('[mcp_servers.agent-hud]', '[mcp_servers.agent-messenger]')
            if section.startswith('[mcp_servers.agent-hud.') or section.startswith('[mcp_servers.agent-messenger.'):
                raise SystemExit('Nested HUD/messenger settings found; preserved for manual review.')
        if not skipping:
            retained.append(line)
    block = '\n[mcp_servers.agent-messenger]\ncommand = ' + json.dumps(node) + '\nargs = ' + json.dumps(args) + '\n'
    new_codex = ''.join(retained).rstrip() + '\n' + block
    tomllib.loads(new_codex)
    ag_parsed.setdefault('mcpServers', {}).pop('agent-hud', None)
    ag_parsed['mcpServers']['agent-messenger'] = entry
    new_ag = json.dumps(ag_parsed, ensure_ascii=False, indent=2) + '\n'
    pi_parsed.setdefault('mcpServers', {}).pop('agent-hud', None)
    pi_parsed['mcpServers']['agent-messenger'] = entry
    new_pi = json.dumps(pi_parsed, ensure_ascii=False, indent=2) + '\n'
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backups = []
    targets_with_text = [(codex, new_codex), (antigravity, new_ag), (pi_mcp, new_pi)]
    for target, _ in targets_with_text:
        if target.is_file():
            backup = target.with_name(target.name + '.agent-messenger-' + stamp + '.bak')
            shutil.copy2(target, backup)
            backups.append(str(backup))
    for target, text in targets_with_text:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + '.agent-messenger.tmp')
        temp.write_text(text, encoding='utf-8', newline='')
        os.replace(temp, target)
    actual_codex = tomllib.loads(codex.read_text(encoding='utf-8'))
    actual_ag = json.loads(antigravity.read_text(encoding='utf-8'))
    actual_pi = json.loads(pi_mcp.read_text(encoding='utf-8'))
    assert actual_codex['mcp_servers']['agent-messenger'] == entry
    assert actual_ag['mcpServers']['agent-messenger'] == entry
    assert actual_pi['mcpServers']['agent-messenger'] == entry
    old_other = {k: v for k, v in codex_parsed.items() if k != 'mcp_servers'}
    new_other = {k: v for k, v in actual_codex.items() if k != 'mcp_servers'}
    assert old_other == new_other
    for name, value in codex_parsed.get('mcp_servers', {}).items():
        if name not in ('agent-hud', 'agent-messenger'):
            assert actual_codex['mcp_servers'][name] == value
    print(json.dumps({'configured': [str(codex), str(antigravity), str(pi_mcp)], 'backups': backups, 'server': entry}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
