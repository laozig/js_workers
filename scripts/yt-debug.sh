#!/bin/bash
# YouTube Premium 检测诊断脚本
# 用法: bash yt-debug.sh
# 分别测试 IPv4 和 IPv6，输出每一步的详细信息

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
COOKIE="YSC=BiCUU3-5Gdk; CONSENT=YES+cb.20220301-11-p0.en+FX+700; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; PREF=tz=Asia.Shanghai; _gcl_au=1.1.1809531354.1646633279"
URL="https://www.youtube.com/premium"

echo "=========================================="
echo " YouTube Premium 检测诊断"
echo " $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=========================================="

for FLAG in "-4" "-6"; do
  echo ""
  echo "=========================================="
  echo " [$FLAG] 测试 IPv${FLAG#-}"
  echo "=========================================="

  # Step 1: curl 版本
  echo ""
  echo "--- [1] curl 版本 ---"
  curl --version | head -1

  # Step 2: 网络连通性
  echo ""
  echo "--- [2] DNS 解析 ---"
  dig +short $FLAG www.youtube.com 2>/dev/null || nslookup www.youtube.com 2>/dev/null || echo "(dig/nslookup 不可用)"

  # Step 3: HTTP 请求（带 -sSL，修复后版本）
  echo ""
  echo "--- [3] curl 请求 (修复后: -sSL) ---"
  HTTP_CODE=$(curl -sSL --max-time 20 $FLAG -A "$UA" -H "Accept-Language: en" -b "$COOKIE" -o /tmp/yt_body.txt -w '%{http_code}' "$URL" 2>/tmp/yt_err.txt || echo "CURL_FAIL")
  echo "HTTP 状态码: $HTTP_CODE"
  echo "响应大小: $(wc -c < /tmp/yt_body.txt 2>/dev/null || echo 0) bytes"
  echo "stderr: $(cat /tmp/yt_err.txt 2>/dev/null)"
  BODY=$(cat /tmp/yt_body.txt 2>/dev/null)

  # Step 4: 关键匹配检测
  echo ""
  echo "--- [4] 关键匹配检测 ---"
  if [ -z "$BODY" ]; then
    echo "❌ body 为空！"
  else
    echo "body 长度: ${#BODY}"
    echo ""
    if echo "$BODY" | grep -q 'www.google.cn'; then
      echo "✅ 命中 'www.google.cn' → 应判定为 CN"
    else
      echo "⬜ 未命中 'www.google.cn'"
    fi
    if echo "$BODY" | grep -q 'Premium is not available in your country'; then
      echo "✅ 命中 'Premium is not available in your country' → 应判定为 noprem"
    else
      echo "⬜ 未命中 'Premium is not available in your country'"
    fi
    if echo "$BODY" | grep -q 'ad-free'; then
      echo "✅ 命中 'ad-free' → 应判定为 yes"
      REGION=$(printf '%s' "$BODY" | grep -o '"contentRegion":"[^"]*"' | head -n1 | cut -d'"' -f4)
      echo "   contentRegion: ${REGION:-未提取到}"
    else
      echo "❌ 未命中 'ad-free'"
    fi
  fi

  # Step 5: 对比旧版 (-fsSL)
  echo ""
  echo "--- [5] 对比旧版 (-fsSL，带 -f) ---"
  OLD_HTTP=$(curl -fsSL --max-time 20 $FLAG -A "$UA" -H "Accept-Language: en" -b "$COOKIE" -o /tmp/yt_body_old.txt -w '%{http_code}' "$URL" 2>/dev/null || echo "CURL_FAIL")
  OLD_SIZE=$(wc -c < /tmp/yt_body_old.txt 2>/dev/null || echo 0)
  echo "HTTP 状态码: $OLD_HTTP"
  echo "响应大小: $OLD_SIZE bytes"
  if [ "$OLD_SIZE" = "0" ] && [ "$(wc -c < /tmp/yt_body.txt 2>/dev/null || echo 0)" != "0" ]; then
    echo "⚠️  旧版 body 为空但新版有内容 → -f 导致响应被丢弃！"
  fi

  # Step 6: 响应头信息
  echo ""
  echo "--- [6] 响应头 ---"
  curl -sI --max-time 10 $FLAG -A "$UA" -H "Accept-Language: en" -b "$COOKIE" "$URL" 2>/dev/null | head -5

  # Step 7: body 预览
  echo ""
  echo "--- [7] body 预览 (前 500 字符) ---"
  echo "$BODY" | head -c 500
  echo ""

  # 清理
  rm -f /tmp/yt_body.txt /tmp/yt_body_old.txt /tmp/yt_err.txt
done

echo ""
echo "=========================================="
echo " 诊断完成"
echo "=========================================="
