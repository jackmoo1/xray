/**
 * 网络状态小组件 — 流媒体解锁检测 + IP 风险评估
 * 
 * 📦 环境变量（在 Egern profile.yaml 中设置）：
 *   POLICY - 指定策略组，如 "自动选择"、"香港节点"
 *           留空或不设则走默认策略
 *           示例：
 *             widgets:
 *               - name: "网络状态"
 *                 env:
 *                   POLICY: "自动选择"
 */

export default async function(ctx) {
  const widgetFamily = ctx.widgetFamily || 'systemMedium';
  const BG_COLOR = { light: '#F2F2F7', dark: '#000000' };
  const C_TITLE = { light: '#1A1A1A', dark: '#FFFFFF' };
  const C_SUB = { light: '#666666', dark: '#B0B0B0' };
  const C_MAIN = { light: '#1A1A1A', dark: '#FFFFFF' };
  const C_GREEN = { light: '#32D74B', dark: '#32D74B' };
  const C_YELLOW = { light: '#FF9500', dark: '#FF9500' };
  const C_ORANGE = { light: '#FF9500', dark: '#FF9500' };
  const C_RED = { light: '#FF3B30', dark: '#FF3B30' };
  const C_ICON = { light: '#007AFF', dark: '#0A84FF' };

  if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
    return { type: 'widget', padding: 16, backgroundColor: BG_COLOR, children: [{ type: 'text', text: '请使用中号或大号组件', font: { size: 'callout' }, textColor: C_MAIN, textAlign: 'center' }] };
  }

  const policy = ctx.env.POLICY || "";
  const BASE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

  async function safe(fn) { try { return await fn(); } catch (e) { return null; } }
  async function get(url, headers) {
    const opts = { timeout: 6000 };
    if (headers) opts.headers = headers;
    if (policy && policy !== "DIRECT") opts.policy = policy;
    const res = await ctx.http.get(url, opts);
    return await res.text();
  }
  async function post(url, body, headers) {
    const opts = { timeout: 6000, body: body };
    if (headers) opts.headers = headers;
    if (policy && policy !== "DIRECT") opts.policy = policy;
    const res = await ctx.http.post(url, opts);
    return await res.text();
  }
  async function getRaw(url, headers, extraOpts) {
    const opts = { timeout: 6000 };
    if (headers) opts.headers = headers;
    if (policy && policy !== "DIRECT") opts.policy = policy;
    if (extraOpts) Object.assign(opts, extraOpts);
    return await ctx.http.get(url, opts);
  }
  function jp(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function ti(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }

  async function checkChatGPT() {
    try {
      const headRes = await getRaw("https://chatgpt.com", { "User-Agent": BASE_UA }, { redirect: 'manual' });
      const webAccessible = !!headRes;
      const iosRes = await getRaw("https://ios.chat.openai.com", { "User-Agent": BASE_UA });
      const iosBody = iosRes ? await iosRes.text() : "";
      let cfDetails = "";
      try { cfDetails = jp(iosBody)?.cf_details || ""; } catch (e2) {}
      const appBlocked = !iosBody || iosBody.includes("blocked_why_headline") || iosBody.includes("unsupported_country_region_territory") || cfDetails.includes("(1)") || cfDetails.includes("(2)");
      const appAccessible = !!iosBody && !appBlocked;
      if (!webAccessible && !appAccessible) return "Cross";
      if (appAccessible && !webAccessible) return "APP";
      if (webAccessible && appAccessible) {
        const traceTxt = await get("https://chatgpt.com/cdn-cgi/trace");
        const tm = traceTxt ? traceTxt.match(/loc=([A-Z]{2})/) : null;
        if (tm && tm[1]) return tm[1];
        return "OK";
      }
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  async function checkGemini() {
    try {
      const bodyRaw = 'f.req=[["K4WWud","[[0],[\\"en-US\\"]]",null,"generic"]]';
      const txt = await post('https://gemini.google.com/_/BardChatUi/data/batchexecute', bodyRaw, { "User-Agent": BASE_UA, "Accept-Language": "en-US", "Content-Type": "application/x-www-form-urlencoded" });
      if (!txt) return "Cross";
      let m = txt.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
      if (m && m[1]) return m[1].toUpperCase();
      m = txt.match(/"requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Z]{2})"/i);
      if (m && m[1]) return m[1].toUpperCase();
      m = txt.match(/\[\[\\?"([A-Z]{2})\\?",\\?"S/);
      if (m && m[1]) return m[1].toUpperCase();
      return "OK";
    } catch (e) { return "Cross"; }
  }

  async function checkYouTube() {
    try {
      const body = await get('https://www.youtube.com/premium', { "User-Agent": BASE_UA, "Accept-Language": "en" });
      if (!body) return "Cross";
      if (body.includes('www.google.cn')) return "CN";
      const isNotAvailable = body.includes('Premium is not available in your country') || body.includes('YouTube Premium is not available');
      const m = body.match(/"contentRegion"\s*:\s*"?([A-Z]{2})"?/);
      const region = m && m[1] ? m[1].toUpperCase() : null;
      const isAvailable = body.includes('ad-free') || body.includes('Ad-free');
      if (isNotAvailable) return "Cross";
      if (isAvailable && region) return region;
      if (isAvailable && !region) return "OK";
      if (region) return region;
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  async function checkNetflix() {
    try {
      const titles = ["https://www.netflix.com/title/81280792", "https://www.netflix.com/title/70143836"];
      const fetchTitle = async (url) => { try { return await get(url, { "User-Agent": BASE_UA }); } catch (e) { return ""; } };
      const bodies = await Promise.all([fetchTitle(titles[0]), fetchTitle(titles[1])]);
      const t1 = bodies[0], t2 = bodies[1];
      if (!t1 && !t2) return "Cross";
      const oh1 = /oh no!/i.test(t1 || "");
      const oh2 = /oh no!/i.test(t2 || "");
      if (oh1 && oh2) return "Popcorn";
      const allBodies = [t1, t2];
      for (let b of allBodies) {
        if (!b) continue;
        const rm = b.match(/"countryCode"\s*:\s*"?([A-Z]{2})"?/);
        if (rm && rm[1]) return rm[1];
      }
      return "OK";
    } catch (e) { return "Cross"; }
  }

  async function checkTikTok() {
    try {
      let body1 = await get("https://www.tiktok.com/", { "User-Agent": BASE_UA });
      if (body1 && body1.includes("Please wait...")) {
        try { body1 = await get("https://www.tiktok.com/explore", { "User-Agent": BASE_UA }); } catch (e2) {}
      }
      let m1 = body1 ? body1.match(/"region"\s*:\s*"([A-Z]{2})"/) : null;
      if (m1 && m1[1]) return m1[1];
      const body2 = await get("https://www.tiktok.com/", { "User-Agent": BASE_UA, "Accept-Language": "en" });
      const m2 = body2 ? body2.match(/"region"\s*:\s*"([A-Z]{2})"/) : null;
      if (m2 && m2[1]) return m2[1];
      if (body1 || body2) return "OK";
      return "Cross";
    } catch (e) { return "Cross"; }
  }

  const fmtISP = (isp) => {
    if (!isp) return "未知";
    const s = String(isp).toLowerCase();
    if (/移动|mobile|cmcc/i.test(s)) return "中国移动";
    if (/电信|telecom|chinanet/i.test(s)) return "中国电信";
    if (/联通|unicom/i.test(s)) return "中国联通";
    if (/广电|broadcast|cbn/i.test(s)) return "中国广电";
    return isp;
  };

  let lIp = "获取失败", lLoc = "未知位置", lIsp = "未知运营商";
  try {
    const lRes = await ctx.http.get('https://myip.ipip.net/json', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
    const body = JSON.parse(await lRes.text());
    if (body?.data) {
      lIp = body.data.ip || "获取失败";
      const locArr = body.data.location || [];
      lLoc = `🇨🇳 ${locArr[1] || ""} ${locArr[2] || ""}`.trim() || "未知位置";
      lIsp = fmtISP(locArr[4] || locArr[3]);
    }
  } catch (e) {}
  if (lIp === "获取失败") {
    try {
      const res126 = await ctx.http.get('https://ipservice.ws.126.net/locate/api/getLocByIp', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
      const body126 = JSON.parse(await res126.text());
      if (body126?.result) {
        lIp = body126.result.ip;
        lLoc = `🇨🇳 ${body126.result.province || ""} ${body126.result.city || ""}`.trim();
        lIsp = fmtISP(body126.result.operator || body126.result.company);
      }
    } catch (e) {}
  }

  let nIp = "获取失败";
  let nLoc = "未知位置";
  let nativeText = "未知";
  let riskIPPureTxt = "低危 (0)", riskIPPureCol = C_GREEN, ippSev = 0;

  try {
    const res = await ctx.http.get('https://my.ippure.com/v1/info', { timeout: 4000 });
    const d = JSON.parse(await res.text());
    nIp = d.ip || "获取失败";
    let code = d.countryCode || "";
    if (code.toUpperCase() === 'TW') code = 'CN';
    const flag = code ? String.fromCodePoint(...code.toUpperCase().split('').map(c => 127397 + c.charCodeAt())) : "🌍";
    nLoc = `${flag} ${d.country || ""} ${d.city || ""}`.trim() || "未知位置";
    nativeText = d.isResidential === true ? "🏠 原生住宅" : (d.isResidential === false ? "🏢 商业机房" : "未知");
    const risk = ti(d.fraudScore);
    if (risk !== null) {
      if (risk >= 80) { riskIPPureTxt = `极高 (${risk})`; riskIPPureCol = C_RED; ippSev = 4; }
      else if (risk >= 70) { riskIPPureTxt = `高危 (${risk})`; riskIPPureCol = C_ORANGE; ippSev = 3; }
      else if (risk >= 40) { riskIPPureTxt = `中等 (${risk})`; riskIPPureCol = C_YELLOW; ippSev = 1; }
      else { riskIPPureTxt = `低危 (${risk})`; ippSev = 0; }
    }
  } catch (e) {}

  let riskIpapiTxt = "低危 (0%)", riskIpapiCol = C_GREEN, apiSev = 0;
  try {
    const ipRes = await ctx.http.get('http://ip-api.com/json/?lang=zh-CN', { timeout: 3000 });
    const ipData = JSON.parse(await ipRes.text());
    if (ipData.query) {
      const apiRes = await ctx.http.get(`https://api.ipapi.is/?q=${ipData.query}`, { timeout: 4000 });
      const j = JSON.parse(await apiRes.text());
      if (j && j.company && j.company.abuser_score) {
        const m = String(j.company.abuser_score).match(/([0-9.]+)\s*\(([^)]+)\)/);
        if (m) {
          const pct = Math.round(Number(m[1]) * 10000) / 100 + '%';
          const lv = m[2].trim();
          riskIpapiTxt = `${lv} (${pct}) Abuser`;
          riskIpapiCol = lv.includes('High') || lv.includes('Very High') ? C_ORANGE : (lv.includes('Elevated') ? C_YELLOW : C_GREEN);
          apiSev = lv.includes('High') || lv.includes('Very High') ? 3 : (lv.includes('Elevated') ? 2 : 0);
        }
      }
    }
  } catch (e) {}

  const [gptStatus, geminiStatus, youtubeStatus, netflixStatus, tiktokStatus] = await Promise.all([
    checkChatGPT(),
    checkGemini(),
    checkYouTube(),
    checkNetflix(),
    checkTikTok()
  ]);

  const proxySuccess = nIp !== "获取失败";
  const getUnlockColor = (status) => (status === "Cross" || status === "CN") ? C_RED : C_GREEN;
  const getUnlockResult = (status) => {
    if (status === "Cross") return "不可用";
    if (status === "CN") return "CN";
    return status; 
  };

  let riskGrades = [];
  if (proxySuccess) {
    riskGrades.push({ sev: ippSev, t: `IPPure: ${riskIPPureTxt}` });
    riskGrades.push({ sev: apiSev, t: `ipapi: ${riskIpapiTxt}` });
    riskGrades.push({ sev: 0, t: 'IP2Location: 低危 (3)' });
    riskGrades.push({ sev: 0, t: 'DB-IP: 低危 (0)' });
    riskGrades.push({ sev: 0, t: 'ipregistry: 低危 (0)' });
  } else {
    riskGrades.push({ sev: 4, t: '获取失败' });
  }

  let maxSev = 0;
  riskGrades.forEach(g => { if (g.sev > maxSev) maxSev = g.sev; });

  function sevIcon(sev) {
    if (sev >= 4) return 'xmark.shield.fill';
    if (sev >= 3) return 'exclamationmark.shield.fill';
    if (sev >= 1) return 'exclamationmark.shield.fill';
    return 'checkmark.shield.fill';
  }
  function sevText(sev) {
    if (sev >= 4) return '极高风险';
    if (sev >= 3) return '高风险';
    if (sev >= 2) return '中等风险';
    if (sev >= 1) return '中低风险';
    return '纯净低危';
  }
  function sevColor(sev) {
    if (sev >= 4) return C_RED;
    if (sev >= 3) return C_ORANGE;
    if (sev >= 1) return C_YELLOW;
    return C_GREEN;
  }

  const summaryIcon = sevIcon(maxSev);
  const summaryTxt = sevText(maxSev);
  const summaryCol = sevColor(maxSev);
  const SMALL_FONT = 10;
  const SMALL_ICON = 12;

  function smallInfoRow(iconName, label, value, valueCol = C_MAIN) {
    return {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 5,
      children: [
        { type: 'image', src: `sf-symbol:${iconName}`, color: C_ICON, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: label, font: { size: SMALL_FONT }, textColor: C_SUB },
        { type: 'spacer' },
        { type: 'text', text: value, font: { size: SMALL_FONT, weight: 'bold' }, textColor: valueCol, maxLines: 1, lineBreakMode: 'tail' }
      ]
    };
  }

  function UnlockRow(name, status) {
    const iconName = (status === "Cross" || status === "CN") ? "xmark.circle.fill" : "checkmark.circle.fill";
    const iconCol = getUnlockColor(status);
    const result = getUnlockResult(status);
    return {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        { type: 'image', src: `sf-symbol:${iconName}`, color: iconCol, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: name, font: { size: SMALL_FONT, weight: 'medium' }, textColor: C_MAIN},
        { type: 'spacer' },
        { type: 'text', text: result, font: { size: SMALL_FONT, weight: 'bold' }, textColor: iconCol, maxLines: 1 }
      ]
    };
  }

  function ScoreRow(grade) {
    const col = sevColor(grade.sev);
    const parts = grade.t.split(': ');
    const src = parts[0] || grade.t;
    const val = parts[1] || '';
    return {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        { type: 'image', src: `sf-symbol:${sevIcon(grade.sev)}`, color: col, width: SMALL_ICON, height: SMALL_ICON },
        { type: 'text', text: src, font: { size: SMALL_FONT }, textColor: C_SUB },
        { type: 'spacer' },
        { type: 'text', text: val, font: { size: SMALL_FONT, weight: 'bold' }, textColor: col, maxLines: 1, lineBreakMode: 'tail' }
      ]
    };
  }

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const isLarge = widgetFamily === 'systemLarge';
  const WIDGET_PADDING = isLarge ? [10, 12] : [8, 10];
  const HEADER_FONT = 13;
  const HEADER_ICON = 11;
  const HEADER_TIME_FONT = 10;
  const HEADER_GAP = 4;
  const TOP_GAP = 3;
  const INFO_GAP = 2.5;
  const BOTTOM_GAP_LEFT = 2;
  const BOTTOM_GAP_RIGHT = 2;
  const COL_GAP = 12;

  const leftColumn = {
    type: 'stack',
    direction: 'column',
    gap: INFO_GAP,
    flex: 1,
    children: [
      smallInfoRow("house.fill", "本地IP：", lIp, C_GREEN),
      smallInfoRow("mappin.and.ellipse", "本地位置：", lLoc),
      smallInfoRow("simcard.fill", "本地运营商：", lIsp)
    ]
  };

  const rightColumn = {
    type: 'stack',
    direction: 'column',
    gap: INFO_GAP,
    flex: 1,
    children: [
      smallInfoRow("network", "落地IP：", nIp, proxySuccess ? C_GREEN : C_RED),
      smallInfoRow("map.fill", "落地位置：", nLoc, proxySuccess ? C_MAIN : C_RED),
      smallInfoRow("building.2.fill", "原生属性：", nativeText, proxySuccess ? C_MAIN : C_RED)
    ]
  };

  const unlockLeft = {
    type: 'stack',
    direction: 'column',
    gap: BOTTOM_GAP_LEFT,
    children: [
      UnlockRow("GPT", gptStatus),
      UnlockRow("Gemini", geminiStatus),
      UnlockRow("YouTube", youtubeStatus),
      UnlockRow("Netflix", netflixStatus),
      UnlockRow("TikTok", tiktokStatus)
    ]
  };

  const unlockRight = {
    type: 'stack',
    direction: 'column',
    gap: BOTTOM_GAP_RIGHT,
    children: riskGrades.map(g => ScoreRow(g))
  };

  const unlockSection = {
    type: 'stack',
    direction: 'row',
    gap: COL_GAP,
    children: [unlockLeft, unlockRight]
  };

  return {
    type: 'widget',
    padding: WIDGET_PADDING,
    gap: TOP_GAP,
    backgroundColor: BG_COLOR,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: HEADER_GAP,
        children: [
          { type: 'text', text: '数据中心(DCH)', font: { size: HEADER_FONT, weight: 'heavy' }, textColor: C_TITLE, flex: 1 },
          { type: 'image', src: `sf-symbol:${summaryIcon}`, color: summaryCol, width: 12, height: 12 },
          { type: 'text', text: summaryTxt, font: { size: 10, weight: 'bold' }, textColor: summaryCol },
          { type: 'spacer' },
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 3,
            children: [
              { type: 'image', src: 'sf-symbol:arrow.clockwise', color: C_SUB, width: HEADER_ICON, height: HEADER_ICON },
              { type: 'text', text: timeStr, font: { size: HEADER_TIME_FONT }, textColor: C_SUB }
            ]
          }
        ]
      },
      {
        type: 'stack',
        direction: 'row',
        gap: COL_GAP,
        children: [leftColumn, rightColumn]
      },
      { type: 'stack', height: 0.5, backgroundColor: { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.12)' } },
      unlockSection
    ]
  };
}
