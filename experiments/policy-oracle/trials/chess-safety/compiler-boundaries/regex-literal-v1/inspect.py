"""Inventory direct, unescaped ASCII matches() literals in the complete generated Firestore source."""
import hashlib
import json
from pathlib import Path
import re
import sys

# Consume comments and quoted strings as complete tokens. This avoids matches
# text inside a string being counted as another call. Only a single quoted
# argument other than a concatenation or dynamically computed value is graded.
TOKEN = re.compile(r"""//[^\n]*|/\*[\s\S]*?\*/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|[\w$]+|[^\s]""")
LIMIT = 4096
GROUP_LIMIT = 100


def inspect(source):
    tokens = [m for m in TOKEN.finditer(source) if not m[0].startswith(('//','/*'))]
    measurements = []
    other_arguments = 0
    function = None
    for i, token in enumerate(tokens):
        if token[0] == 'function' and i + 1 < len(tokens):
            function = tokens[i+1][0]
        if token[0] != 'matches' or i < 1 or tokens[i-1][0] != '.' or i+3 >= len(tokens):
            continue
        arg = tokens[i+2]
        if (tokens[i+1][0] != '(' or tokens[i+3][0] != ')' or arg[0][0] not in ['"',"'"]
                or not arg[0].isascii() or chr(92) in arg[0]):
            other_arguments += 1
            continue
        pattern = arg[0][1:-1]
        in_class = False
        group_count = 0
        for char in pattern:
            if char == '[':
                in_class = True
            elif char == ']':
                in_class = False
            elif char == '(' and not in_class:
                group_count += 1
        measurements.append({'function':function,'line':source.count('\n',0,arg.start())+1,
                             'column':arg.start()-source.rfind('\n',0,arg.start()),
                             'length':len(pattern),'groups':group_count,'patternSha256':hashlib.sha256(pattern.encode()).hexdigest()})
    return {'rulesSha256':hashlib.sha256(source.encode()).hexdigest(),'directAsciiLiterals':len(measurements),
            'largest':max((p['length'] for p in measurements),default=None),'otherMatchesArguments':other_arguments,
            'observedLimit':LIMIT,'observedGroupsLimit':GROUP_LIMIT,
            'maxGroups':max((p['groups'] for p in measurements),default=None),
            'exceedingGroups':[m for m in measurements if m['groups']>GROUP_LIMIT],
            'exceeding':[m for m in measurements if m['length']>LIMIT]}


if __name__ == '__main__':
    print(json.dumps(inspect(Path(sys.argv[1]).read_bytes().decode('utf-8')),indent=2))
