// 1) author: 𝕏Panda 首要显示：国际黄金（人民币/克）当日价 + 近30日均价
// 2) 展示金店：周大福 / 六福珠宝 / 周生生
// 3) 展示现货：国际黄金 / 国际白银 / 上海黄金 / 上海白银
// 4) 统一人民币单价（元/克），不展示盎司价格

const PAGE_URL = "https://www.ip138.com/gold/";
const SHOPS = ["周大福", "六福珠宝", "周生生"];
const MARKETS = [
  "国际黄金现货",
  "国际白银现货",
  "上海黄金现货",
  "上海白银现货",
];

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pctText(v) {
  if (v === null || !Number.isFinite(v)) return "--";
  const x = round2(v);
  return (x >= 0 ? "+" : "") + x + "%";
}

function priceText(v) {
  return v === null || !Number.isFinite(v) ? "--" : "¥" + round2(v);
}

// 增强版 response 读取逻辑
async function readText(resp) {
  try {
    if (!resp) return "";
    if (typeof resp === "string") return resp;
    if (resp.data) {
      if (typeof resp.data === "string") return resp.data;
      if (typeof resp.data === "object") return JSON.stringify(resp.data);
    }
    if (typeof resp.text === "function") {
      const t = await resp.text();
      if (typeof t === "string") return t;
    }
    if (typeof resp.body === "string") return resp.body;
    if (resp.body && typeof resp.body.text === "function") {
      return await resp.body.text();
    }
  } catch (e) {
    console.log("【贵金属】readText解析处理: " + e.message);
  }
  return "";
}

// 宽泛化匹配金店实时价
function parseShopRealtime(html) {
  const out = {};
  for (const name of SHOPS) {
    try {
      // 匹配金店名称附近包含数字的单元格
      const reg = new RegExp(name + "[\\s\\S]{0,300}?([0-9]{3,4}(?:\\.[0-9]+)?)", "i");
      const m = html.match(reg);
      if (m && m[1]) {
        const val = toNum(m[1]);
        if (val && val > 200) out[name] = val; // 金价通常大于200
      }
    } catch (e) {}
  }
  return out;
}

function parseShopAvg30(html) {
  const out = {};
  for (const name of SHOPS) {
    try {
      const encoded = name
        .split("")
        .map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
        .join("");

      const re = new RegExp('"name":"' + encoded + '","series":\\[([\\s\\S]*?)\\]\\}');
      const mm = html.match(re);
      if (!mm || !mm[1]) continue;

      const vals = [];
      const vr = /"value":(null|[\d.]+)/g;
      let vm;
      while ((vm = vr.exec(mm[1])) !== null) {
        const v = toNum(vm[1]);
        if (v !== null) vals.push(v);
      }
      const a = avg(vals);
      if (a !== null) out[name] = round2(a);
    } catch (e) {}
  }
  return out;
}

// 容错性更高的现货数据解析
function parseMarketsCnyPerGram(html) {
  const out = {};
  for (const n of MARKETS) {
    try {
      // 提取行情名称后连续匹配到的数字
      const reg = new RegExp(n + "[\\s\\S]{0,300}?([0-9]+(?:\\.[0-9]+)?)[\\s\\S]{0,100}?([0-9]+(?:\\.[0-9]+)?)", "i");
      const m = html.match(reg);
      if (m) {
        out[n] = {
          tradeRaw: toNum(m[1]),
          cnyPerGram: toNum(m[2]) || toNum(m[1]), // 降级兜底
        };
      }
    } catch (e) {}
  }
  return out;
}

function parseUpdate(html) {
  const m = html.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : "";
}

async function fetchUsdCnh(ctx) {
  try {
    const u = "https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43";
    const r = await ctx.http.get(u, { timeout: 8000 });
    const t = await readText(r);
    const j = typeof t === "object" ? t : JSON.parse(t);
    const raw = j && j.data ? toNum(j.data.f43) : null;
    return raw ? raw / 10000 : null;
  } catch (e) {
    console.log("【贵金属】汇率获取失败: " + e.message);
    return null;
  }
}

