/**
 * Egern「网络诊断雷达」V2.1 - 稳定版
 * 
 * 兼容性修复：
 * - 移除 ctx.storage，改为内存缓存
 * - 移除 scrollView，使用固定高度 col
 * - 增强错误处理，确保更新正常
 */

export default async function (ctx) {
  const env = ctx.env || {};
  const C = palette();
  const SCHEME = detectScheme(ctx);

  const POLICY = clean(env.POLICY);
  const POLICY_LABEL = POLICY || "默认规则";
  const LMT_POLICY = clean(env.LMT);
  const AI_POLICY = clean(env.AI);
  const MASK_IP = clean(env.YS) === "1";
  const FORCE_PROTOCOL = clean(env.XY);

  const TIMEOUT = 4500;
  const POLICY_PROBE_TIMEOUT = 1800;
  const POLICY_PROBE_BATCH_SIZE = 6;
  const REFRESH_MINUTES = 15;

  // 内存缓存（用于趋势图，非持久化）
  let historyLatencyCache = [];
  let historyScoreCache = [];

  // ---------- 设备信息 ----------
  const device = ctx.device || {};
  const wifi = device.wifi || {};
  const ipv4 = device.ipv4 || {};
  const localIP = clean(pick(ipv4.address, wifi.ip, wifi.ipAddress, device.ipAddress, device.ip)) || "未获取";
  const now = new Date();

  // ---------- 缩放与样式 ----------
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

  // ---------- 屏幕适配 ----------
  const SCREEN_W = numberInRange(pick(getScreenMetric(ctx, "width"), 440), 320, 900, 440);
  const SCREEN_H = numberInRange(pick(getScreenMetric(ctx, "height"), 956), 568, 1400, 956);
  const WIDTH_SCALE = SCREEN_W / 440;
  const HEIGHT_SCALE = SCREEN_H / 956;
  const UI_SCALE = clamp(WIDTH_SCALE * 0.88 + HEIGHT_SCALE * 0.12, 0.9, 1.06);
  const FONT_SCALE = clamp(UI_SCALE, 0.9, 1.045);

  // ---------- 通用请求 ----------
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

  // ---------- DNS 检测 ----------
  async function getDNSVerified() {
    try {
      const host = randomAlphaNum(32) + ".edns.ip-api.com";
      const result = await getJSON("http://" + host + "/json?_=" + Date.now(), {
        timeout: 3000,
        policy: "DIRECT",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
          Accept: "application/json,text/plain,*/*",
          "Cache-Control": "no-cache"
        }
      });
      if (!result.ok || !result.data) return { ok: false, full: "未知 DNS", short: "未知", ip: "" };
      const dns = result.data.dns || {};
      const ip = clean(dns.ip);
      const geo = clean(dns.geo);
      if (!ip) return { ok: false, full: "未知 DNS", short: "未知", ip: "" };
      const provider = providerFromText(geo + " " + ip);
      return {
        ok: true,
        full: provider.full || geo || ip,
        short: provider.short || "未知",
        ip: ip,
        geo: geo
      };
    } catch (_) {
      return { ok: false, full: "未知 DNS", short: "未知", ip: "" };
    }
  }

  function providerFromText(value) {
    const text = clean(value).toLowerCase();
    if (!text) return { full: "", short: "" };
    if (text.includes("cloudflare")) return { full: "Cloudflare DNS", short: "CF" };
    if (text.includes("google")) return { full: "Google DNS", short: "谷歌" };
    if (text.includes("quad9")) return { full: "Quad9 DNS", short: "Q9" };
    if (text.includes("opendns") || text.includes("cisco")) return { full: "OpenDNS", short: "Open" };
    if (text.includes("adguard")) return { full: "AdGuard DNS", short: "AdG" };
    if (text.includes("nextdns")) return { full: "NextDNS", short: "Next" };
    if (text.includes("114.114") || text.includes("114dns")) return { full: "114DNS", short: "114" };
    if (text.includes("alidns") || text.includes("alibaba") || text.includes("aliyun")) return { full: "AliDNS", short: "阿里" };
    if (text.includes("dnspod") || text.includes("tencent")) return { full: "DNSPod", short: "腾讯" };
    if (text.includes("中国电信") || text.includes("telecom")) return { full: "中国电信 DNS", short: "电信" };
    if (text.includes("中国移动") || text.includes("mobile") || text.includes("cmcc")) return { full: "中国移动 DNS", short: "移动" };
    if (text.includes("中国联通") || text.includes("unicom")) return { full: "中国联通 DNS", short: "联通" };
    return { full: "", short: "" };
  }

  // ---------- 策略相关 ----------
  const servicePolicyCache = {};
  const policyProbeCache = {};
  const policyExitCache = {};

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

  // ---------- 出口信息 ----------
  async function getExit() {
    try {
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
    } catch (_) {
      return { ip: "未识别", city: "出口检测失败", region: "", country: "", countryCode: "", isp: "未知组织", kind: "未知网络", flags: {} };
    }
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
    try {
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
    } catch (_) {
      return { ok: false, ms: 0, target: "" };
    }
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

  // ---------- QUIC 检测 ----------
  async function getQuic() {
    try {
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
    } catch (_) {
      return { value: "×/×", tone: "red" };
    }
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

  // ---------- 服务检测 ----------
  async function testService(id, name, kind, color, url, servicePolicy) {
    try {
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
    } catch (_) {
      return { id, name, kind, color, ok: false, policy: servicePolicy || "", countryCode: "", country: "", exit: {} };
    }
  }

  // ---------- 纯净评分 ----------
  function purityScore(exit) {
    try {
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
    } catch (_) {
      return { score: 0, risk: 100, evidence: {} };
    }
  }

  function riskLevel(exit, purity) {
    const score = purity ? purity.score : 0;
    if (score >= 80) return "低风险";
    if (score >= 50) return "中风险";
    return "高风险";
  }

  // ---------- 当前代理信息 ----------
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

  // ============ UI 构建 ============
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

  // ---------- 头部 ----------
  function header() {
    return row([
      row([
        iconBox("waveform.path.ecg", C.blue, C.blueSoft, 28),
        col([
          row([
            text("网络诊断雷达", 11, "bold", C.text, { maxLines: 1, minScale: 0.72 }),
            pill("V2.1", C.purple, C.purpleSoft, { padding: [1, 4] })
          ], { gap: 3, alignItems: "center" }),
          text("Egern · 全链路状态检测", 6, "medium", C.muted, { maxLines: 1, minScale: 0.78 })
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

  // ---------- 链路图卡片 ----------
  function linkCard(nodeName, exitInfo, dnsInfo) {
    const exitLabel = exitInfo.countryCode ? flag(exitInfo.countryCode) + " " + exitInfo.countryCode : "未知";
    const dnsShort = dnsInfo.short || "未知";
    return card([
      sectionTitle("link", "节点 → 落地 → DNS", null, C.blue),
      row([
        col([
          text("节点", 5, "medium", C.muted),
          text(nodeName || "未识别", 8, "semibold", C.text, { maxLines: 1, minScale: 0.6 })
        ], { width: 55, gap: 1 }),
        text("→", 12, "regular", C.muted),
        col([
          text("落地", 5, "medium", C.muted),
          text(exitLabel, 8, "semibold", C.text, { maxLines: 1, minScale: 0.6 })
        ], { width: 55, gap: 1 }),
        text("→", 12, "regular", C.muted),
        col([
          text("DNS", 5, "medium", C.muted),
          text(dnsShort, 8, "semibold", C.text, { maxLines: 1, minScale: 0.6 })
        ], { width: 55, gap: 1 })
      ], { gap: 3, alignItems: "center" })
    ], { flex: 1, height: 48, padding: [5, 7], gap: 2 });
  }

  // ---------- 解锁来源分析卡片 ----------
  function sourceAnalysisCard(mediaResults, aiResults, exitInfo, dnsInfo) {
    const allServices = [...mediaResults, ...aiResults];
    const total = allServices.length;
    const okCount = allServices.filter(s => s.ok).length;
    const nodeScore = Math.round((okCount / total) * 100);
    const purity = purityScore(exitInfo);
    const landScore = purity.score;
    const dnsProvider = dnsInfo.short || "";
    let dnsScore = 50;
    if (["CF", "谷歌", "Open", "AdG", "Q9", "Next"].includes(dnsProvider)) dnsScore = 95;
    else if (["阿里", "腾讯", "114", "电信", "移动", "联通"].includes(dnsProvider)) dnsScore = 80;
    else if (dnsProvider === "未知") dnsScore = 30;

    function starRating(score) {
      const stars = Math.round(score / 20);
      return "★".repeat(Math.min(stars, 5)) + "☆".repeat(Math.max(0, 5 - stars));
    }

    return card([
      sectionTitle("chart.pie", "解锁来源分析", null, C.purple),
      row([
        col([
          text("节点", 5, "medium", C.muted),
          text(nodeScore + "%", 8, "semibold", nodeScore >= 80 ? C.green : C.amber),
          text(starRating(nodeScore), 6, "regular", C.muted)
        ], { flex: 1, alignItems: "center" }),
        col([
          text("落地", 5, "medium", C.muted),
          text(landScore + "%", 8, "semibold", landScore >= 80 ? C.green : C.amber),
          text(starRating(landScore), 6, "regular", C.muted)
        ], { flex: 1, alignItems: "center" }),
        col([
          text("DNS", 5, "medium", C.muted),
          text(dnsScore + "%", 8, "semibold", dnsScore >= 80 ? C.green : C.amber),
          text(starRating(dnsScore), 6, "regular", C.muted)
        ], { flex: 1, alignItems: "center" })
      ], { height: 40, gap: 2 })
    ], { flex: 1, height: 60, padding: [4, 6], gap: 2 });
  }

  // ---------- 服务卡片 ----------
  function serviceCompactCard(title, symbol, items, tone) {
    const passed = items.filter(item => item.ok).length;
    const itemRows = items.map(item => {
      const statusColor = item.ok ? C.green : C.red;
      const regionCode = item.countryCode ? flag(item.countryCode) + " " + item.countryCode : "NET";
      return row([
        text(item.name, 6, "medium", C.text, { width: 40, maxLines: 1, minScale: 0.5 }),
        text(regionCode, 5, "medium", C.subtext, { width: 30, maxLines: 1, minScale: 0.4 }),
        text(item.ok ? "OK" : "失败", 5, "semibold", statusColor, { width: 20, textAlign: "right" })
      ], { height: 11, gap: 3 });
    });
    return card([
      sectionTitle(symbol, title, pill(passed + "/" + items.length, passed === items.length ? C.green : C.amber, passed === items.length ? C.greenSoft : C.amberSoft), tone),
      col(itemRows, { gap: 1 })
    ], { flex: 1, height: 100, padding: [4, 6], gap: 3 });
  }

  // ---------- 历史测速卡片 ----------
  function historyLatencyCard(latencyData) {
    // 只显示最近一条（因为无持久化），但保留趋势图（用当前值）
    const current = latencyData.length > 0 ? latencyData[0] : { time: Date.now(), ms: 0 };
    const timeStr = timeLabel(new Date(current.time));
    const msText = current.ms > 0 ? current.ms + "ms" : "无数据";
    // 趋势图（用当前点）
    const chartSVG = latencyTrendSVG(latencyData, C);
    return card([
      sectionTitle("clock.arrow.circlepath", "历史测速", null, C.green),
      row([
        text(timeStr, 5, "medium", C.muted, { width: 25 }),
        spacer(),
        text(msText, 6, "semibold", C.text)
      ], { height: 11 }),
      svgImage(chartSVG, 220, 25, { borderRadius: 6 })
    ], { flex: 1, height: 60, padding: [4, 6], gap: 2 });
  }

  function latencyTrendSVG(data, C) {
    const values = data.map(d => d.ms).slice(0, 20).reverse();
    if (values.length === 0) values.push(0);
    const maxVal = Math.max(100, ...values);
    const minVal = Math.min(0, ...values);
    const range = maxVal - minVal || 1;
    const width = 200, height = 25;
    const padding = 2;
    const plotW = width - padding * 2;
    const plotH = height - padding * 2;
    const points = values.map((v, i) => {
      const x = padding + (i / (values.length - 1 || 1)) * plotW;
      const y = padding + plotH - ((v - minVal) / range) * plotH;
      return x.toFixed(2) + "," + y.toFixed(2);
    }).join(" ");
    const lineColor = uiColor(C.green);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<polyline points="' + points + '" fill="none" stroke="' + lineColor + '" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ---------- 评分趋势卡片 ----------
  function historyScoreCard(scoreData) {
    const chartSVG = scoreTrendSVG(scoreData, C);
    return card([
      sectionTitle("chart.line.uptrend.xyaxis", "评分趋势", null, C.amber),
      svgImage(chartSVG, 220, 25, { borderRadius: 6 })
    ], { flex: 1, height: 42, padding: [4, 6], gap: 2 });
  }

  function scoreTrendSVG(data, C) {
    const values = data.map(d => d.score).slice(0, 20).reverse();
    if (values.length === 0) values.push(0);
    const maxVal = 100;
    const minVal = 0;
    const width = 200, height = 25;
    const padding = 2;
    const plotW = width - padding * 2;
    const plotH = height - padding * 2;
    const points = values.map((v, i) => {
      const x = padding + (i / (values.length - 1 || 1)) * plotW;
      const y = padding + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
      return x.toFixed(2) + "," + y.toFixed(2);
    }).join(" ");
    const lineColor = uiColor(C.amber);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<polyline points="' + points + '" fill="none" stroke="' + lineColor + '" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ---------- 底部 ----------
  function footer(exit, purity, risk) {
    const purityColor = purity.score >= 75 ? C.green : purity.score >= 45 ? C.amber : C.red;
    const riskColor = risk === "低风险" ? C.green : risk === "中风险" ? C.amber : C.red;
    return card([
      row([
        col([
          text("ISP/厂商", 5, "medium", C.muted),
          text(shortISP(exit.isp), 6, "semibold", C.text, { maxLines: 1, minScale: 0.5 })
        ], { flex: 1 }),
        col([
          text("属性类型", 5, "medium", C.muted),
          text(exit.kind, 6, "semibold", exit.kind === "商业机房" ? C.amber : C.green, { maxLines: 1, minScale: 0.5 })
        ], { flex: 1 }),
        col([
          text("纯净评分", 5, "medium", C.muted),
          text(purity.score + "分", 6, "semibold", purityColor)
        ], { flex: 1 }),
        col([
          text("风险等级", 5, "medium", C.muted),
          text(risk, 6, "semibold", riskColor)
        ], { flex: 1 }),
        col([
          text("更新时间", 5, "medium", C.muted),
          text(timeLabel(now), 6, "semibold", C.purple)
        ], { flex: 1 })
      ], { gap: 1 })
    ], { height: 36, padding: [3, 5], gap: 0 });
  }

  // ============ 主流程 ============
  // 1. 获取策略映射
  const mediaPolicyMap = await resolveServicePolicyMap(
    ["netflix", "disney", "spotify", "tiktok", "youtube", "prime"], "lmt"
  );
  const aiPolicyMap = await resolveServicePolicyMap(
    ["chatgpt", "claude", "gemini", "deepseek", "grok", "perplexity"], "ai"
  );

  // 2. 并发执行核心检测
  const [exit, dnsInfo, proxyLatency, quic, media, ai] = await Promise.all([
    getExit(),
    getDNSVerified(),
    getProxyLatency(),
    getQuic(),
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

  // 3. 计算指标
  const nat = detectNAT(localIP, exit.ip);
  const purity = purityScore(exit);
  const risk = riskLevel(exit, purity);
  const nodeName = CURRENT_PROXY.name || "未识别";

  // 4. 更新内存历史（仅保存本次数据，用于趋势图展示）
  const currentLatency = proxyLatency.ok ? proxyLatency.ms : 0;
  const currentScore = purity.score;
  // 添加到缓存（简单起见，只保留当前值，并构造一个趋势点）
  historyLatencyCache = [{ time: Date.now(), ms: currentLatency }];
  historyScoreCache = [{ time: Date.now(), score: currentScore }];
  // 可以扩展为保存多次（但组件刷新后丢失，这里仅演示）

  // 5. 构建 UI（固定高度 480，无滚动）
  const WIDGET_HEIGHT = 480;
  const dashboard = col([
    header(),
    linkCard(nodeName, exit, dnsInfo),
    sourceAnalysisCard(media, ai, exit, dnsInfo),
    row([
      serviceCompactCard("流媒体解锁", "play.rectangle.fill", media, C.blue),
      serviceCompactCard("AI 解锁检测", "sparkles", ai, C.purple)
    ], { height: 100, gap: 6, alignItems: "start" }),
    row([
      historyLatencyCard(historyLatencyCache),
      historyScoreCard(historyScoreCache)
    ], { height: 62, gap: 6, alignItems: "start" }),
    footer(exit, purity, risk)
  ], { padding: [8, 8], gap: 6 });

  return {
    type: "widget",
    padding: 0,
    gap: 0,
    backgroundColor: C.root,
    refreshAfter: new Date(Date.now() + REFRESH_MINUTES * 60 * 1000).toISOString(),
    children: [
      {
        type: "stack",
        direction: "column",
        width: SCREEN_W - 16,
        height: WIDGET_HEIGHT,
        children: [dashboard]
      }
    ]
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
