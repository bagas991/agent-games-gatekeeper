import re
html = open('/tmp/register.html').read()
# Find action IDs (40-char hex)
hex_ids = set(re.findall(r'[a-f0-9]{40}', html))
print('Hex IDs:', hex_ids)
# Find Next.js server action references
rsc_actions = re.findall(r'\$[a-f0-9]{40}', html)
print('RSC action refs:', set(rsc_actions))
# Find the RSC flight data
flight = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', html)
for i, f in enumerate(flight):
    # Look for action-related content
    if 'action' in f.lower() or 'register' in f.lower() or 'complete' in f.lower():
        print(f'Flight {i} (action-related): {f[:300]}')