async function fetchIntlGoldAvg30Cny(ctx, usdcnh) {
  try {
    if (!usdcnh) return null;
    const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=122.XAU&klt=101&fqt=0&lmt=30&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58";
    const r = await ctx.http.get(url, { timeout: 8000 });
    const t = await readText(r);
    const j = typeof t === "object" ? t : JSON.parse(t);
    const lines = j && j.data && j.data.klines ? j.data.klines : null;
    if (!lines || lines.length === 0) return null;

    const vals = [];
    for (let i = 0; i < lines.length; i++) {
      const p = String(lines[i]).split(",");
      if (p.length < 3) continue;
      const closeUsdPerOz = toNum(p[2]);
      if (closeUsdPerOz === null) continue;
      const cnyPerGram = (closeUsdPerOz * usdcnh) / 31.1034768;
      vals.push(cnyPerGram);
    }
    const a = avg(vals);
    return a === null ? null : round2(a);
  } catch (e) {
    console.log("【贵金属】国际黄金30日均价获取失败: " + e.message);
    return null;
  }
}

function buildData(html) {
  const shopRt = parseShopRealtime(html);
  const shopAvg = parseShopAvg30(html);
  const markets = parseMarketsCnyPerGram(html);

  const shops = [];
  for (let i = 0; i < SHOPS.length; i++) {
    const name = SHOPS[i];
    const p = shopRt[name] !== undefined ? shopRt[name] : null;
    const a = shopAvg[name] !== undefined ? shopAvg[name] : null;
    let diff = null;
    if (p !== null && a !== null && a > 0) diff = ((p - a) / a) * 100;
    shops.push({ name, price: p, avg30: a, diffPct: diff });
  }

  return {
    shops,
    markets,
    update: parseUpdate(html),
  };
}

