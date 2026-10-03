#!/bin/sh
# verify 服务入口：规则测试 + 构建检查 + HTTP 冒烟，运行一次后以退出码报告结果。
set -u
status=0

echo "== 1/3 规则测试（地址复用 / 扫描回收 / 迟到读取 等） =="
if node --test tests/; then
  echo "规则测试通过"
else
  echo "规则测试失败"
  status=1
fi

echo "== 2/3 构建检查 =="
for f in web/analyzer.js web/worker.js web/app.js; do
  if node --check "$f"; then
    echo "语法检查通过：$f"
  else
    echo "语法检查失败：$f"
    status=1
  fi
done
if [ -f web/index.html ] \
  && grep -q 'app.js' web/index.html \
  && grep -q 'worker.js' web/app.js \
  && grep -q 'analyzer.js' web/worker.js; then
  echo "页面文件检查通过：index.html -> app.js -> worker.js -> analyzer.js 引用链完整"
else
  echo "页面文件检查失败：页面脚本引用链不完整"
  status=1
fi

echo "== 3/3 HTTP 冒烟 =="
BASE="${WEB_BASE_URL:-http://web}"
if node tests/smoke.js "$BASE"; then
  echo "HTTP 冒烟通过"
else
  echo "HTTP 冒烟失败"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "VERIFY RESULT: OK"
else
  echo "VERIFY RESULT: FAILED"
fi
exit "$status"
