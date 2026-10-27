"""ECMAScript whitespace for String.trim/trimStart and regular-expression \\s.

Python includes control separators and U+0085 as whitespace, but JavaScript does
not; JavaScript includes the U+FEFF byte-order mark that Python leaves intact.
"""

JS_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
JS_WHITESPACE_PATTERN = "[" + JS_WHITESPACE + "]"


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def js_trim_start(s: str) -> str:
    return s.lstrip(JS_WHITESPACE)