function errorWidget(msg) {
  return {
    type: "widget",
    padding: 14,
    backgroundColor: "#1A1A2E",
    children: [
      { type: "spacer" },
      {
        type: "image",
        src: "sf-symbol:exclamationmark.triangle.fill",
        width: 22,
        height: 22,
        color: "#FF453A",
      },
      { type: "spacer", length: 6 },
      {
        type: "text",
        text: "贵金属数据暂不可用",
        font: { size: 13, weight: "semibold" },
        textColor: "#FFFFFF",
      },
      {
        type: "text",
        text: msg || "请稍后刷新",
        font: { size: 11 },
        textColor: "#FFFFFF99",
      },
      { type: "spacer" },
    ],
    refreshAfter: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

function marketShortName(n) {
  if (n === "国际黄金现货") return "国际黄金";
  if (n === "国际白银现货") return "国际白银";
  if (n === "上海黄金现货") return "上海黄金";
  if (n === "上海白银现货") return "上海白银";
  return n;
}

function buildSmall(data, intlGoldToday, intlGoldAvg30) {
  const diff =
    intlGoldToday !== null && intlGoldAvg30 !== null && intlGoldAvg30 > 0
      ? ((intlGoldToday - intlGoldAvg30) / intlGoldAvg30) * 100
      : null;
  const diffColor =
    diff === null ? "#FFFFFF99" : diff >= 0 ? "#FF453A" : "#34C759"; // A股/国内习惯：红涨绿跌

  const s1 = data.shops[0];
  const s2 = data.shops[1];
  const s3 = data.shops[2];
  const m1 = data.markets["国际白银现货"];
  const m2 = data.markets["上海黄金现货"];
  const m3 = data.markets["上海白银现货"];

  return {
    type: "widget",
    direction: "column",
    alignItems: "start",
    justifyContent: "start",
    padding: [0, 8, 3, 8],
    gap: 0,
    backgroundGradient: {
      type: "linear",
      colors: ["#111329", "#1A1F45", "#252B5C"],
      stops: [0, 0.55, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    refreshAfter: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    children: [
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:chart.line.uptrend.xyaxis",
            width: 11,
            height: 11,
            color: "#FFD60A",
          },
          { type: "spacer", length: 2 },
          {
            type: "text",
            text: "金银看板（元/克）",
            font: { size: 15, weight: "semibold" },
            textColor: "#FFFFFF",
            lineLimit: 1,
          },
        ],
      },
      {
        type: "text",
        text: "国际黄金",
        font: { size: 9.2, weight: "medium" },
        textColor: "#FFFFFFC7",
        lineLimit: 1,
      },
      {
        type: "stack",
        direction: "row",
        alignItems: "end",
        children: [
          {
            type: "text",
            text: priceText(intlGoldToday),
            font: { size: 17, weight: "bold" },
            textColor: "#FFD60A",
            minScale: 0.72,
            lineLimit: 1,
          },
          { type: "spacer" },
          {
            type: "text",
            text: "30日均 " + priceText(intlGoldAvg30),
            font: { size: 8.8 },
            textColor: "#FFFFFFB3",
            lineLimit: 1,
            minScale: 0.8,
          },
        ],
      },
      {
        type: "text",
        text: "较30日均价 " + pctText(diff),
        font: { size: 9.5, weight: "medium" },
        textColor: diffColor,
        lineLimit: 1,
      },
      { type: "spacer", length: 1 },
      {
        type: "text",
        text:
          "周大福" +
          priceText(s1 ? s1.price : null) +
          "  六福" +
          priceText(s2 ? s2.price : null) +
          "  周生生" +
          priceText(s3 ? s3.price : null),
        font: { size: 7.8 },
        textColor: "#FFFFFFD0",
        lineLimit: 1,
        minScale: 0.82,
      },
      { type: "spacer", length: 1 },
      {
        type: "text",
        text:
          "银/沪金/沪银: " +
          priceText(m1 ? m1.cnyPerGram : null) +
          " / " +
          priceText(m2 ? m2.cnyPerGram : null) +
          " / " +
          priceText(m3 ? m3.cnyPerGram : null),
        font: { size: 7.8 },
        textColor: "#FFFFFFBC",
        lineLimit: 1,
        minScale: 0.82,
      },
      { type: "spacer" },
    ],
  };
}

function buildMedium(data, intlGoldToday, intlGoldAvg30) {
  const diff =
    intlGoldToday !== null && intlGoldAvg30 !== null && intlGoldAvg30 > 0
      ? ((intlGoldToday - intlGoldAvg30) / intlGoldAvg30) * 100
      : null;
  const diffColor =
    diff === null ? "#FFFFFF99" : diff >= 0 ? "#FF453A" : "#34C759";

  const shopRows = [];
  for (let i = 0; i < data.shops.length; i++) {
    const s = data.shops[i];
    shopRows.push({
      type: "stack",
      direction: "row",
      alignItems: "center",
      children: [
        {
          type: "text",
          text: s.name,
          font: { size: 10.5, weight: "medium" },
          textColor: "#FFFFFFE3",
          lineLimit: 1,
        },
        { type: "spacer" },
        {
          type: "text",
          text: priceText(s.price),
          font: { size: 10.8, weight: "semibold" },
          textColor: "#FFD60A",
          lineLimit: 1,
        },
      ],
    });
  }

  const marketRows = [];
  for (let i = 0; i < MARKETS.length; i++) {
    const n = MARKETS[i];
    const m = data.markets[n];
    marketRows.push({
      type: "stack",
      direction: "row",
      alignItems: "center",
      children: [
        {
          type: "text",
          text: marketShortName(n),
          font: { size: 10.3 },
          textColor: "#FFFFFFD0",
          lineLimit: 1,
        },
        { type: "spacer" },
        {
          type: "text",
          text: priceText(m ? m.cnyPerGram : null),
          font: { size: 10.3, weight: "semibold" },
          textColor: "#64D2FF",
          lineLimit: 1,
        },
      ],
    });
  }

  return {
    type: "widget",
    direction: "column",
    alignItems: "start",
    justifyContent: "start",
    padding: [0, 10, 4, 10],
    gap: 0,
    backgroundGradient: {
      type: "linear",
      colors: ["#111329", "#1A1F45", "#252B5C"],
      stops: [0, 0.55, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    refreshAfter: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    children: [
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:crown.fill",
            width: 12,
            height: 12,
            color: "#FFD60A",
          },
          { type: "spacer", length: 2 },
          {
            type: "text",
            text: "金银看板（元/克）",
            font: { size: 12, weight: "semibold" },
            textColor: "#FFFFFF",
            lineLimit: 1,
          },
          { type: "spacer" },
          {
            type: "text",
            text: data.update ? data.update.slice(11, 16) : "",
            font: { size: 9 },
            textColor: "#FFFFFF99",
          },
        ],
      },
      {
        type: "stack",
        direction: "row",
        alignItems: "end",
        children: [
          {
            type: "text",
            text: "国际黄金 " + priceText(intlGoldToday),
            font: { size: 17, weight: "bold" },
            textColor: "#FFD60A",
            lineLimit: 1,
            minScale: 0.72,
          },
          { type: "spacer" },
          {
            type: "text",
            text: "30日均价 " + priceText(intlGoldAvg30),
            font: { size: 10 },
            textColor: "#FFFFFFB3",
            lineLimit: 1,
          },
        ],
      },
      {
        type: "text",
        text: "较30日均价 " + pctText(diff),
        font: { size: 10.5, weight: "medium" },
        textColor: diffColor,
        lineLimit: 1,
      },
      {
        type: "stack",
        direction: "row",
        gap: 10,
        children: [
          {
            type: "stack",
            direction: "column",
            gap: 1,
            flex: 1,
            children: [
              {
                type: "text",
                text: "金店（当日）",
                font: { size: 10 },
                textColor: "#FFFFFF9A",
                lineLimit: 1,
              },
              {
                type: "stack",
                direction: "column",
                gap: 1,
                children: shopRows,
              },
            ],
          },
          {
            type: "stack",
            direction: "column",
            gap: 1,
            flex: 1,
            children: [
              {
                type: "text",
                text: "现货（当日）",
                font: { size: 10 },
                textColor: "#FFFFFF9A",
                lineLimit: 1,
              },
              {
                type: "stack",
                direction: "column",
                gap: 1,
                children: marketRows,
              },
            ],
          },
        ],
      },
      { type: "spacer" },
    ],
  };
}

