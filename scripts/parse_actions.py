import re
data = open('/tmp/ag_js/1f0rwj-m_c79q.js').read()
# Find all createServerReference calls - extract action ID and name
for m in re.finditer(r'createServerReference\("([a-f0-9]+)"[^)]*?"([^"]+)"\)', data):
    print(f'Action ID: {m.group(1)} Name: {m.group(2)}')
