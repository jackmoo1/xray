/**
 * Egern「网络诊断雷达」- 优化精简版
 *
 * 环境变量：
 * - POLICY：最高优先级，统一指定策略
 * - LMT：流媒体检测策略（POLICY 为空时生效）
 * - AI：AI 检测策略（POLICY 为空时生效）
 * - YS=1：IP 隐私打码（本版已不再显示 IP，保留无影响）
 * - XY：手动指定协议，如 VLESS / Trojan / HY2 / AnyTLS
 */

export default async function (ctx) {
  const env = ctx.env || {};
  const C = palette();
  const SCHEME = detectScheme(ctx);

  const POLICY = clean(env.POLICY);
  const POLICY_LABEL = POLICY || "默认规则";
  const LMT_POLICY = clean(env.LMT);
  const AI_POLICY = clean(env.AI);
  const FORCE_PROTOCOL = clean(env.XY);

  const TIMEOUT = 4500;
  const POLICY_PROBE_TIMEOUT = 1800;
  const POLICY_PROBE_BATCH_SIZE = 6;
  const REFRESH_MINUTES = 15;

  const servicePolicyCache = {};
  const policyProbeCache = {};
  const policyExitCache = {};

  // ---------- 屏幕适配 ----------
  const SCREEN_W = numberInRange(
    pick(getScreenMetric(ctx, "width"), 440),
    320, 900, 440
  );
  const SCREEN_H = numberInRange(
    pick(getScreenMetric(ctx, "height"), 956),
    568, 1400, 956
  );
  const WIDTH_SCALE = SCREEN_W / 440;
  const HEIGHT_SCALE = SCREEN_H / 956;
  const UI_SCALE = clamp(WIDTH_SCALE * 0.88 + HEIGHT_SCALE * 0.12, 0.9, 1.06);
  const FONT_SCALE = clamp(UI_SCALE, 0.9, 1.045);

  // ---------- 当前代理信息 ----------
  const CURRENT_PROXY = getCurrentProxyInfo(ctx);
  const NODE_PROTOCOL =
    protocolFromXY(FORCE_PROTOCOL) ||
    CURRENT_PROXY.protocol ||
    "未暴露";

  // ---------- 本地 IP（仅用于 NAT 检测） ----------
  const device = ctx.device || {};
  const wifi = device.wifi || {};
  const ipv4 = device.ipv4 || {};
  const localIP =
    clean(pick(ipv4.address, wifi.ip, wifi.ipAddress, device.ipAddress, device.ip)) ||
    "未获取";

  const now = new Date();

  // ---------- 缩放与样式辅助 ----------
  function S(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * UI_SCALE * 100) / 100;
  }
  function FS(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * FONT_SCALE * 100) / 100;
  }
  function scaleStyle(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return object;
    const scaled = {};
    const scaleKeys = { width: true, height: true, gap: true, borderRadius: true, borderWidth: true, length: true };
    Object.keys(object).forEach(key => {
      const value = object[key];
      if (key === "padding" && Array.isArray(value)) {
        scaled[key] = value.map(item => S(item));
      } else if (scaleKeys[key] && typeof value === "number") {
        scaled[key] = S(value);
      } else {
        scaled[key] = value;
      }
    });
    return scaled;
  }
  function uiColor(value) {
    return resolveAdaptiveColor(value, SCHEME);
  }

  // ---------- 通用请求函数 ----------
  function baseRequestOptions(extra) {
    const options = {
      timeout: TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "application/json,text/plain,text/html,*/*",
        "Cache-Control": "no-cache"
      }
    };
    if (POLICY) options.policy = POLICY;
    return Object.assign(options, extra || {});
  }

  function serviceRequestOptions(policy, extra) {
    const options = {
      timeout: TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    };
    if (policy) options.policy = policy;
    return Object.assign(options, extra || {});
  }

  function policyProbeRequestOptions(policy, extra) {
    const options = {
      timeout: POLICY_PROBE_TIMEOUT,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Cache-Control": "no-cache"
      }
    };
    if (policy) options.policy = policy;
    return Object.assign(options, extra || {});
  }

  async function getJSON(url, options) {
    try {
      const response = await ctx.http.get(url, options || baseRequestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function getText(url, options) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.get(url, options || baseRequestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        text: (await response.text()) || "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return { ok: false, status: 0, text: "", ms: Math.max(1, Date.now() - startedAt) };
    }
  }

  async function getServiceStatus(url, servicePolicy) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.get(url, serviceRequestOptions(servicePolicy));
      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return { ok: false, status: 0, ms: Math.max(1, Date.now() - startedAt) };
    }
  }

  // ---------- 策略出口 IP 查询（缓存） ----------
  async function getPolicyExit(policy) {
    const targetPolicy = clean(policy);
    const key = targetPolicy || "__DEFAULT__";
    if (!policyExitCache[key]) {
      policyExitCache[key] = (async function () {
        const urls = [
          "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" + Date.now(),
          "https://ipwho.is/?lang=zh-CN&_=" + Date.now(),
          "https://api.ipapi.is/?_=" + Date.now()
        ];
        for (let i = 0; i < urls.length; i++) {
          try {
            const response = await ctx.http.get(urls[i], serviceRequestOptions(targetPolicy, {
              headers: {
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
                Accept: "application/json,text/plain,*/*",
                "Cache-Control": "no-cache"
              }
            }));
            if (response.status < 200 || response.status >= 400) continue;
            const parsed = parsePolicyExit(await response.json());
            if (parsed && parsed.countryCode) return parsed;
          } catch (_) {}
        }
        return { ip: "", country: "", countryCode: "", city: "", region: "", label: "NET" };
      })();
    }
    return await policyExitCache[key];
  }

  function parsePolicyExit(data) {
    if (!data || typeof data !== "object") {
      return { ip: "", country: "", countryCode: "", city: "", region: "", label: "NET" };
    }
    const ip = clean(pick(data.query, data.ip, data.ip_address, getAt(data, "location.ip")));
    const rawCountry = clean(pick(data.country, data.country_name, getAt(data, "location.country")));
    const code = countryCode(pick(data.countryCode, data.country_code, getAt(data, "location.country_code"), rawCountry.length === 2 ? rawCountry : ""));
    const region = clean(pick(data.regionName, data.region, getAt(data, "location.region")));
    const city = clean(pick(data.city, getAt(data, "location.city")));
    return {
      ip, country: rawCountry, countryCode: code, city, region,
      label: code ? flag(code) + " " + code : "NET"
    };
  }

  // ---------- 策略探测 ----------
  async function probePolicy(policy) {
    const name = clean(policy);
    if (!name) return false;
    const key = name.toLowerCase();
    if (!policyProbeCache[key]) {
      policyProbeCache[key] = (async function () {
        const urls = [
          "https://cp.cloudflare.com/generate_204",
          "https://www.gstatic.com/generate_204",
          "https://www.cloudflare.com/favicon.ico"
        ].map(url => url + "?_=" + Date.now() + randomAlphaNum(5));
        for (let i = 0; i < urls.length; i++) {
          try {
            const response = await ctx.http.get(urls[i], policyProbeRequestOptions(name));
            if (response.status >= 200 && response.status < 500) return true;
          } catch (_) {}
        }
        return false;
      })();
    }
    return await policyProbeCache[key];
  }

  async function firstWorkingPolicy(candidates) {
    const list = dedupeCandidates(candidates);
    for (let start = 0; start < list.length; start += POLICY_PROBE_BATCH_SIZE) {
      const batch = list.slice(start, start + POLICY_PROBE_BATCH_SIZE);
      const results = await Promise.all(batch.map(p => probePolicy(p)));
      for (let i = 0; i < results.length; i++) {
        if (results[i]) return batch[i];
      }
    }
    return "";
  }

  async function resolveServicePolicy(serviceId, category) {
    const id = clean(serviceId).toLowerCase();
    const type = clean(category).toLowerCase();
    const cacheKey = type + ":" + id;
    if (Object.prototype.hasOwnProperty.call(servicePolicyCache, cacheKey)) {
      return servicePolicyCache[cacheKey];
    }
    let result = "";
    if (POLICY) {
      result = POLICY;
    } else if (type === "lmt" && LMT_POLICY) {
      result = LMT_POLICY;
    } else if (type === "ai" && AI_POLICY) {
      result = AI_POLICY;
    } else {
      result = await firstWorkingPolicy(servicePolicyCandidates(id, type));
    }
    servicePolicyCache[cacheKey] = result;
    return result;
  }

  async function resolveServicePolicyMap(ids, category) {
    const entries = await Promise.all(ids.map(async id => [id, await resolveServicePolicy(id, category)]));
    const map = {};
    entries.forEach(([id, policy]) => map[id] = policy);
    return map;
  }

  // ---------- 出口信息获取（合并多个源） ----------
  async function getExit() {
    const sources = await Promise.all([
      getJSON("https://api.ipapi.is/?_=" + Date.now()),
      getJSON("http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile&_=" + Date.now()),
      getJSON("https://ipwho.is/?lang=zh-CN&_=" + Date.now()),
      getJSON("https://ipinfo.io/json?_=" + Date.now())
    ]);
    const sourceNames = ["ipapi.is", "ip-api", "ipwho.is", "ipinfo"];
    const candidates = [];
    for (let i = 0; i < sources.length; i++) {
      if (!sources[i].ok || !sources[i].data) continue;
      const parsed = parseExitSource(sources[i].data, sourceNames[i]);
      if (parsed.ip) candidates.push(parsed);
    }
    let merged = mergeExitSources(candidates);
    if (!merged.ip || merged.ip === "未识别") {
      return { ip: "未识别", city: "出口检测失败", region: "", country: "", countryCode: "", isp: "未知组织", kind: "未知网络", flags: {} };
    }
    const proxyCheck = await getProxyCheck(merged.ip);
    if (proxyCheck && proxyCheck.ip) {
      merged = mergeExitSources([merged, proxyCheck]);
    }
    return merged;
  }

  async function getProxyCheck(ip) {
    const target = clean(ip);
    if (!target || target === "未识别") return null;
    const result = await getJSON("https://proxycheck.io/v2/" + encodeURIComponent(target) + "?vpn=1&asn=1&risk=1&time=1&_=" + Date.now());
    if (!result.ok || !result.data) return null;
    return parseProxyCheck(result.data, target);
  }

  function parseExitSource(data, sourceName) {
    if (!data || typeof data !== "object") return {};
    const ip = clean(pick(data.ip, data.query, data.ip_address, getAt(data, "location.ip")));
    if (!ip) return {};
    const isp = clean(pick(getAt(data, "company.name"), getAt(data, "connection.isp"), getAt(data, "connection.org"), getAt(data, "asn.name"), data.isp, data.org, data.organization, data.asname, data.as, "未知组织"));
    const orgText = [isp, data.org, data.organization, data.as, data.asname, getAt(data, "company.name"), getAt(data, "asn.name"), getAt(data, "connection.org"), getAt(data, "connection.isp")].join(" ");
    const cloud = cloudProviderFromText(orgText);
    const flags = {
      datacenter: truthy(pick(data.is_datacenter, data.hosting, getAt(data, "security.is_datacenter"), getAt(data, "company.is_datacenter"))) || cloud.hit,
      hosting: truthy(pick(data.hosting, data.is_hosting, getAt(data, "security.is_hosting"))) || cloud.hit,
      cloud: cloud.hit,
      proxy: truthy(pick(data.proxy, data.is_proxy, getAt(data, "security.is_proxy"), getAt(data, "security.proxy"))),
      vpn: truthy(pick(data.is_vpn, getAt(data, "security.is_vpn"), getAt(data, "security.vpn"))),
      tor: truthy(pick(data.is_tor, getAt(data, "security.is_tor"), getAt(data, "security.tor"))),
      abuser: truthy(pick(data.is_abuser, getAt(data, "security.is_abuser"))),
      mobile: truthy(pick(data.mobile, data.is_mobile, getAt(data, "connection.mobile"))),
      residential: false,
      risk: numberOrNull(pick(data.risk, getAt(data, "security.risk"), getAt(data, "risk.score")))
    };
    const rawType = clean(pick(getAt(data, "company.type"), getAt(data, "connection.type"), getAt(data, "asn.type"))).toLowerCase();
    if (rawType.includes("isp") || rawType.includes("residential") || rawType.includes("broadband")) flags.residential = true;
    if (rawType.includes("hosting") || rawType.includes("datacenter") || rawType.includes("cloud")) { flags.datacenter = true; flags.hosting = true; }
    const rawCountry = clean(pick(getAt(data, "location.country"), data.country_name, data.country));
    return {
      source: sourceName || "",
      ip,
      city: clean(pick(getAt(data, "location.city"), data.city, getAt(data, "location.region"), data.regionName, data.region, "未知城市")),
      region: clean(pick(getAt(data, "location.region"), data.regionName, data.region)),
      country: rawCountry.length === 2 ? "" : rawCountry,
      countryCode: countryCode(pick(getAt(data, "location.country_code"), data.country_code, data.countryCode, rawCountry.length === 2 ? rawCountry : "")),
      isp: cloud.name || isp,
      cloudProvider: cloud.name,
      kind: classifyExitKind(flags),
      flags
    };
  }

  function parseProxyCheck(data, ip) {
    if (!data || typeof data !== "object") return null;
    const target = clean(ip);
    const keys = Object.keys(data);
    const fallbackKey = keys.find(k => k !== "status" && k !== "message");
    const item = data[target] || data[fallbackKey];
    if (!item || typeof item !== "object") return null;
    const typeText = clean(pick(item.type, item.proxy, item.provider, item.organisation, item.asn, item.operator));
    const orgText = [item.provider, item.organisation, item.operator, item.asn, item.type].join(" ");
    const cloud = cloudProviderFromText(orgText);
    const proxyValue = clean(item.proxy).toLowerCase();
    const typeLower = typeText.toLowerCase();
    const flags = {
      datacenter: cloud.hit || typeLower.includes("hosting") || typeLower.includes("server") || typeLower.includes("business"),
      hosting: cloud.hit || typeLower.includes("hosting") || typeLower.includes("server"),
      cloud: cloud.hit,
      proxy: proxyValue === "yes" || typeLower.includes("proxy"),
      vpn: typeLower.includes("vpn"),
      tor: typeLower.includes("tor"),
      abuser: typeLower.includes("abuse") || typeLower.includes("blacklist") || typeLower.includes("spam"),
      mobile: typeLower.includes("mobile"),
      residential: typeLower.includes("residential"),
      risk: numberOrNull(item.risk)
    };
    return {
      source: "proxycheck.io",
      ip: target,
      city: clean(item.city),
      region: clean(item.region),
      country: clean(item.country),
      countryCode: countryCode(item.isocode),
      isp: clean(pick(cloud.name, item.provider, item.organisation, item.operator, "未知组织")),
      cloudProvider: cloud.name,
      kind: classifyExitKind(flags),
      flags
    };
  }

  function mergeExitSources(sources) {
    const valid = (sources || []).filter(item => item && item.ip);
    if (valid.length === 0) {
      return { ip: "未识别", city: "出口检测失败", region: "", country: "", countryCode: "", isp: "未知组织", kind: "未知网络", flags: {} };
    }
    const primaryIP = mostCommon(valid.map(item => item.ip)) || valid[0].ip;
    const sameIP = valid.filter(item => item.ip === primaryIP);
    const allText = sameIP.map(item => [item.isp, item.cloudProvider, item.country, item.city, item.region].join(" ")).join(" ");
    const cloud = cloudProviderFromText(allText);
    const evidence = {
      sourceCount: sameIP.length,
      datacenterCount: 0, hostingCount: 0, cloudCount: cloud.hit ? 1 : 0,
      proxyCount: 0, vpnCount: 0, torCount: 0, abuserCount: 0, mobileCount: 0, residentialCount: 0,
      riskMax: null, riskCount: 0
    };
    sameIP.forEach(item => {
      const f = item.flags || {};
      if (f.datacenter) evidence.datacenterCount++;
      if (f.hosting) evidence.hostingCount++;
      if (f.cloud) evidence.cloudCount++;
      if (f.proxy) evidence.proxyCount++;
      if (f.vpn) evidence.vpnCount++;
      if (f.tor) evidence.torCount++;
      if (f.abuser) evidence.abuserCount++;
      if (f.mobile) evidence.mobileCount++;
      if (f.residential) evidence.residentialCount++;
      if (Number.isFinite(Number(f.risk))) {
        evidence.riskCount++;
        evidence.riskMax = Math.max(Number(evidence.riskMax || 0), Number(f.risk));
      }
    });
    const mergedFlags = {
      datacenter: evidence.datacenterCount > 0,
      hosting: evidence.hostingCount > 0,
      cloud: evidence.cloudCount > 0,
      proxy: evidence.proxyCount > 0,
      vpn: evidence.vpnCount > 0,
      tor: evidence.torCount > 0,
      abuser: evidence.abuserCount > 0,
      mobile: evidence.mobileCount > 0,
      residential: evidence.residentialCount > 0,
      risk: evidence.riskMax,
      evidence: evidence
    };
    if (cloud.hit) {
      mergedFlags.datacenter = true;
      mergedFlags.hosting = true;
      mergedFlags.cloud = true;
      mergedFlags.residential = false;
    }
    const kind = classifyExitKind(mergedFlags);
    return {
      ip: primaryIP,
      city: bestField(sameIP, "city") || "未知城市",
      region: bestField(sameIP, "region"),
      country: bestField(sameIP, "country"),
      countryCode: countryCode(bestField(sameIP, "countryCode")),
      isp: cloud.name || bestField(sameIP, "isp") || "未知组织",
      cloudProvider: cloud.name,
      kind,
      flags: mergedFlags,
      sources: sameIP.map(item => item.source).filter(Boolean)
    };
  }

  function classifyExitKind(flags) {
    const f = flags || {};
    if (f.mobile) return "移动网络";
    if (f.residential) return "住宅 IP";
    if (f.datacenter || f.hosting || f.cloud) return "商业机房";
    if (f.proxy || f.vpn) return "住宅 IP";
    return "未知网络";
  }

  function cloudProviderFromText(value) {
    const text = clean(value).toLowerCase();
    if (!text) return { hit: false, name: "" };
    const providers = [
      ["oracle", "Oracle"], ["oci", "Oracle"],
      ["amazon", "AWS"], ["aws", "AWS"],
      ["google cloud", "Google Cloud"], ["google llc", "Google"],
      ["microsoft", "Microsoft Azure"], ["azure", "Microsoft Azure"],
      ["digitalocean", "DigitalOcean"], ["vultr", "Vultr"],
      ["linode", "Akamai Linode"], ["akamai", "Akamai"],
      ["ovh", "OVH"], ["hetzner", "Hetzner"],
      ["leaseweb", "Leaseweb"], ["m247", "M247"],
      ["choopa", "Vultr"], ["contabo", "Contabo"],
      ["scaleway", "Scaleway"], ["hivelocity", "Hivelocity"],
      ["cloudflare", "Cloudflare"],
      ["tencent cloud", "Tencent Cloud"], ["alibaba cloud", "Alibaba Cloud"],
      ["aliyun", "Alibaba Cloud"], ["alicloud", "Alibaba Cloud"],
      ["huawei cloud", "Huawei Cloud"], ["volcengine", "Volcengine"],
      ["ucloud", "UCLOUD"], ["uccloud", "UCLOUD"]
    ];
    for (let i = 0; i < providers.length; i++) {
      if (text.includes(providers[i][0])) return { hit: true, name: providers[i][1] };
    }
    return { hit: false, name: "" };
  }

  function mostCommon(values) {
    const count = {};
    let best = "", bestCount = 0;
    values.map(clean).filter(Boolean).forEach(v => {
      count[v] = (count[v] || 0) + 1;
      if (count[v] > bestCount) { best = v; bestCount = count[v]; }
    });
    return best;
  }

  function bestField(items, field) {
    const values = (items || []).map(item => clean(item[field])).filter(Boolean);
    return mostCommon(values) || values[0] || "";
  }

  function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // ---------- 延迟测量 ----------
  async function getProxyLatency() {
    const urls = [
      "https://cp.cloudflare.com/generate_204",
      "https://www.gstatic.com/generate_204",
      "https://www.google.com/generate_204",
      "https://www.cloudflare.com/favicon.ico"
    ];
    const results = await Promise.all(urls.map(url => latencyProbe(url)));
    const passed = results.filter(r => r.ok && r.ms > 0).sort((a, b) => a.ms - b.ms);
    if (passed.length === 0) return { ok: false, ms: 0, target: "" };
    return { ok: true, ms: passed[0].ms, target: passed[0].url };
  }

  async function latencyProbe(url) {
    const startedAt = Date.now();
    try {
      const response = await ctx.http.get(url, baseRequestOptions());
      return { ok: response.status >= 200 && response.status < 400, status: response.status, ms: Math.max(1, Date.now() - startedAt), url };
    } catch (_) {
      return { ok: false, status: 0, ms: Math.max(1, Date.now() - startedAt), url };
    }
  }

  // ---------- DNS 策略延迟测量 ----------
  async function getDNSLatency() {
    const url = "https://1.1.1.1/cdn-cgi/trace";
    const start = Date.now();
    try {
      await ctx.http.get(url, { timeout: 3000 });
      return Math.max(1, Date.now() - start);
    } catch {
      return 0;
    }
  }

  // ---------- QUIC 检测 ----------
  async function getQuic() {
    const urls = [
      "https://cloudflare-quic.com/cdn-cgi/trace",
      "https://cloudflare.com/cdn-cgi/trace",
      "https://www.cloudflare.com/cdn-cgi/trace",
      "https://one.one.one.one/cdn-cgi/trace",
      "https://1.1.1.1/cdn-cgi/trace"
    ].map(url => url + "?_=" + Date.now() + randomAlphaNum(5));
    const results = await Promise.all(urls.map(url => getText(url)));
    let hasH3 = false, hasReachable = false;
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      if (!item || !item.ok) continue;
      hasReachable = true;
      const trace = parseTrace(item.text);
      const protocol = clean(trace.http).toLowerCase();
      if (protocol === "h3" || protocol === "http3" || protocol === "http/3" || protocol.includes("h3") || protocol.includes("http/3")) {
        hasH3 = true;
        break;
      }
    }
    if (hasH3) return { value: "✓/✓", tone: "green" };
    return { value: "×/×", tone: hasReachable ? "amber" : "red" };
  }

  function parseTrace(text) {
    const lines = (text || "").split("\n");
    const result = {};
    lines.forEach(line => {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim();
        result[k] = v;
      }
    });
    return result;
  }

  // ---------- 单个服务检测 ----------
  async function testService(id, name, kind, color, url, servicePolicy) {
    const serviceExitPromise = getPolicyExit(servicePolicy);
    if (!url) {
      const emptyExit = await serviceExitPromise;
      return { id, name, kind, color, ok: false, policy: servicePolicy || "", countryCode: emptyExit.countryCode || "", country: emptyExit.country || "", exit: emptyExit };
    }
    const separator = url.includes("?") ? "&" : "?";
    const [result, serviceExit] = await Promise.all([
      getServiceStatus(url + separator + "_=" + Date.now(), servicePolicy),
      serviceExitPromise
    ]);
    return { id, name, kind, color, ok: result.ok, policy: servicePolicy || "", countryCode: serviceExit.countryCode || "", country: serviceExit.country || "", exit: serviceExit };
  }

  // ---------- 纯净评分 ----------
  function purityScore(exit) {
    const flags = (exit && exit.flags) || {};
    const evidence = flags.evidence || {};
    const kind = clean(exit && exit.kind);
    let score = 72;
    if (kind === "住宅 IP" || kind === "移动网络") score = 92;
    else if (kind === "教育网络" || kind === "企业网络") score = 88;
    else if (kind === "商业机房") score = 78;

    const proxyCount = Number(evidence.proxyCount || 0);
    const vpnCount = Number(evidence.vpnCount || 0);
    const torCount = Number(evidence.torCount || 0);
    const abuserCount = Number(evidence.abuserCount || 0);
    const riskValue = Number(flags.risk);
    const proxyVpnEvidenceCount = proxyCount + vpnCount;

    if (torCount > 0 || flags.tor) score -= 55;
    if (abuserCount > 0 || flags.abuser) score -= 35;
    if (proxyVpnEvidenceCount >= 2) score -= 30;
    else if (proxyVpnEvidenceCount === 1) score -= 16;
    if (Number.isFinite(riskValue)) {
      if (riskValue >= 80) score -= 25;
      else if (riskValue >= 70) score -= 20;
      else if (riskValue >= 40) score -= 10;
      else if (riskValue >= 20) score -= 4;
    }
    if (kind === "商业机房" || flags.datacenter || flags.hosting || flags.cloud) score -= 8;
    if ((kind === "住宅 IP" || kind === "移动网络") && !flags.proxy && !flags.vpn && !flags.tor && !flags.abuser) score += 3;
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score, risk: 100 - score, evidence };
  }

  function riskLevel(exit, purity) {
    const score = purity ? purity.score : 0;
    if (score >= 80) return "低风险";
    if (score >= 50) return "中风险";
    return "高风险";
  }

  // ---------- 当前代理信息提取 ----------
  function getCurrentProxyInfo(ctx) {
    const proxyName = clean(pick(
      getAt(ctx, "node.name"), getAt(ctx, "proxy.name"), getAt(ctx, "currentProxy.name"),
      getAt(ctx, "selectedProxy.name"), getAt(ctx, "selectedNode.name"),
      getAt(ctx, "policy.node.name"), getAt(ctx, "policy.selected.name"), getAt(ctx, "policy.current.name"),
      getAt(ctx, "outbound.name"), getAt(ctx, "profile.currentNode.name"), getAt(ctx, "profile.selectedNode.name"),
      findProxyNameInObject(ctx)
    ));
    const rawProtocol = clean(pick(
      getAt(ctx, "node.protocol"), getAt(ctx, "node.type"), getAt(ctx, "node.scheme"),
      getAt(ctx, "proxy.protocol"), getAt(ctx, "proxy.type"), getAt(ctx, "proxy.scheme"),
      getAt(ctx, "currentProxy.protocol"), getAt(ctx, "currentProxy.type"), getAt(ctx, "currentProxy.scheme"),
      getAt(ctx, "selectedProxy.protocol"), getAt(ctx, "selectedProxy.type"), getAt(ctx, "selectedProxy.scheme"),
      getAt(ctx, "selectedNode.protocol"), getAt(ctx, "selectedNode.type"), getAt(ctx, "selectedNode.scheme"),
      getAt(ctx, "policy.node.protocol"), getAt(ctx, "policy.node.type"), getAt(ctx, "policy.selected.protocol"),
      getAt(ctx, "policy.selected.type"), getAt(ctx, "policy.current.protocol"), getAt(ctx, "policy.current.type"),
      getAt(ctx, "outbound.protocol"), getAt(ctx, "outbound.type"), getAt(ctx, "outbound.scheme"),
      getAt(ctx, "profile.currentNode.protocol"), getAt(ctx, "profile.currentNode.type"),
      getAt(ctx, "profile.selectedNode.protocol"), getAt(ctx, "profile.selectedNode.type"),
      findProtocolInObject(ctx)
    ));
    const protocol = normalizeProxyProtocol(rawProtocol) || normalizeProxyProtocol(proxyName);
    return { name: proxyName, protocol };
  }

  function findProtocolInObject(object) {
    const found = [], seen = [];
    function walk(value, path, depth) {
      if (depth > 5 || !value || typeof value !== "object" || seen.indexOf(value) >= 0) return;
      seen.push(value);
      Object.keys(value).forEach(key => {
        const next = value[key];
        const nextPath = path ? path + "." + key : key;
        const lowerPath = nextPath.toLowerCase();
        if (typeof next === "string") {
          const protocol = normalizeProxyProtocol(next);
          if (protocol && (lowerPath.includes("proxy") || lowerPath.includes("node") || lowerPath.includes("outbound") || lowerPath.includes("policy") || lowerPath.includes("protocol") || lowerPath.includes("scheme"))) {
            found.push(protocol);
          }
        } else if (next && typeof next === "object") {
          walk(next, nextPath, depth + 1);
        }
      });
    }
    walk(object, "", 0);
    return found[0] || "";
  }

  function findProxyNameInObject(object) {
    const found = [], seen = [];
    function walk(value, path, depth) {
      if (depth > 5 || !value || typeof value !== "object" || seen.indexOf(value) >= 0) return;
      seen.push(value);
      Object.keys(value).forEach(key => {
        const next = value[key];
        const nextPath = path ? path + "." + key : key;
        const lowerPath = nextPath.toLowerCase();
        if (typeof next === "string") {
          if (isMeaningful(next) && (lowerPath.includes("proxy") || lowerPath.includes("node") || lowerPath.includes("outbound") || lowerPath.includes("policy")) && (lowerPath.includes("name") || lowerPath.includes("title"))) {
            found.push(next);
          }
        } else if (next && typeof next === "object") {
          walk(next, nextPath, depth + 1);
        }
      });
    }
    walk(object, "", 0);
    return found[0] || "";
  }

  function protocolFromXY(value) {
    const raw = clean(value);
    if (!raw) return "";
    return normalizeProxyProtocol(raw) || raw;
  }

  function normalizeProxyProtocol(value) {
    const raw = clean(value);
    const text = raw.toLowerCase();
    if (!text) return "";
    const normalized = text.replace(/[_\-]+/g, " ").replace(/[()[\]{}|,;]+/g, " ");
    const checks = [
      [/vless/, "VLESS"], [/vmess/, "VMESS"], [/trojan/, "Trojan"],
      [/shadowsocks\s*r|ssr/, "SSR"], [/shadowsocks|(^|\s)ss($|\s)/, "SS"],
      [/hysteria\s*2|hy2/, "HY2"], [/hysteria/, "Hysteria"],
      [/tuic/, "TUIC"], [/snell/, "Snell"], [/any\s*tls|anytls/, "AnyTLS"],
      [/wireguard|(^|\s)wg($|\s)/, "WireGuard"], [/socks\s*5|socks5/, "SOCKS5"],
      [/socks/, "SOCKS"], [/http\s*2|h2/, "HTTP/2"], [/https/, "HTTPS"],
      [/http/, "HTTP"], [/ssh/, "SSH"], [/mieru/, "Mieru"], [/juicity/, "Juicity"],
      [/shadow\s*tls|shadowtls/, "ShadowTLS"], [/naive/, "Naive"], [/brook/, "Brook"]
    ];
    for (let i = 0; i < checks.length; i++) {
      if (checks[i][0].test(normalized)) return checks[i][1];
    }
    return "";
  }

  // 辅助判断（仅用于提取代理名时过滤无效值）
  function isMeaningful(v) {
    const s = clean(v);
    if (!s) return false;
    const lower = s.toLowerCase();
    if (["--", "-", "—", "null", "undefined", "unknown", "unknow", "none", "n/a", "wifi", "wlan", "5g", "4g", "lte", "nr"].includes(lower)) return false;
    return true;
  }

  // ---------- 工具函数 ----------
  function clean(v) {
    if (v === null || v === undefined) return "";
    return String(v).trim();
  }

  function pick() {
    for (let i = 0; i < arguments.length; i++) {
      const v = clean(arguments[i]);
      if (v) return v;
    }
    return "";
  }

  function getAt(obj, path) {
    if (!obj || typeof obj !== "object") return undefined;
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function truthy(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v > 0;
    const s = clean(v).toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }

  function countryCode(v) {
    const c = clean(v).toUpperCase();
    return c.length === 2 ? c : "";
  }

  function flag(code) {
    const cc = countryCode(code);
    if (!cc) return "";
    return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
  }

  function detectNAT(localIP, exitIP) {
    if (!localIP || !exitIP || localIP === "未获取" || exitIP === "未识别") {
      return { label: "未知", tone: "amber" };
    }
    if (localIP === exitIP) return { label: "公网IP", tone: "green" };
    return { label: "NAT型", tone: "blue" };
  }

  function toneColor(tone, C) {
    if (tone === "green") return C.green;
    if (tone === "amber") return C.amber;
    if (tone === "blue") return C.blue;
    if (tone === "purple") return C.purple;
    return C.red;
  }

  function shortISP(v) {
    const s = clean(v);
    if (!s) return "未知组织";
    return s.length > 12 ? s.slice(0, 10) + "..." : s;
  }

  function timeLabel(date) {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

  function dateLabel(date) {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return m + "月" + d + "日";
  }

  function detectScheme(ctx) {
    return getAt(ctx, "scheme") || getAt(ctx, "colorScheme") || "dark";
  }

  function resolveAdaptiveColor(colorObj, scheme) {
    if (!colorObj || typeof colorObj !== "object") return colorObj;
    return scheme === "light" ? colorObj.light : colorObj.dark;
  }

  function getScreenMetric(ctx, key) {
    return getAt(ctx, "screen." + key) || getAt(ctx, "device.screen." + key);
  }

  function numberInRange(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function randomAlphaNum(len) {
    let result = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < len; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // ---------- 节点名称地区提取 ----------
  function extractLocation(name) {
    const text = clean(name).toLowerCase();
    const map = {
      "香港": { flag: "🇭🇰", name: "香港" }, "hk": { flag: "🇭🇰", name: "香港" },
      "台湾": { flag: "🇹🇼", name: "台湾" }, "tw": { flag: "🇹🇼", name: "台湾" },
      "美国": { flag: "🇺🇸", name: "美国" }, "us": { flag: "🇺🇸", name: "美国" },
      "日本": { flag: "🇯🇵", name: "日本" }, "jp": { flag: "🇯🇵", name: "日本" },
      "新加坡": { flag: "🇸🇬", name: "新加坡" }, "sg": { flag: "🇸🇬", name: "新加坡" },
      "英国": { flag: "🇬🇧", name: "英国" }, "uk": { flag: "🇬🇧", name: "英国" },
      "韩国": { flag: "🇰🇷", name: "韩国" }, "kr": { flag: "🇰🇷", name: "韩国" },
      "澳大利亚": { flag: "🇦🇺", name: "澳大利亚" }, "au": { flag: "🇦🇺", name: "澳大利亚" },
      "德国": { flag: "🇩🇪", name: "德国" }, "de": { flag: "🇩🇪", name: "德国" },
      "法国": { flag: "🇫🇷", name: "法国" }, "fr": { flag: "🇫🇷", name: "法国" },
      "加拿大": { flag: "🇨🇦", name: "加拿大" }, "ca": { flag: "🇨🇦", name: "加拿大" }
    };
    for (const [key, val] of Object.entries(map)) {
      if (text.includes(key) || text === key) return val;
    }
    return { flag: "🌐", name: text.slice(0, 6) || "未知节点" };
  }

  // ---------- 策略候选匹配 ----------
  function servicePolicyCandidates(serviceId, category) {
    const id = clean(serviceId).toLowerCase();
    const type = clean(category).toLowerCase();

    const commonLMT = [
      "LMT", "流媒体", "流媒体解锁", "流媒体服务", "流媒体策略", "流媒体节点",
      "全球流媒体", "国际流媒体", "国外流媒体", "海外流媒体", "全球媒体", "国际媒体",
      "国外媒体", "海外媒体", "媒体", "媒体服务", "媒体解锁", "影音", "影音娱乐",
      "影音解锁", "视频", "视频服务", "视频解锁", "串流", "串流媒体", "串流媒體",
      "流媒體", "解锁", "解鎖", "国际解锁", "海外解锁", "Global Media", "International Media",
      "Overseas Media", "Media", "Media Unlock", "Unlock Media", "Streaming", "Streaming Media",
      "Streaming Unlock", "Global Streaming", "International Streaming", "Overseas Streaming",
      "Proxy Media", "Stream", "Video", "Video Streaming", "TV", "Movie", "Movies",
      "Entertainment", "NETFLIX", "Netflix", "Disney", "Disney+", "YouTube", "Spotify",
      "Prime", "Prime Video", "TikTok", "HBO", "Max", "Hulu", "Apple TV", "Apple TV+",
      "Emby", "Plex", "動畫瘋", "动画疯", "Bahamut", "Bilibili 港澳台", "哔哩哔哩港澳台",
      "港台番剧", "港台", "🎬 流媒体", "📺 流媒体", "🎥 流媒体", "🎞 流媒体", "🍿 流媒体",
      "🎬 Streaming", "📺 Streaming", "🎥 Streaming", "🎬 Media", "📺 Media", "🍿 Media"
    ];

    const commonAI = [
      "AI", "Ai", "ai", "人工智能", "人工智能服务", "AI服务", "AI 服务", "AI解锁", "AI 解锁",
      "AI平台", "AI 平台", "AI工具", "AI 工具", "AI策略", "AI 策略", "AI节点", "AI 节点",
      "AI專用", "AI专用", "AI国外", "AI海外", "全球AI", "国际AI", "国外AI", "海外AI",
      "AIGC", "AGI", "LLM", "OpenAI", "Open AI", "ChatGPT", "Chat GPT", "GPT", "GPT4",
      "GPT-4", "GPT-5", "Claude", "Anthropic", "Gemini", "Google AI", "Bard", "DeepSeek",
      "Grok", "xAI", "XAI", "Perplexity", "Copilot", "Microsoft Copilot", "Poe", "Notion AI",
      "Midjourney", "Sora", "Cursor", "AI Proxy", "AI Services", "AI Unlock", "AI Global",
      "Global AI", "International AI", "Overseas AI", "Proxy AI", "🤖 AI", "✨ AI", "🧠 AI",
      "🤖 人工智能", "✨ 人工智能", "🧠 人工智能"
    ];

    const serviceMap = {
      netflix: ["Netflix", "NETFLIX", "NetFlix", "NF", "奈飞", "奈飛", "网飞", "網飛", "Netflix 解锁", "Netflix 解鎖", "Netflix Unlock", "Netflix 专用", "Netflix 專用", "Netflix节点", "Netflix 節点", "NF解锁", "NF 解锁", "NF Unlock", "Netflix/Disney", "Netflix & Disney", "Netflix Disney", "奈飞节点", "奈飞解锁", "🎬 Netflix", "🎥 Netflix", "🍿 Netflix"],
      disney: ["Disney+", "Disney", "Disney Plus", "DisneyPlus", "D+", "DPlus", "迪士尼", "迪士尼+", "Disney 解锁", "Disney+ 解锁", "Disney Unlock", "DisneyPlus 解锁", "Disney 专用", "Disney 專用", "Disney 节点", "Disney 節点", "Disney+ 节点", "Disney+ 節点", "🎬 Disney+", "🏰 Disney+", "🎥 Disney"],
      spotify: ["Spotify", "SPOTIFY", "声破天", "聲破天", "Spotify 解锁", "Spotify Unlock", "Spotify Premium", "Spotify 专用", "Spotify 專用", "Spotify 节点", "Spotify 節点", "音乐", "音樂", "Music", "🎵 Spotify", "🎧 Spotify"],
      tiktok: ["TikTok", "Tik Tok", "TIKTOK", "TK", "抖音国际版", "抖音國際版", "国际抖音", "國際抖音", "TikTok 解锁", "TikTok Unlock", "TikTok 专用", "TikTok 專用", "TikTok 节点", "TikTok 節点", "🎵 TikTok", "🎬 TikTok"],
      youtube: ["YouTube", "Youtube", "YOUTUBE", "YT", "油管", "YouTube 解锁", "YouTube Unlock", "YouTube Premium", "YouTube Music", "YT Premium", "YT 解锁", "YT Unlock", "Google", "Google YouTube", "谷歌", "谷歌服务", "谷歌服務", "Google Services", "Google Service", "🎬 YouTube", "📺 YouTube", "▶️ YouTube"],
      prime: ["Prime", "Prime Video", "PrimeVideo", "Amazon Prime", "Amazon Video", "Amazon", "亚马逊视频", "亞馬遜視頻", "亚马逊", "亞馬遜", "Prime 解锁", "Prime Unlock", "Prime Video 解锁", "Prime Video Unlock", "Prime 专用", "Prime 專用", "Prime 节点", "Prime 節点", "🎬 Prime", "📺 Prime"],
      chatgpt: ["ChatGPT", "Chat GPT", "OpenAI", "Open AI", "GPT", "GPT4", "GPT-4", "GPT5", "GPT-5", "OpenAI 解锁", "ChatGPT 解锁", "OpenAI Unlock", "ChatGPT Unlock", "OpenAI 专用", "OpenAI 專用", "ChatGPT 专用", "ChatGPT 專用", "OpenAI 节点", "ChatGPT 节点", "🤖 ChatGPT", "🤖 OpenAI", "✨ ChatGPT"],
      claude: ["Claude", "Anthropic", "Claude AI", "Claude 解锁", "Claude Unlock", "Anthropic 解锁", "Anthropic Unlock", "Claude 专用", "Claude 專用", "Claude 节点", "Claude 節点", "🤖 Claude", "🧠 Claude"],
      gemini: ["Gemini", "Google AI", "Bard", "Google Bard", "Gemini 解锁", "Gemini Unlock", "Google AI 解锁", "Google AI Unlock", "Gemini 专用", "Gemini 專用", "Gemini 节点", "Gemini 節点", "Google", "谷歌", "谷歌 AI", "🤖 Gemini", "✨ Gemini"],
      deepseek: ["DeepSeek", "Deepseek", "DEEPSEEK", "深度求索", "DeepSeek 解锁", "DeepSeek Unlock", "DeepSeek 专用", "DeepSeek 專用", "DeepSeek 节点", "DeepSeek 節点", "🤖 DeepSeek", "🧠 DeepSeek"],
      grok: ["Grok", "grok", "GROK", "xAI", "XAI", "X AI", "Grok 解锁", "Grok Unlock", "xAI 解锁", "xAI Unlock", "Grok 专用", "Grok 專用", "Grok 节点", "Grok 節点", "X", "Twitter AI", "🤖 Grok", "✨ Grok"],
      perplexity: ["Perplexity", "PERPLEXITY", "Perplexity AI", "Perplexity 解锁", "Perplexity Unlock", "Perplexity 专用", "Perplexity 專用", "Perplexity 节点", "Perplexity 節点", "PPLX", "PPLX AI", "🤖 Perplexity", "🔎 Perplexity"]
    };

    const serviceCandidates = serviceMap[id] || [];
    return type === "ai" ? serviceCandidates.concat(commonAI) : serviceCandidates.concat(commonLMT);
  }

  function dedupeCandidates(values) {
    const seen = {}, output = [];
    (values || []).forEach(value => {
      const raw = clean(value);
      const key = raw.toLowerCase();
      if (!raw || seen[key]) return;
      seen[key] = true;
      output.push(raw);
    });
    return output;
  }

  // ---------- UI 构建 ----------
  function merge(base, extra) {
    return scaleStyle(Object.assign({}, base || {}, extra || {}));
  }

  function text(value, size, weight, color, extra) {
    return merge({
      type: "text",
      text: String(value),
      font: { size: FS(size), weight: weight || "regular" },
      textColor: color || C.text
    }, extra);
  }

  function image(symbol, color, width, height, extra) {
    return merge({
      type: "image",
      src: "sf-symbol:" + symbol,
      color: color || C.text,
      width: width || 10,
      height: height || 10
    }, extra);
  }

  function rawImage(src, width, height, extra) {
    return merge({ type: "image", src, width, height, resizable: true }, extra || {});
  }

  function svgImage(svg, width, height, extra) {
    return rawImage(svgDataURI(svg), width, height, extra);
  }

  function row(children, extra) {
    return merge({ type: "stack", direction: "row", alignItems: "center", children: children || [] }, extra);
  }

  function col(children, extra) {
    return merge({ type: "stack", direction: "column", alignItems: "start", children: children || [] }, extra);
  }

  function spacer(length) {
    return length === undefined ? { type: "spacer" } : { type: "spacer", length: S(length) };
  }

  function card(children, extra) {
    return merge({
      type: "stack",
      direction: "column",
      alignItems: "start",
      padding: [6, 7],
      gap: 4,
      backgroundColor: C.card,
      backgroundGradient: {
        type: "linear",
        colors: [C.cardTop, C.cardBottom],
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 1, y: 1 }
      },
      borderRadius: 14,
      borderWidth: 1,
      borderColor: C.cardBorder,
      children: children || []
    }, extra);
  }

  function pill(value, tone, fill, extra) {
    return row([
      text(value, 6, "semibold", tone, { maxLines: 1, minScale: 0.72, textAlign: "center" })
    ], merge({ padding: [2, 5], backgroundColor: fill, borderRadius: 8 }, extra));
  }

  function proxyTagLine(value, tone, fill) {
    return row([
      text(value, 4.7, "semibold", tone, { maxLines: 1, minScale: 0.42, textAlign: "center" })
    ], { width: 37, height: 7.2, padding: [0.7, 2.5], backgroundColor: fill, borderRadius: 4.8, alignItems: "center" });
  }

  function proxyTagRows(tagOne, tagTwo, toneOne, fillOne, toneTwo, fillTwo) {
    return col([
      proxyTagLine(tagOne, toneOne, fillOne),
      proxyTagLine(tagTwo, toneTwo, fillTwo)
    ], { width: 39, gap: 1, alignItems: "start" });
  }

  function iconBox(symbol, tone, fill, side) {
    return row([
      image(symbol, tone, Math.round(side * 0.52), Math.round(side * 0.52))
    ], { width: side, height: side, padding: 3, backgroundColor: fill, borderRadius: 12 });
  }

  function sectionTitle(symbol, title, right, tone) {
    const children = [
      image(symbol, tone, 11, 11),
      text(title, 10, "semibold", C.text, { maxLines: 1 })
    ];
    if (right) { children.push(spacer()); children.push(right); }
    return row(children, { gap: 3 });
  }

  function metricBox(symbol, label, value, tone, extra) {
    const opts = extra || {};
    return col([
      row([
        image(symbol, tone, 7, 7),
        text(label, opts.labelSize || 5, "medium", C.muted, { maxLines: 1, minScale: opts.labelMinScale || 0.72, textAlign: "center" })
      ], { gap: 1, alignItems: "center" }),
      text(value, opts.valueSize || 6.1, "semibold", tone, { maxLines: 1, minScale: opts.valueMinScale || 0.35, textAlign: "center" })
    ], { flex: 1, height: 24, padding: [0, 0], gap: 0, alignItems: "center" });
  }

  function header() {
    return row([
      row([
        iconBox("waveform.path.ecg", C.blue, C.blueSoft, 28),
        col([
          row([
            text("网络诊断雷达", 11, "bold", C.text, { maxLines: 1, minScale: 0.72 }),
            pill("Pro", C.purple, C.purpleSoft, { padding: [1, 4] })
          ], { gap: 3, alignItems: "center" }),
          text("Egern · 全面网络状态检测", 6, "medium", C.muted, { maxLines: 1, minScale: 0.78 })
        ], { flex: 1, gap: 0 })
      ], { width: 171, height: 34, gap: 6 }),
      row([
        spacer(),
        image("scope", C.purple, 11, 11),
        col([
          text("当前策略", 5, "medium", C.muted, { maxLines: 1, textAlign: "center" }),
          row([
            text(POLICY ? "●" : "○", 7, "bold", POLICY ? C.green : C.purple),
            text(POLICY_LABEL, 7, "semibold", C.text, { maxLines: 1, minScale: 0.72 })
          ], { gap: 2, alignItems: "center" })
        ], { width: 52, gap: 0, alignItems: "start" }),
        spacer()
      ], { flex: 1, height: 34, padding: [3, 0], gap: 3 }),
      col([
        text(timeLabel(now), 11, "bold", C.text, { maxLines: 1, minScale: 0.82, textAlign: "right" }),
        text(dateLabel(now), 5, "medium", C.muted, { maxLines: 1, minScale: 0.82, textAlign: "right" })
      ], { width: 43, height: 34, alignItems: "end", gap: 0 })
    ], { height: 34, gap: 4 });
  }

  function flagBox() {
    return row([
      text(flag(exit.countryCode) || "🌐", 22, "regular", C.text, { maxLines: 1, textAlign: "center" })
    ], { width: 36, height: 36, padding: 2, backgroundColor: C.purpleSoft, borderRadius: 11 });
  }

  function scoreGauge() {
    return svgImage(purityGaugeSVG(purity.score, {
      track: uiColor(C.scoreTrack),
      left: uiColor(C.scoreLeft),
      right: uiColor(C.scoreRight),
      glow: uiColor(C.scoreGlow),
      text: uiColor(C.scoreLeft),
      muted: uiColor(C.muted)
    }), 68, 52, { borderRadius: 16 });
  }

  function purityGaugeSVG(score, colors) {
    const value = Math.max(0, Math.min(100, Number(score) || 0));
    const cx = 75, cy = 85, rx = 55, ry = 55;
    const theta = Math.PI - Math.PI * value / 100;
    const px = cx + rx * Math.cos(theta);
    const py = cy - ry * Math.sin(theta);
    const safeTrack = svgColor(colors.track, "#D8E1EA");
    const safeLeft = svgColor(colors.left, "#22C96D");
    const safeRight = svgColor(colors.right, "#E25769");
    const safeGlow = svgColor(colors.glow, "#1AE27F");
    const safeText = svgColor(colors.text, "#22C96D");
    const safeMuted = svgColor(colors.muted, "#74839A");
    const leftDash = value >= 99.9 ? "100 0" : Math.max(0.1, value).toFixed(1) + " 100";
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="112" viewBox="0 0 150 112">',
      "<defs>",
      '<filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">',
      '<feGaussianBlur stdDeviation="2.1" result="blur"/>',
      "<feMerge>", '<feMergeNode in="blur"/>', '<feMergeNode in="SourceGraphic"/>', "</feMerge>",
      "</filter>", "</defs>",
      '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeTrack + '" stroke-width="9" stroke-linecap="round" opacity="0.75"/>',
      '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeRight + '" stroke-width="8.2" stroke-linecap="round" opacity="0.95"/>',
      '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeGlow + '" stroke-width="13" stroke-linecap="round" pathLength="100" stroke-dasharray="' + leftDash + '" opacity="0.16"/>',
      '<path d="M20 85 A55 55 0 0 1 130 85" fill="none" stroke="' + safeLeft + '" stroke-width="8.4" stroke-linecap="round" pathLength="100" stroke-dasharray="' + leftDash + '" opacity="1"/>',
      '<circle cx="' + px.toFixed(2) + '" cy="' + py.toFixed(2) + '" r="6.5" fill="' + safeGlow + '" opacity="0.20"/>',
      '<circle cx="' + px.toFixed(2) + '" cy="' + py.toFixed(2) + '" r="4.2" fill="' + safeLeft + '" filter="url(#softGlow)" opacity="1"/>',
      '<text x="75" y="61" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="30" font-weight="850" fill="' + safeText + '">' + Math.round(value) + "</text>",
      '<text x="75" y="75" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="10" font-weight="760" fill="' + safeMuted + '">/100</text>',
      '<text x="75" y="90" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="10" font-weight="760" fill="' + safeMuted + '">纯净评分</text>',
      "</svg>"
    ].join("");
  }

  function svgDataURI(svg) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  }

  function svgColor(value, fallback) {
    const color = clean(value);
    if (/^#[0-9a-fA-F]{6}$/.test(color) || /^#[0-9a-fA-F]{3}$/.test(color)) return color;
    return fallback;
  }

  // ---------- 链路图卡片组件 ----------
  function proxyCard() {
    const ingressLocation = extractLocation(CURRENT_PROXY.name);
    const egressLocation = {
      flag: flag(exit.countryCode) || "🌐",
      name: exit.city || exit.country || "未知地区"
    };
    const dnsLocation = {
      icon: "cloud.fill",
      name: "Cloudflare",
      tag: "智能DNS"
    };

    const ingressLatency = proxyLatency.ok ? proxyLatency.ms + "ms" : "失败";
    const egressLatency = proxyLatency.ok ? proxyLatency.ms + "ms" : "失败";
    const dnsLatencyText = dnsLatency > 0 ? dnsLatency + "ms" : "失败";

    function linkCard(iconContent, title, subtitle, latencyText, latencyColor) {
      return col([
        row([iconContent], { width: 28, height: 28, alignItems: "center", justifyContent: "center" }),
        text(title, 8.2, "semibold", C.text, { maxLines: 1, textAlign: "center", minScale: 0.5 }),
        text(subtitle, 5.5, "medium", C.subtext, { maxLines: 1, textAlign: "center" }),
        row([
          image("circle.fill", latencyColor || C.green, 4, 4),
          text(latencyText, 7, "semibold", latencyColor || C.green, { maxLines: 1 })
        ], { gap: 2, alignItems: "center" })
      ], { flex: 1, gap: 1, alignItems: "center", padding: [3, 2], backgroundColor: C.tileBg, borderRadius: 10, borderWidth: 1, borderColor: C.tileBorder });
    }

    return card([
      sectionTitle(
        "arrow.triangle.2.circlepath",
        "当前代理",
        pill(proxyLatency.ok ? "连接正常" : "检测失败", proxyLatency.ok ? C.green : C.red, proxyLatency.ok ? C.greenSoft : C.redSoft),
        C.purple
      ),
      row([
        text("入口节点", 5.5, "medium", C.muted, { flex: 1, textAlign: "center", maxLines: 1 }),
        text("落地出口", 5.5, "medium", C.muted, { flex: 1, textAlign: "center", maxLines: 1 }),
        text("DNS策略", 5.5, "medium", C.muted, { flex: 1, textAlign: "center", maxLines: 1 })
      ], { height: 10, gap: 4 }),
      row([
        linkCard(text(ingressLocation.flag, 22, "regular", C.text), ingressLocation.name, "当前节点", ingressLatency, proxyLatency.ok ? C.green : C.red),
        text("→", 14, "medium", C.muted, { width: 8, textAlign: "center" }),
        linkCard(text(egressLocation.flag, 22, "regular", C.text), egressLocation.name, "落地出口", egressLatency, proxyLatency.ok ? C.green : C.red),
        text("→", 14, "medium", C.muted, { width: 8, textAlign: "center" }),
        linkCard(image(dnsLocation.icon, C.blue, 18, 18), dnsLocation.name, dnsLocation.tag, dnsLatencyText, dnsLatency > 0 ? C.green : C.red)
      ], { height: 72, gap: 1, alignItems: "stretch" })
    ], { flex: 1, padding: [5, 6], gap: 3 });
  }

  // ---------- 服务图标 ----------
  function serviceLogoLarge(item) {
    const base = { width: 23, height: 23, padding: 2, backgroundColor: C.tileIconBg, borderRadius: 7 };
    if (item.kind === "spotify") return row([image("dot.radiowaves.left.and.right", item.color, 15, 15)], base);
    if (item.kind === "tiktok") return row([image("music.note", item.color, 15, 15)], base);
    if (item.kind === "youtube") return row([image("play.rectangle.fill", item.color, 15, 15)], base);
    if (item.kind === "prime") return row([image("play.tv.fill", item.color, 15, 15)], base);
    if (item.kind === "chatgpt") return row([image("circle.hexagongrid", item.color, 15, 15)], base);
    if (item.kind === "gemini") return row([image("sparkles", item.color, 15, 15)], base);
    if (item.kind === "grok") return row([image("xmark", item.color, 14, 14)], base);
    if (item.kind === "perplexity") return row([image("magnifyingglass", item.color, 14, 14)], base);
    const mark = item.kind === "netflix" ? "N" : item.kind === "disney" ? "D+" : item.kind === "deepseek" ? "D" : "AI";
    const fontSize = item.kind === "claude" ? 10 : item.kind === "disney" ? 10 : 13;
    return row([text(mark, fontSize, "bold", item.color, { maxLines: 1, textAlign: "center" })], base);
  }

  function compactServiceTile(item) {
    const statusColor = item.ok ? C.green : C.red;
    const serviceCountryCode = countryCode(item.countryCode) || countryCode(exit.countryCode);
    const serviceRegionLabel = serviceCountryCode ? flag(serviceCountryCode) + " " + serviceCountryCode : "NET";
    return row([
      serviceLogoLarge(item),
      col([
        text(item.name, 7, "semibold", C.text, { maxLines: 1, minScale: 0.66 }),
        row([
          text(serviceRegionLabel, 5, "medium", C.subtext, { maxLines: 1 }),
          text(item.ok ? "OK" : "失败", 5.6, "semibold", statusColor, { maxLines: 1 })
        ], { gap: 2 })
      ], { flex: 1, gap: 1 })
    ], { flex: 1, height: 31, padding: [4, 4], gap: 4, backgroundColor: C.tileBg, borderRadius: 9, borderWidth: 1, borderColor: C.tileBorder });
  }

  function serviceGrid(items) {
    return col([
      row([compactServiceTile(items[0]), compactServiceTile(items[1])], { height: 31, gap: 5 }),
      row([compactServiceTile(items[2]), compactServiceTile(items[3])], { height: 31, gap: 5 }),
      row([compactServiceTile(items[4]), compactServiceTile(items[5])], { height: 31, gap: 5 })
    ], { flex: 1, height: 101, gap: 4 });
  }

  function serviceCard(title, symbol, items, tone) {
    const passed = items.filter(item => item.ok).length;
    return card([
      sectionTitle(symbol, title, pill(passed + "/" + items.length, passed === items.length ? C.green : C.amber, passed === items.length ? C.greenSoft : C.amberSoft), tone),
      serviceGrid(items)
    ], { flex: 1, height: 133, padding: [5, 6], gap: 5 });
  }

  // ---------- 底部 ----------
  function footerCell(symbol, label, value, tone) {
    return col([
      row([
        image(symbol, tone, 13, 13),
        col([
          text(label, 6, "medium", C.muted, { maxLines: 1 }),
          text(value, 7, "semibold", tone, { maxLines: 1, minScale: 0.64 })
        ], { flex: 1, gap: 0 })
      ], { gap: 4 })
    ], { flex: 1, padding: [1, 3] });
  }

  function footer() {
    return card([
      row([
        footerCell("server.rack", "ISP / 厂商", shortISP(exit.isp), C.blue),
        footerCell("house.fill", "属性类型", exit.kind, exit.kind === "商业机房" ? C.amber : C.green),
        footerCell("checkmark.shield.fill", "纯净评分", purity.score + "分", purityColor),
        footerCell("shield.lefthalf.filled", "风险等级", risk, riskColor),
        footerCell("arrow.clockwise", "更新时间", timeLabel(now), C.purple)
      ], { height: 30, padding: [0, 0], gap: 0, alignItems: "center" })
    ], { height: 40, padding: [4, 5], gap: 0 });
  }

  // ========== 主流程 ==========
  // 1. 获取策略映射
  const mediaPolicyMap = await resolveServicePolicyMap(
    ["netflix", "disney", "spotify", "tiktok", "youtube", "prime"], "lmt"
  );
  const aiPolicyMap = await resolveServicePolicyMap(
    ["chatgpt", "claude", "gemini", "deepseek", "grok", "perplexity"], "ai"
  );

  // 2. 并发执行核心检测 (增加 DNS 延迟检测)
  const [
    exit,
    proxyLatency,
    quic,
    dnsLatency,
    media,
    ai
  ] = await Promise.all([
    getExit(),
    getProxyLatency(),
    getQuic(),
    getDNSLatency(),
    Promise.all([
      testService("netflix", "Netflix", "netflix", C.netflix, "https://www.netflix.com/title/81215567", mediaPolicyMap.netflix),
      testService("disney", "Disney+", "disney", C.disney, "https://www.disneyplus.com/", mediaPolicyMap.disney),
      testService("spotify", "Spotify", "spotify", C.spotify, "https://open.spotify.com/", mediaPolicyMap.spotify),
      testService("tiktok", "TikTok", "tiktok", C.tiktok, "https://www.tiktok.com/", mediaPolicyMap.tiktok),
      testService("youtube", "YouTube", "youtube", C.youtube, "https://www.youtube.com/", mediaPolicyMap.youtube),
      testService("prime", "Prime", "prime", C.prime, "https://www.primevideo.com/", mediaPolicyMap.prime)
    ]),
    Promise.all([
      testService("chatgpt", "ChatGPT", "chatgpt", C.chatgpt, "https://chatgpt.com/", aiPolicyMap.chatgpt),
      testService("claude", "Claude", "claude", C.claude, "https://claude.ai/", aiPolicyMap.claude),
      testService("gemini", "Gemini", "gemini", C.gemini, "https://gemini.google.com/", aiPolicyMap.gemini),
      testService("deepseek", "DeepSeek", "deepseek", C.deepseek, "https://chat.deepseek.com/", aiPolicyMap.deepseek),
      testService("grok", "Grok", "grok", C.grok, "https://grok.com/", aiPolicyMap.grok),
      testService("perplexity", "Perplexity", "perplexity", C.perplexity, "https://www.perplexity.ai/", aiPolicyMap.perplexity)
    ])
  ]);

  // 3. 计算相关指标
  const nat = detectNAT(localIP, exit.ip);
  const purity = purityScore(exit);
  const risk = riskLevel(exit, purity);

  const proxyLatencyColor = proxyLatency.ok ? (proxyLatency.ms <= 220 ? C.green : C.amber) : C.red;
  const natColor = toneColor(nat.tone, C);
  const quicColor = toneColor(quic.tone, C);
  const purityColor = purity.score >= 75 ? C.green : purity.score >= 45 ? C.amber : C.red;
  const riskColor = risk === "低风险" ? C.green : risk === "中风险" ? C.amber : C.red;

  // 4. 构建面板
  const dashboard = col([
    header(),
    proxyCard(),
    row([
      serviceCard("流媒体解锁", "play.rectangle.fill", media, C.blue),
      serviceCard("AI 解锁检测", "sparkles", ai, C.purple)
    ], { height: 133, gap: 6, alignItems: "start" }),
    footer()
  ], { padding: [8, 8], gap: 6 });

  // 5. 返回 widget
  return {
    type: "widget",
    padding: S(8),
    gap: 0,
    backgroundColor: C.root,
    refreshAfter: new Date(Date.now() + REFRESH_MINUTES * 60 * 1000).toISOString(),
    children: [dashboard, spacer()]
  };
}

// ---------- 调色板 ----------
function palette() {
  const adaptive = (light, dark) => ({ light, dark });
  return {
    root: adaptive("#E3EAF5", "#07101F"),
    dashboard: adaptive("#E3EAF5", "#07101F"),
    dashboardBorder: adaptive("#E3EAF5", "#07101F"),
    card: adaptive("#F7FAFF", "#101A2D"),
    cardTop: adaptive("#FFFFFF", "#142039"),
    cardBottom: adaptive("#F0F5FF", "#0D1728"),
    proxyTop: adaptive("#FFFFFF", "#142039"),
    proxyBottom: adaptive("#F0F5FF", "#0D1728"),
    cardBorder: adaptive("#B5C7E5", "#30476F"),
    tileBg: adaptive("#EDF3FC", "#162238"),
    tileIconBg: adaptive("#DFE9F8", "#1D3154"),
    tileBorder: adaptive("#B7C8E6", "#2E4876"),
    scoreTrack: adaptive("#D8E1EA", "#273045"),
    scoreGlow: adaptive("#1AE27F", "#1AE27F"),
    scoreLeft: adaptive("#22C96D", "#3BE28A"),
    scoreRight: adaptive("#E25769", "#FF627A"),
    footerDivider: adaptive("#C7D2E6", "#32486D"),
    text: adaptive("#18253F", "#F1F5FF"),
    subtext: adaptive("#4E617F", "#BBC8E0"),
    muted: adaptive("#74839A", "#8694AE"),
    blue: adaptive("#2E74D2", "#70AEFF"),
    blueSoft: adaptive("#DDEAFF", "#183B71"),
    purple: adaptive("#7C63D8", "#B09AFF"),
    purpleSoft: adaptive("#EAE3FF", "#31275A"),
    green: adaptive("#229B62", "#58D79D"),
    greenSoft: adaptive("#DDF7E8", "#163F34"),
    amber: adaptive("#B9821D", "#FFC866"),
    amberSoft: adaptive("#FFF0D0", "#503918"),
    red: adaptive("#D64A59", "#FF7D88"),
    redSoft: adaptive("#FFE2E6", "#4A232C"),
    netflix: adaptive("#E50914", "#FF505B"),
    disney: adaptive("#2B76D8", "#7DB7FF"),
    spotify: adaptive("#1DB954", "#1ED760"),
    tiktok: adaptive("#111827", "#FFFFFF"),
    youtube: adaptive("#FF0033", "#FF4B4B"),
    prime: adaptive("#1978CC", "#7CB8FF"),
    chatgpt: adaptive("#1F2937", "#EAF0FF"),
    claude: adaptive("#C86B35", "#FFA26E"),
    gemini: adaptive("#6D6FE8", "#9EA9FF"),
    deepseek: adaptive("#1D6FD8", "#61AAFF"),
    grok: adaptive("#111827", "#F1F5FF"),
    perplexity: adaptive("#0B88A8", "#63D9FF")
  };
}