function buildInline(data, intlGoldToday) {
  const s1 = data.shops[0];
  const p = s1 ? priceText(s1.price) : "--";
  return {
    type: "widget",
    refreshAfter: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    children: [
      {
        type: "text",
        text: "国际金 " + priceText(intlGoldToday) + " | 周大福 " + p,
        font: { size: 12 },
      },
    ],
  };
}

export default async function (ctx) {
  const family = ctx.widgetFamily || "systemMedium";

  try {
    const resp = await ctx.http.get(PAGE_URL, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
        Referer: "https://www.ip138.com/",
      },
    });

    const html = await readText(resp);
    if (!html || html.length < 200) {
      return errorWidget("页面读取为空，请检查网络");
    }

    const data = buildData(html);

    // 优先取表内获取的国际黄金价格
    const ig = data.markets["国际黄金现货"];
    const intlGoldToday = ig && ig.cnyPerGram !== null ? ig.cnyPerGram : null;

    // 抓取离岸人民币汇率与30日均价
    const fx = await fetchUsdCnh(ctx);
    const intlGoldAvg30 = await fetchIntlGoldAvg30Cny(ctx, fx);

    if (family === "systemSmall") {
      return buildSmall(data, intlGoldToday, intlGoldAvg30);
    }
    if (family === "accessoryInline") {
      return buildInline(data, intlGoldToday);
    }

    return buildMedium(data, intlGoldToday, intlGoldAvg30);
  } catch (e) {
    console.log("【贵金属】主执行失败: " + e.message);
    return errorWidget(e.message || "解析数据失败");
  }
}
