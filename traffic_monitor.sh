#!/bin/bash

# ====== 配置区 ======
# 替换成你的实际值
BOT_TOKEN="你的TelegramBotToken"
CHAT_ID="你的ChatID"
NETWORK_INTERFACE="eth0" # 你的公网网卡名，可通过 `ip addr` 命令查看

# ====== 功能函数 ======
send_telegram_message() {
    local message="$1"
    # 使用curl调用Telegram API发送消息
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=${message}" \
        -d "disable_web_page_preview=true" \
        -d "parse_mode=Markdown" > /dev/null
}

# 流量单位转换函数 (字节转GB)
bytes_to_gb() {
    local bytes="$1"
    echo "scale=2; $bytes / 1024 / 1024 / 1024" | bc
}

# ====== 主逻辑 ======
# 1. 获取本机主机名（用于标识是哪台VPS）
HOSTNAME=$(hostname)
CURRENT_DATE=$(date +"%Y-%m-%d")

# 2. 使用vnStat获取流量统计
# 获取今日流量
TODAY_INFO=$(vnstat -i ${NETWORK_INTERFACE} --json d 1)
TODAY_RX=$(echo "$TODAY_INFO" | jq -r '.interfaces[0].traffic.day[0].rx')
TODAY_TX=$(echo "$TODAY_INFO" | jq -r '.interfaces[0].traffic.day[0].tx')

# 获取当月流量
MONTH_INFO=$(vnstat -i ${NETWORK_INTERFACE} --json m 1)
MONTH_RX=$(echo "$MONTH_INFO" | jq -r '.interfaces[0].traffic.month[0].rx')
MONTH_TX=$(echo "$MONTH_INFO" | jq -r '.interfaces[0].traffic.month[0].tx')

# 计算总量
TODAY_TOTAL=$((TODAY_RX + TODAY_TX))
MONTH_TOTAL=$((MONTH_RX + MONTH_TX))

# 3. 单位转换 (vnStat默认使用KiB, 需要转换为GiB)
# 今日流量转换
TODAY_RX_GB=$(echo "scale=2; $TODAY_RX / 1024 / 1024" | bc)
TODAY_TX_GB=$(echo "scale=2; $TODAY_TX / 1024 / 1024" | bc)
TODAY_TOTAL_GB=$(echo "scale=2; $TODAY_TOTAL / 1024 / 1024" | bc)

# 当月流量转换
MONTH_RX_GB=$(echo "scale=2; $MONTH_RX / 1024 / 1024" | bc)
MONTH_TX_GB=$(echo "scale=2; $MONTH_TX / 1024 / 1024" | bc)
MONTH_TOTAL_GB=$(echo "scale=2; $MONTH_TOTAL / 1024 / 1024" | bc)

# 4. 格式化消息
MESSAGE="🖥️ *VPS流量报告* 🖥️
🏷️ *主机*: ${HOSTNAME}
📅 *日期*: ${CURRENT_DATE}

📊 *今日流量统计*:
├ 下行: ${TODAY_RX_GB} GiB
├ 上行: ${TODAY_TX_GB} GiB
└ 总计: ${TODAY_TOTAL_GB} GiB

📈 *当月累计统计*:
├ 下行: ${MONTH_RX_GB} GiB
├ 上行: ${MONTH_TX_GB} GiB
└ 总计: ${MONTH_TOTAL_GB} GiB
====================="

# 5. 发送消息到Telegram
send_telegram_message "$MESSAGE"

# 6. 可选：在终端也输出一份用于调试
echo "流量报告已发送:"
echo "今日: 下行 ${TODAY_RX_GB} GiB, 上行 ${TODAY_TX_GB} GiB"
echo "当月: 下行 ${MONTH_RX_GB} GiB, 上行 ${MONTH_TX_GB} GiB"
