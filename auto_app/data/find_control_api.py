import re

with open("/home/pccuong/Downloads/spam/akabiz_web/index-BzZ6tmDk.js", "r", encoding="utf-8", errors="ignore") as f:
    text = f.read()

pos = text.find("/api/aka-agent/control/v1")
if pos != -1:
    start = max(0, pos - 500)
    end = min(len(text), pos + 1500)
    print("--- Context around /api/aka-agent/control/v1 ---")
    print(text[start:end])
else:
    print("Not found")
