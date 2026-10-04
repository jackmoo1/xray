/**
 * 中国联通话费流量小组件（组件1多彩风格版）
 *
 * Cookie 获取：抓包工具 → 登录联通 App → 点首页 → 点你当前余额位置查询 → 然后回到你的抓包工具 → 复制 m.client.10010.com 请求中的 Cookie
 *
 *# ── 环境变量配置 ──
 *Cookie: "抓包获取的Cookie"
 *手机号： "186xxxxxxxx（联通手机号）"
 *
 */
export default async function(ctx) {
  const cookie = ctx.env.Cookie || "";
  const phone = ctx.env.手机号 || "";

  // 基础背景与文字颜色配置
  const baseColors = {
    bg: { light: "#FFFFFF", dark: "#1C1C1E" },
    title: { light: "#8E8E93", dark: "#8E8E93" },
    value: { light: "#000000", dark: "#FFFFFF" },
    time: { light: "#8E8E93", dark: "#636366" },
  };

  // 参考组件1的核心配色定义
  const itemColors = {
    fee: {
      accent: "#D7000F",
      bgLight: "rgba(215, 0, 15, 0.08)",
      bgDark: "rgba(215, 0, 15, 0.2)",
    },
    flow: {
      accent: "#12A6E4",
      bgLight: "rgba(18, 166, 228, 0.08)",
      bgDark: "rgba(18, 166, 228, 0.2)",
    },
    voice: {
      accent: "#F86527",
      bgLight: "rgba(248, 101, 39, 0.08)",
      bgDark: "rgba(248, 101, 39, 0.2)",
    }
  };

  let data = {
    fee: { title: "剩余话费", value: "--", unit: "元" },
    voice: { title: "剩余语音", value: "--", unit: "分钟" },
    flow: { title: "剩余流量", value: "--", unit: "MB" },
    updateTime: "--:--",
    error: null,
    debugInfo: [],
  };

  if (!phone || !cookie) {
    data.error = "配置缺失";
    if (!phone) data.debugInfo.push("❌ 未填写「手机号」");
    if (!cookie) data.debugInfo.push("❌ 未填写「Cookie」");
    data.debugInfo.push("💡 请在小组件配置页 → 环境变量中添加");
  } else {
    try {
      const url = `https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven?version=iphone_c@10.0100&desmobiel=${encodeURIComponent(phone)}&showType=0`;

      const resp = await ctx.http.get(url, {
        timeout: 8000,
        headers: {
          "Host": "m.client.10010.com",
          "User-Agent": "ChinaUnicom.x CFNetwork iOS/16.3",
          "cookie": cookie,
        },
      });

      const res = await resp.json();

      if (res?.code === "Y" && res.feeResource && res.voiceResource && res.flowResource) {
        data.fee = {
          title: res.feeResource.dynamicFeeTitle || "剩余话费",
          value: res.feeResource.feePersent ?? 0,
          unit: res.feeResource.newUnit || "元",
        };
        data.voice = {
          title: res.voiceResource.dynamicVoiceTitle || "剩余语音",
          value: res.voiceResource.voicePersent ?? 0,
          unit: res.voiceResource.newUnit || "分钟",
        };
        data.flow = {
          title: res.flowResource.dynamicFlowTitle || "剩余流量",
          value: res.flowResource.flowPersent ?? 0,
          unit: res.flowResource.newUnit || "MB",
        };
        data.updateTime = new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai"
        });
      } else {
        data.error = "API 返回异常";
        data.debugInfo.push(`响应 code: ${res?.code}`, "可能 Cookie 已过期");
      }
    } catch (e) {
      data.error = "请求失败";
      data.debugInfo.push(`错误: ${e.message}`);
    }
  }

  const widgetFamily = ctx.widgetFamily;
  const isSmall = widgetFamily === "systemSmall";

  // 构建 Medium 尺寸彩色卡片 (参考组件1样式)
  function makeMediumCard(title, value, unit, colorConfig, iconName) {
    return {
      type: "stack",
      direction: "column",
      alignItems: "center",
      justifyContent: "space-between",
      flex: 1,
      padding: [10, 8, 12, 8],
      backgroundColor: { light: colorConfig.bgLight, dark: colorConfig.bgDark },
      borderRadius: 16,
      children: [
        // 头部 SF 图标 / 标识
        {
          type: "stack",
          direction: "row",
          alignItems: "center",
          gap: 4,
          children: [
            { type: "image", src: `sf-symbol:${iconName}`, color: colorConfig.accent, width: 14, height: 14 },
            {
              type: "text",
              text: title,
              font: { size: "caption2", weight: "medium" },
              textColor: colorConfig.accent,
              maxLines: 1,
              minScale: 0.8,
            },
          ]
        },
        // 中间数值
        {
          type: "stack",
          direction: "row",
          alignItems: "baseline",
          gap: 2,
          children: [
            {
              type: "text",
              text: String(value),
              font: { size: "title2", weight: "bold" },
              textColor: colorConfig.accent,
              minScale: 0.5,
              maxLines: 1,
            },
            {
              type: "text",
              text: unit,
              font: { size: "caption2", weight: "bold" },
              textColor: colorConfig.accent,
              minScale: 0.7,
              maxLines: 1,
            },
          ],
        },
      ],
    };
  }

  // 构建 Small 尺寸彩色条目
  function makeSmallCard(title, value, unit, colorConfig, iconName) {
    return {
      type: "stack",
      direction: "row",
      alignItems: "center",
      padding: [6, 10, 6, 10],
      backgroundColor: { light: colorConfig.bgLight, dark: colorConfig.bgDark },
      borderRadius: 10,
      children: [
        { type: "image", src: `sf-symbol:${iconName}`, color: colorConfig.accent, width: 14, height: 14 },
        { type: "spacer" },
        {
          type: "text",
          text: `${title} ${value} ${unit}`,
          font: { size: "caption1", weight: "bold" },
          textColor: colorConfig.accent,
          textAlign: "center",
          numberOfLines: 1,
          minScale: 0.7,
          maxLines: 1,
        },
        { type: "spacer" },
      ],
    };
  }

  const cards = isSmall ? [
    makeSmallCard(data.fee.title, data.fee.value, data.fee.unit, itemColors.fee, "yensign.circle.fill"),
    makeSmallCard(data.flow.title, data.flow.value, data.flow.unit, itemColors.flow, "antenna.radiowaves.left.and.right"),
    makeSmallCard(data.voice.title, data.voice.value, data.voice.unit, itemColors.voice, "phone.fill"),
  ] : [
    makeMediumCard(data.fee.title, data.fee.value, data.fee.unit, itemColors.fee, "yensign.circle.fill"),
    makeMediumCard(data.flow.title, data.flow.value, data.flow.unit, itemColors.flow, "antenna.radiowaves.left.and.right"),
    makeMediumCard(data.voice.title, data.voice.value, data.voice.unit, itemColors.voice, "phone.fill"),
  ];

  return {
    type: "widget",
    backgroundColor: baseColors.bg,
    padding: isSmall ? [10, 10, 10, 10] : [12, 12, 12, 12],
    gap: isSmall ? 6 : 10,
    refreshAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    children: [
      // 头部栏：标题 + 更新时间
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: [
          {
            type: "stack",
            direction: "row",
            alignItems: "center",
            gap: isSmall ? 4 : 6,
            children: [
              { type: "image", src: "sf-symbol:simcard.fill", color: itemColors.fee.accent, width: isSmall ? 13 : 16, height: isSmall ? 13 : 16 },
              { type: "text", text: "中国联通", font: { size: isSmall ? "caption1" : "subheadline", weight: "bold" }, textColor: baseColors.value, maxLines: 1 },
            ],
          },
          { type: "spacer" },
          {
            type: "stack",
            direction: "row",
            alignItems: "center",
            gap: 3,
            children: [
              { type: "image", src: "sf-symbol:arrow.clockwise", color: baseColors.time, width: 10, height: 10 },
              { type: "text", text: data.updateTime, font: { size: "caption2" }, textColor: baseColors.time, maxLines: 1 },
            ],
          },
        ],
      },

      // 主体部分：三列/三行彩色卡片
      {
        type: "stack",
        direction: isSmall ? "column" : "row",
        alignItems: "stretch",
        flex: 1,
        gap: isSmall ? 6 : 8,
        children: cards,
      },
    ],
  };
}
