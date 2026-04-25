#!/usr/bin/env python3
import json, sys, os
from datetime import datetime

def is_iso8601(s):
    try:
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        from datetime import datetime as dt
        dt.fromisoformat(s)
        return True
    except Exception:
        return False

schema_path = os.path.join('.github','catalog_schema.json')
if os.path.exists(schema_path):
    try:
        with open(schema_path,'r') as f:
            schema = json.load(f)
    except Exception:
        schema = None
else:
    schema = None

errors = 0
catfile = os.path.join('.github','catalog.jsonl')
if not os.path.exists(catfile):
    print('MISSING_CATALOG')
    sys.exit(2)
with open(catfile,'r') as f:
    for i,line in enumerate(f, start=1):
        line=line.strip()
        if not line: continue
        try:
            obj=json.loads(line)
        except Exception as e:
            print(f'LINE {i}: INVALID JSON: {e}')
            errors+=1
            continue
        # minimal checks
        for k in ('repo','path','generated_at'):
            if k not in obj:
                print(f'LINE {i}: missing {k}')
                errors+=1
        if 'generated_at' in obj and not is_iso8601(obj['generated_at']):
            print(f'LINE {i}: generated_at not ISO8601: {obj.get("generated_at")}')
            errors+=1

if errors:
    print('VALIDATION_FAILED', errors)
    sys.exit(3)
print('OK')
