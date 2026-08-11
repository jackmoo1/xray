/**
 * Egern「网络诊断雷达」- 修复与优化版（字体放大 & 补全缺失工具函数）
 *
 * 环境变量：
 * - POLICY：最高优先级策略
 * - LMT：流媒体检测策略组（POLICY 为空时生效）
 * - AI：AI 检测策略组（POLICY 为空时生效）
 * - YS=1/true/yes：启用 IP 隐私打码
 * - XY：手动指定协议（如 VLESS / Trojan / HY2 / AnyTLS）
 */

export default async function (ctx) {
  const env = ctx.env || {};
  const C = palette();
  const SCHEME = detectScheme(ctx);

  const POLICY = clean(env.POLICY);
  const POLICY_LABEL = POLICY || "默认规则";
  const LMT_POLICY = clean(env.LMT);
  const AI_POLICY = clean(env.AI);
  const MASK_IP = envBool(env.YS);
  const FORCE_PROTOCOL = clean(env.XY);

  const TIMEOUT = 3000;
  const POLICY_PROBE_TIMEOUT = 1500;
  const POLICY_PROBE_BATCH_SIZE = 6;
  const REFRESH_MINUTES = 15;
  const FORCE_LOCAL_MAINLAND = true;

  const servicePolicyCache = {};
  const policyProbeCache = {};
  const policyExitCache = {};

  const SCREEN_W = numberInRange(
    pick(getScreenMetric(ctx, "width"), 440),
    320,
    900,
    440
  );

  const SCREEN_H = numberInRange(
    pick(getScreenMetric(ctx, "height"), 956),
    568,
    1400,
    956
  );

  const WIDTH_SCALE = SCREEN_W / 440;
  const HEIGHT_SCALE = SCREEN_H / 956;
  
  // 优化点：适度放开 UI 缩放的上限（原 1.06 -> 1.15），避免字体变大后撑爆 UI 组件触发强行缩小
  const UI_SCALE = clamp(WIDTH_SCALE * 0.88 + HEIGHT_SCALE * 0.12, 0.95, 1.15);
  // 优化点：字体放大系数由 1.15 提升至 1.35，最大值放宽至 1.45
  const FONT_SCALE = clamp(UI_SCALE * 1.35, 1.1, 1.45);

  const CURRENT_PROXY = getCurrentProxyInfo(ctx);
  const NODE_PROTOCOL =
    protocolFromXY(FORCE_PROTOCOL) ||
    CURRENT_PROXY.protocol ||
    "未暴露";

  const MAINLAND_LATENCY_URLS = [
    "http://connect.rom.miui.com/generate_204",
    "http://wifi.vivo.com.cn/generate_204",
    "https://www.baidu.com/favicon.ico",
    "https://www.qq.com/favicon.ico",
    "https://www.aliyun.com/favicon.ico"
  ];

  const GLOBAL_PROXY_LATENCY_URLS = [
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
    "https://www.google.com/generate_204",
    "https://www.cloudflare.com/favicon.ico"
  ];

  const POLICY_PROBE_URLS = [
    "https://cp.cloudflare.com/generate_204",
    "https://www.gstatic.com/generate_204",
    "https://www.cloudflare.com/favicon.ico"
  ];

  const QUIC_TRACE_URLS = [
    "https://cloudflare-quic.com/cdn-cgi/trace",
    "https://cloudflare.com/cdn-cgi/trace",
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://one.one.one.one/cdn-cgi/trace",
    "https://1.1.1.1/cdn-cgi/trace"
  ];

  const MEDIA_SERVICE_IDS = [
    "netflix",
    "disney",
    "spotify",
    "tiktok",
    "youtube",
    "prime"
  ];

  const AI_SERVICE_IDS = [
    "chatgpt",
    "claude",
    "gemini",
    "deepseek",
    "grok",
    "perplexity"
  ];

  const device = ctx.device || {};
  const wifi = device.wifi || {};
  const ipv4 = device.ipv4 || {};

  const dnsServers = Array.isArray(device.dnsServers)
    ? device.dnsServers.filter(Boolean)
    : [];

  let networkName = getLocalNetworkName(device);

  const localIP =
    clean(
      pick(
        ipv4.address,
        wifi.ip,
        wifi.ipAddress,
        device.ipAddress,
        device.ip
      )
    ) || "未获取";

  const gateway =
    clean(
      pick(
        ipv4.gateway,
        wifi.gateway,
        device.gateway
      )
    ) || "未获取";

  const hasIPv4 = Boolean(clean(localIP)) && localIP !== "未获取";
  const baseDNS = detectDNSProvider(dnsServers);
  const now = new Date();

  // ---------- 辅助函数 ----------
  function envBool(value) {
    const v = clean(value).toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }

  function S(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * UI_SCALE * 100) / 100;
  }

  function FS(value) {
    if (typeof value !== "number") return value;
    return Math.round(value * FONT_SCALE * 100) / 100;
  }

  function displayIP(value) {
    return MASK_IP ? maskIP(value) : value;
  }

  function scaleStyle(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      return object;
    }

    const scaled = {};
    const scaleKeys = {
      width: true,
      height: true,
      gap: true,
      borderRadius: true,
      borderWidth: true,
      length: true
    };

    Object.keys(object).forEach(function (key) {
      const value = object[key];

      if (key === "padding" && Array.isArray(value)) {
        scaled[key] = value.map(function (item) {
          return S(item);
        });
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

  // ---------- 网络请求（带重试） ----------
  async function fetchWithRetry(url, options, retries = 2) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
      try {
        return await ctx.http.get(url, options);
      } catch (e) {
        lastError = e;
        if (i < retries) {
          await new Promise(r => setTimeout(r, 300 * (i + 1)));
        }
      }
    }
    throw lastError;
  }

  function requestOptions(extra) {
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

    if (POLICY) {
      options.policy = POLICY;
    }

    return Object.assign(options, extra || {});
  }

  function directRequestOptions(extra) {
    return Object.assign(
      {
        timeout: TIMEOUT,
        redirect: "follow",
        credentials: "omit",
        policy: "DIRECT",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
          Accept: "application/json,text/plain,text/html,*/*",
          "Cache-Control": "no-cache"
        }
      },
      extra || {}
    );
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

    const targetPolicy = clean(policy);
    if (targetPolicy) {
      options.policy = targetPolicy;
    }

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

    const targetPolicy = clean(policy);
    if (targetPolicy) {
      options.policy = targetPolicy;
    }

    return Object.assign(options, extra || {});
  }

  async function getJSON(url) {
    try {
      const response = await fetchWithRetry(url, requestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function getJSONDirect(url) {
    try {
      const response = await fetchWithRetry(url, directRequestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        data: await response.json()
      };
    } catch (_) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function getText(url) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithRetry(url, requestOptions());
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        text: (await response.text()) || "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        text: "",
        ms: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  async function getServiceStatus(url, servicePolicy) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithRetry(
        url,
        serviceRequestOptions(servicePolicy)
      );
      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt)
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        ms: Math.max(1, Date.now() - startedAt)
      };
    }
  }

  // ---------- 核心业务逻辑 ----------
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

        for (let index = 0; index < urls.length; index += 1) {
          try {
            const response = await ctx.http.get(
              urls[index],
              serviceRequestOptions(targetPolicy, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
                  Accept: "application/json,text/plain,*/*",
                  "Cache-Control": "no-cache"
                }
              })
            );

            if (response.status < 200 || response.status >= 400) continue;

            const parsed = parsePolicyExit(await response.json());
            if (parsed && parsed.countryCode) {
              return parsed;
            }
          } catch (_) {}
        }

        return {
          ip: "",
          country: "",
          countryCode: "",
          city: "",
          region: "",
          label: "NET"
        };
      })();
    }

    return await policyExitCache[key];
  }

  function parsePolicyExit(data) {
    if (!data || typeof data !== "object") {
      return {
        ip: "",
        country: "",
        countryCode: "",
        city: "",
        region: "",
        label: "NET"
      };
    }

    const ip = clean(
      pick(
        data.query,
        data.ip,
        data.ip_address,
        getAt(data, "location.ip")
      )
    );

    const rawCountry = clean(
      pick(
        data.country,
        data.country_name,
        getAt(data, "location.country")
      )
    );

    const code = countryCode(
      pick(
        data.countryCode,
        data.country_code,
        getAt(data, "location.country_code"),
        rawCountry.length === 2 ? rawCountry : ""
      )
    );

    const region = clean(
      pick(
        data.regionName,
        data.region,
        getAt(data, "location.region")
      )
    );

    const city = clean(
      pick(
        data.city,
        getAt(data, "location.city")
      )
    );

    return {
      ip: ip,
      country: rawCountry,
      countryCode: code,
      city: city,
      region: region,
      label: code ? flag(code) + " " + code : "NET"
    };
  }

  async function probePolicy(policy) {
    const name = clean(policy);
    if (!name) return false;

    const key = name.toLowerCase();
    if (!policyProbeCache[key]) {
      policyProbeCache[key] = (async function () {
        const urls = POLICY_PROBE_URLS.map(function (url) {
          return url + "?_=" + Date.now() + randomAlphaNum(5);
        });

        for (let index = 0; index < urls.length; index += 1) {
          try {
            const response = await ctx.http.get(
              urls[index],
              policyProbeRequestOptions(name)
            );
            if (response.status >= 200 && response.status < 500) {
              return true;
            }
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
      const results = await Promise.all(
        batch.map(function (policy) {
          return probePolicy(policy);
        })
      );

      for (let index = 0; index < results.length; index += 1) {
        if (results[index]) {
          return batch[index];
        }
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
      result = await firstWorkingPolicy(
        servicePolicyCandidates(id, type)
      );
    }

    servicePolicyCache[cacheKey] = result;
    return result;
  }

  async function resolveServicePolicyMap(ids, category) {
    const entries = await Promise.all(
      ids.map(async function (id) {
        return [
          id,
          await resolveServicePolicy(id, category)
        ];
      })
    );

    const map = {};
    entries.forEach(function (entry) {
      map[entry[0]] = entry[1];
    });

    return map;
  }

  async function getExit() {
    const baseResults = await Promise.all([
      getJSON("https://api.ipapi.is/?_=" + Date.now()),
      getJSON(
        "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile&_=" +
          Date.now()
      ),
      getJSON("https://ipwho.is/?lang=zh-CN&_=" + Date.now()),
      getJSON("https://ipinfo.io/json?_=" + Date.now())
    ]);

    const sourceNames = [
      "ipapi.is",
      "ip-api",
      "ipwho.is",
      "ipinfo"
    ];

    const candidates = [];

    for (let index = 0; index < baseResults.length; index += 1) {
      if (!baseResults[index].ok || !baseResults[index].data) {
        continue;
      }

      const parsed = parseExitSource(
        baseResults[index].data,
        sourceNames[index]
      );

      if (parsed.ip) {
        candidates.push(parsed);
      }
    }

    let merged = mergeExitSources(candidates);

    if (!merged.ip || merged.ip === "未识别") {
      return {
        ip: "未识别",
        city: "出口检测失败",
        region: "",
        country: "",
        countryCode: "",
        isp: "未知组织",
        kind: "未知网络",
        flags: {}
      };
    }

    const proxyCheck = await getProxyCheck(merged.ip);
    if (proxyCheck && proxyCheck.ip) {
      merged = mergeExitSources([merged, proxyCheck]);
    }

    return merged;
  }

  async function getLocalExit() {
    const results = await Promise.all([
      getJSONDirect(
        "http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" +
          Date.now()
      ),
      getJSONDirect("https://ipwho.is/?lang=zh-CN&_=" + Date.now()),
      getJSONDirect("https://api.ipapi.is/?_=" + Date.now())
    ]);

    for (let index = 0; index < results.length; index += 1) {
      const parsed = parseLocalExit(
        results[index].data,
        FORCE_LOCAL_MAINLAND
      );

      if (results[index].ok && parsed.ip) {
        if (FORCE_LOCAL_MAINLAND && parsed.countryCode !== "CN") {
          return {
            ip: parsed.ip,
            city: "",
            region: "",
            country: "中国",
            countryCode: "CN",
            isp: parsed.isp || "",
            org: parsed.org || "",
            asname: parsed.asname || "",
            as: parsed.as || "",
            label: "中国大陆"
          };
        }

        return parsed;
      }
    }

    return {
      ip: "",
      city: "",
      region: "",
      country: "中国",
      countryCode: "CN",
      isp: "",
      org: "",
      asname: "",
      as: "",
      label: "中国大陆"
    };
  }

  async function getDNSVerified() {
    const result = await probeEDNSResolver();
    if (!result || !result.ok || !result.ip) {
      return {
        ok: false,
        full: "",
        short: "",
        ip: "",
        geo: "",
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const providerByText = providerFromText(
      [
        result.geo,
        result.ip,
        result.isp,
        result.org,
        result.asname,
        result.as
      ].join(" ")
    );

    if (providerByText.short) {
      return {
        ok: true,
        full: providerByText.full,
        short: providerByText.short,
        ip: result.ip,
        geo: result.geo,
        isp: result.isp,
        org: result.org,
        asname: result.asname,
        as: result.as
      };
    }

    const providerByIP = detectDNSProvider([result.ip]);
    if (providerByIP.short && !isWeakDNSLabel(providerByIP.short)) {
      return {
        ok: true,
        full: providerByIP.full,
        short: providerByIP.short,
        ip: result.ip,
        geo: result.geo,
        isp: result.isp,
        org: result.org,
        asname: result.asname,
        as: result.as
      };
    }

    const ispLabel = compactDNSProviderName(
      result.isp ||
      result.org ||
      result.asname ||
      result.as ||
      result.geo
    );

    return {
      ok: true,
      full: result.isp || result.org || result.asname || result.geo || "未知 DNS",
      short: ispLabel,
      ip: result.ip,
      geo: result.geo,
      isp: result.isp,
      org: result.org,
      asname: result.asname,
      as: result.as
    };
  }

  async function probeEDNSResolver() {
    const host = randomAlphaNum(32) + ".edns.ip-api.com";

    const result = await getJSONDirect(
      "http://" + host + "/json?_=" + Date.now()
    );

    if (!result.ok || !result.data) {
      return {
        ok: false,
        ip: "",
        geo: "",
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const dns = result.data.dns || {};
    const ip = clean(dns.ip);
    const geo = clean(dns.geo);

    if (!ip) {
      return {
        ok: false,
        ip: "",
        geo: geo,
        isp: "",
        org: "",
        asname: "",
        as: ""
      };
    }

    const info = await getDNSResolverInfo(ip);

    return {
      ok: true,
      ip: ip,
      geo: geo,
      isp: info.isp,
      org: info.org,
      asname: info.asname,
      as: info.as
    };
  }

  async function getDNSResolverInfo(ip) {
    const target = clean(ip);
    if (!target) {
      return { isp: "", org: "", asname: "", as: "" };
    }

    const result = await getJSONDirect(
      "http://ip-api.com/json/" +
        encodeURIComponent(target) +
        "?lang=zh-CN&fields=status,message,query,country,countryCode,regionName,city,isp,org,as,asname&_=" +
        Date.now()
    );

    if (!result.ok || !result.data || result.data.status === "fail") {
      return { isp: "", org: "", asname: "", as: "" };
    }

    return {
      isp: clean(result.data.isp),
      org: clean(result.data.org),
      asname: clean(result.data.asname),
      as: clean(result.data.as)
    };
  }

  async function getProxyLatency() {
    const measured = await measureLatencySet(
      GLOBAL_PROXY_LATENCY_URLS,
      false
    );

    return {
      ok: measured.ok,
      ms: measured.ms,
      target: measured.target
    };
  }

  async function getLocalLatency() {
    const measured = await measureLatencySet(
      MAINLAND_LATENCY_URLS,
      true
    );

    return {
      ok: measured.ok,
      ms: measured.ms,
      target: measured.target
    };
  }

  async function measureLatencySet(urls, direct) {
    const results = await Promise.all(
      urls.map(function (url) {
        return latencyProbe(url, direct);
      })
    );

    const passed = results
      .filter(function (item) {
        return item.ok && item.ms > 0;
      })
      .sort(function (a, b) {
        return a.ms - b.ms;
      });

    if (passed.length === 0) {
      return {
        ok: false,
        ms: 0,
        target: ""
      };
    }

    const best = passed[0];

    return {
      ok: true,
      ms: best.ms,
      target: best.url
    };
  }

  async function latencyProbe(url, direct) {
    const startedAt = Date.now();

    try {
      const response = direct
        ? await ctx.http.get(url, directRequestOptions())
        : await ctx.http.get(url, requestOptions());

      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    } catch (_) {
      return {
        ok: false,
        status: 0,
        ms: Math.max(1, Date.now() - startedAt),
        url: url
      };
    }
  }

  async function getProxyCheck(ip) {
    const target = clean(ip);

    if (!target || target === "未识别") {
      return null;
    }

    const result = await getJSON(
      "https://proxycheck.io/v2/" +
        encodeURIComponent(target) +
        "?vpn=1&asn=1&risk=1&time=1&_=" +
        Date.now()
    );

    if (!result.ok || !result.data) {
      return null;
    }

    return parseProxyCheck(result.data, target);
  }

  async function getQuic() {
    const urls = QUIC_TRACE_URLS.map(function (url) {
      return url + "?_=" + Date.now() + randomAlphaNum(5);
    });

    const results = await Promise.all(
      urls.map(function (url) {
        return getText(url);
      })
    );

    let hasH3 = false;
    let hasReachable = false;

    for (let index = 0; index < results.length; index += 1) {
      const item = results[index];

      if (!item || !item.ok) {
        continue;
      }

      hasReachable = true;

      const trace = parseTrace(item.text);
      const protocol = clean(trace.http).toLowerCase();

      if (
        protocol === "h3" ||
        protocol === "http3" ||
        protocol === "http/3" ||
        protocol.includes("h3") ||
        protocol.includes("http/3")
      ) {
        hasH3 = true;
        break;
      }
    }

    if (hasH3) {
      return {
        value: "✓/✓",
        tone: "green"
      };
    }

    return {
      value: "×/×",
      tone: hasReachable ? "amber" : "red"
    };
  }

  async function testService(id, name, kind, color, url, servicePolicy) {
    const serviceExitPromise = getPolicyExit(servicePolicy);

    if (!url) {
      const emptyExit = await serviceExitPromise;

      return {
        id: id,
        name: name,
        kind: kind,
        color: color,
        ok: false,
        policy: servicePolicy || "",
        countryCode: emptyExit.countryCode || "",
        country: emptyExit.country || "",
        exit: emptyExit
      };
    }

    const separator = url.includes("?") ? "&" : "?";

    const [
      result,
      serviceExit
    ] = await Promise.all([
      getServiceStatus(
        url + separator + "_=" + Date.now(),
        servicePolicy
      ),
      serviceExitPromise
    ]);

    return {
      id: id,
      name: name,
      kind: kind,
      color: color,
      ok: result.ok,
      policy: servicePolicy || "",
      countryCode: serviceExit.countryCode || "",
      country: serviceExit.country || "",
      exit: serviceExit
    };
  }

  // ---------- 主流程 ----------
  const [
    mediaPolicyMap,
    aiPolicyMap
  ] = await Promise.all([
    resolveServicePolicyMap(MEDIA_SERVICE_IDS, "lmt"),
    resolveServicePolicyMap(AI_SERVICE_IDS, "ai")
  ]);

  const [
    exit,
    localExit,
    verifiedDNS,
    proxyLatency,
    localLatency,
    quic,
    media,
    ai
  ] = await Promise.all([
    getExit(),
    getLocalExit(),
    getDNSVerified(),
    getProxyLatency(),
    getLocalLatency(),
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

  const carrierByDirectISP = carrierFromISP(
    [
      localExit.isp,
      localExit.org,
      localExit.asname,
      localExit.as
    ].join(" ")
  );

  if (!networkName && carrierByDirectISP) {
    networkName = carrierByDirectISP;
  }

  if (!networkName) {
    networkName = "移动数据";
  }

  const dns = chooseDNSProvider(baseDNS, verifiedDNS);
  const dnsLabel = dnsTinyLabel(dns.short || dns.full);
  const localArea = localExit.label || "中国大陆";
  const nat = detectNAT(localIP, exit.ip);
  const purity = purityScore(exit);
  const risk = riskLevel(exit, purity);

  const proxyLatencyColor = proxyLatency.ok
    ? proxyLatency.ms <= 220 ? C.green : C.amber
    : C.red;

  const localLatencyColor = localLatency.ok
    ? localLatency.ms <= 220 ? C.green : C.amber
    : C.red;

  const natColor = toneColor(nat.tone, C);
  const quicColor = toneColor(quic.tone, C);

  const purityColor =
    purity.score >= 75 ? C.green :
    purity.score >= 45 ? C.amber :
    C.red;

  const riskColor =
    risk === "低风险" ? C.green :
    risk === "中风险" ? C.amber :
    C.red;

  // ---------- UI 构建 ----------
  function merge(base, extra) {
    return scaleStyle(Object.assign({}, base || {}, extra || {}));
  }

  function text(value, size, weight, color, extra) {
    return merge(
      {
        type: "text",
        text: String(value),
        font: {
          size: FS(size),
          weight: weight || "regular"
        },
        textColor: color || C.text
      },
      extra
    );
  }

  function image(symbol, color, width, height, extra) {
    return merge(
      {
        type: "image",
        src: "sf-symbol:" + symbol,
        color: color || C.text,
        width: width || 10,
        height: height || 10
      },
      extra
    );
  }

  function rawImage(src, width, height, extra) {
    return merge(
      {
        type: "image",
        src: src,
        width: width,
        height: height,
        resizable: true
      },
      extra || {}
    );
  }

  function svgImage(svg, width, height, extra) {
    return rawImage(svgDataURI(svg), width, height, extra);
  }

  function row(children, extra) {
    return merge(
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: children || []
      },
      extra
    );
  }

  function col(children, extra) {
    return merge(
      {
        type: "stack",
        direction: "column",
        alignItems: "start",
        children: children || []
      },
      extra
    );
  }

  function spacer(length) {
    return length === undefined
      ? { type: "spacer" }
      : { type: "spacer", length: S(length) };
  }

  function card(children, extra) {
    return merge(
      {
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
      },
      extra
    );
  }

  function pill(value, tone, fill, extra) {
    return row(
      [
        text(value, 6, "semibold", tone, {
          maxLines: 1,
          minScale: 0.72,
          textAlign: "center"
        })
      ],
      merge(
        {
          padding: [2, 5],
          backgroundColor: fill,
          borderRadius: 8
        },
        extra
      )
    );
  }

  function proxyTagLine(value, tone, fill) {
    return row(
      [
        text(value, 4.7, "semibold", tone, {
          maxLines: 1,
          minScale: 0.42,
          textAlign: "center"
        })
      ],
      {
        width: 37,
        height: 7.2,
        padding: [0.7, 2.5],
        backgroundColor: fill,
        borderRadius: 4.8,
        alignItems: "center"
      }
    );
  }

  function proxyTagRows(tagOne, tagTwo, toneOne, fillOne, toneTwo, fillTwo) {
    return col(
      [
        proxyTagLine(tagOne, toneOne, fillOne),
        proxyTagLine(tagTwo, toneTwo, fillTwo)
      ],
      {
        width: 39,
        gap: 1,
        alignItems: "start"
      }
    );
  }

  function iconBox(symbol, tone, fill, side) {
    return row(
      [
        image(
          symbol,
          tone,
          Math.round(side * 0.52),
          Math.round(side * 0.52)
        )
      ],
      {
        width: side,
        height: side,
        padding: 3,
        backgroundColor: fill,
        borderRadius: 12
      }
    );
  }

  function sectionTitle(symbol, title, right, tone) {
    const children = [
      image(symbol, tone, 11, 11),
      text(title, 10, "semibold", C.text, {
        maxLines: 1
      })
    ];

    if (right) {
      children.push(spacer());
      children.push(right);
    }

    return row(children, { gap: 3 });
  }

  function metricBox(symbol, label, value, tone, extra) {
    const options = extra || {};
    const valueSize = options.valueSize || 6.1;
    const valueMinScale = options.valueMinScale || 0.35;
    const labelSize = options.labelSize || 5;
    const labelMinScale = options.labelMinScale || 0.72;

    return col(
      [
        row(
          [
            image(symbol, tone, 7, 7),
            text(label, labelSize, "medium", C.muted, {
              maxLines: 1,
              minScale: labelMinScale,
              textAlign: "center"
            })
          ],
          {
            gap: 1,
            alignItems: "center"
          }
        ),

        text(value, valueSize, "semibold", tone, {
          maxLines: 1,
          minScale: valueMinScale,
          textAlign: "center"
        })
      ],
      {
        flex: 1,
        height: 24,
        padding: [0, 0],
        gap: 0,
        alignItems: "center"
      }
    );
  }

  function header() {
    return row(
      [
        row(
          [
            iconBox("waveform.path.ecg", C.blue, C.blueSoft, 28),

            col(
              [
                row(
                  [
                    text("网络诊断雷达", 11, "bold", C.text, {
                      maxLines: 1,
                      minScale: 0.72
                    }),

                    pill("Pro", C.purple, C.purpleSoft, {
                      padding: [1, 4]
                    })
                  ],
                  {
                    gap: 3,
                    alignItems: "center"
                  }
                ),

                text("Egern · 全面网络状态检测", 6, "medium", C.muted, {
                  maxLines: 1,
                  minScale: 0.78
                })
              ],
              {
                flex: 1,
                gap: 0
              }
            )
          ],
          {
            width: 171,
            height: 34,
            gap: 6
          }
        ),

        row(
          [
            spacer(),

            image("scope", C.purple, 11, 11),

            col(
              [
                text("当前策略", 5, "medium", C.muted, {
                  maxLines: 1,
                  textAlign: "center"
                }),

                row(
                  [
                    text(
                      POLICY ? "●" : "○",
                      7,
                      "bold",
                      POLICY ? C.green : C.purple
                    ),

                    text(POLICY_LABEL, 7, "semibold", C.text, {
                      maxLines: 1,
                      minScale: 0.72
                    })
                  ],
                  {
                    gap: 2,
                    alignItems: "center"
                  }
                )
              ],
              {
                width: 52,
                gap: 0,
                alignItems: "start"
              }
            ),

            spacer()
          ],
          {
            flex: 1,
            height: 34,
            padding: [3, 0],
            gap: 3
          }
        ),

        col(
          [
            text(timeLabel(now), 11, "bold", C.text, {
              maxLines: 1,
              minScale: 0.82,
              textAlign: "right"
            }),

            text(dateLabel(now), 5, "medium", C.muted, {
              maxLines: 1,
              minScale: 0.82,
              textAlign: "right"
            })
          ],
          {
            width: 43,
            height: 34,
            alignItems: "end",
            gap: 0
          }
        )
      ],
      {
        height: 34,
        gap: 4
      }
    );
  }

  function flagBox() {
    return row(
      [
        text(flag(exit.countryCode) || "🌐", 22, "regular", C.text, {
          maxLines: 1,
          textAlign: "center"
        })
      ],
      {
        width: 36,
        height: 36,
        padding: 2,
        backgroundColor: C.purpleSoft,
        borderRadius: 11
      }
    );
  }

  function scoreGauge() {
    return svgImage(
      purityGaugeSVG(
        purity.score,
        {
          track: uiColor(C.scoreTrack),
          left: uiColor(C.scoreLeft),
          right: uiColor(C.scoreRight),
          glow: uiColor(C.scoreGlow),
          text: uiColor(C.scoreLeft),
          muted: uiColor(C.muted)
        }
      ),
      68,
      52,
      {
        borderRadius: 16
      }
    );
  }

  function proxyCard() {
    const city =
      clean(exit.city) ||
      clean(exit.country) ||
      "未知地区";

    const tagOne = exit.kind || "未知网络";

    const tagTwo =
      clean(exit.cloudProvider) ||
      (
        exit.kind === "住宅 IP"
          ? "原生住宅"
          : exit.kind === "移动网络"
            ? "移动出口"
            : exit.kind === "商业机房"
              ? "商业机房"
              : "出口网络"
      );

    const tagOneTone =
      exit.kind === "商业机房"
        ? C.amber
        : C.green;

    const tagOneFill =
      exit.kind === "商业机房"
        ? C.amberSoft
        : C.greenSoft;

    const tagTwoTone = C.green;
    const tagTwoFill = C.greenSoft;

    return card(
      [
        sectionTitle(
          "point.3.connected.trianglepath.dotted",
          "当前代理",
          pill(
            proxyLatency.ok ? "连接正常" : "检测失败",
            proxyLatency.ok ? C.green : C.red,
            proxyLatency.ok ? C.greenSoft : C.redSoft
          ),
          C.purple
        ),

        row(
          [
            flagBox(),

            col(
              [
                row(
                  [
                    text(flag(exit.countryCode) || "🌐", 7, "regular", C.text),

                    text(city, 9.2, "semibold", C.text, {
                      flex: 1,
                      maxLines: 1,
                      minScale: 0.55
                    })
                  ],
                  { gap: 2 }
                ),

                text(shortISP(exit.isp), 7.2, "medium", C.subtext, {
                  maxLines: 1,
                  minScale: 0.62
                }),

                proxyTagRows(
                  tagOne,
                  tagTwo,
                  tagOneTone,
                  tagOneFill,
                  tagTwoTone,
                  tagTwoFill
                )
              ],
              {
                flex: 1,
                gap: 1
              }
            ),

            row(
              [
                scoreGauge()
              ],
              {
                width: 68,
                height: 52,
                alignItems: "center",
                justifyContent: "center"
              }
            )
          ],
          {
            gap: 4,
            alignItems: "center"
          }
        ),

        row(
          [
            metricBox(
              "clock",
              "延迟",
              proxyLatency.ok ? proxyLatency.ms + "ms" : "失败",
              proxyLatencyColor
            ),

            metricBox(
              "circle.hexagongrid.fill",
              "NAT",
              nat.label,
              natColor
            ),

            metricBox(
              "paperplane.fill",
              "UDP/QUIC",
              quic.value,
              quicColor,
              {
                labelSize: 4.25,
                labelMinScale: 0.38
              }
            ),

            metricBox(
              "slider.horizontal.3",
              "协议",
              NODE_PROTOCOL,
              C.purple,
              {
                valueSize: 5.4,
                valueMinScale: 0.34
              }
            )
          ],
          { gap: 2 }
        )
      ],
      {
        flex: 1,
        padding: [5, 6],
        gap: 3
      }
    );
  }

  function serviceLogoLarge(item) {
    const base = {
      width: 23,
      height: 23,
      padding: 2,
      backgroundColor: C.tileIconBg,
      borderRadius: 7
    };

    if (item.kind === "spotify") {
      return row(
        [
          image("dot.radiowaves.left.and.right", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "tiktok") {
      return row(
        [
          image("music.note", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "youtube") {
      return row(
        [
          image("play.rectangle.fill", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "prime") {
      return row(
        [
          image("play.tv.fill", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "chatgpt") {
      return row(
        [
          image("circle.hexagongrid", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "gemini") {
      return row(
        [
          image("sparkles", item.color, 15, 15)
        ],
        base
      );
    }

    if (item.kind === "grok") {
      return row(
        [
          image("xmark", item.color, 14, 14)
        ],
        base
      );
    }

    if (item.kind === "perplexity") {
      return row(
        [
          image("magnifyingglass", item.color, 14, 14)
        ],
        base
      );
    }

    const mark =
      item.kind === "netflix"
        ? "N"
        : item.kind === "disney"
          ? "D+"
          : item.kind === "deepseek"
            ? "D"
            : "AI";

    const fontSize =
      item.kind === "claude"
        ? 10
        : item.kind === "disney"
          ? 10
          : 13;

    return row(
      [
        text(mark, fontSize, "bold", item.color, {
          maxLines: 1,
          textAlign: "center"
        })
      ],
      base
    );
  }

  function compactServiceTile(item) {
    const statusColor = item.ok ? C.green : C.red;
    const serviceCountryCode =
      countryCode(item.countryCode) ||
      countryCode(exit.countryCode);

    const serviceRegionLabel = serviceCountryCode
      ? flag(serviceCountryCode) + " " + serviceCountryCode
      : "NET";

    return row(
      [
        serviceLogoLarge(item),

        col(
          [
            text(item.name, 7, "semibold", C.text, {
              maxLines: 1,
              minScale: 0.66
            }),

            row(
              [
                text(
                  serviceRegionLabel,
                  5,
                  "medium",
                  C.subtext,
                  {
                    maxLines: 1
                  }
                ),

                text(
                  item.ok ? "OK" : "失败",
                  5.6,
                  "semibold",
                  statusColor,
                  {
                    maxLines: 1
                  }
                )
              ],
              { gap: 2 }
            )
          ],
          {
            flex: 1,
            gap: 1
          }
        )
      ],
      {
        flex: 1,
        height: 31,
        padding: [4, 4],
        gap: 4,
        backgroundColor: C.tileBg,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: C.tileBorder
      }
    );
  }

  function serviceGrid(items) {
    return col(
      [
        row(
          [
            compactServiceTile(items[0]),
            compactServiceTile(items[1])
          ],
          {
            height: 31,
            gap: 5
          }
        ),

        row(
          [
            compactServiceTile(items[2]),
            compactServiceTile(items[3])
          ],
          {
            height: 31,
            gap: 5
          }
        ),

        row(
          [
            compactServiceTile(items[4]),
            compactServiceTile(items[5])
          ],
          {
            height: 31,
            gap: 5
          }
        )
      ],
      {
        flex: 1,
        height: 101,
        gap: 4
      }
    );
  }

  function serviceCard(title, symbol, items, tone) {
    const passed = items.filter(item => item.ok).length;

    return card(
      [
        sectionTitle(
          symbol,
          title,
          pill(
            passed + "/" + items.length,
            passed === items.length ? C.green : C.amber,
            passed === items.length ? C.greenSoft : C.amberSoft
          ),
          tone
        ),

        serviceGrid(items)
      ],
      {
        flex: 1,
        height: 133,
        padding: [5, 6],
        gap: 5
      }
    );
  }

  function footerCell(symbol, label, value, tone) {
    return col(
      [
        row(
          [
            image(symbol, tone, 13, 13),

            col(
              [
                text(label, 6, "medium", C.muted, {
                  maxLines: 1
                }),

                text(value, 7, "semibold", tone, {
                  maxLines: 1,
                  minScale: 0.64
                })
              ],
              {
                flex: 1,
                gap: 0
              }
            )
          ],
          {
            gap: 4
          }
        )
      ],
      {
        flex: 1,
        padding: [1, 3]
      }
    );
  }

  function footer() {
    return card(
      [
        row(
          [
            footerCell(
              "server.rack",
              "ISP / 厂商",
              shortISP(exit.isp),
              C.blue
            ),

            footerCell(
              "house.fill",
              "属性类型",
              exit.kind,
              exit.kind === "商业机房"
                ? C.amber
                : C.green
            ),

            footerCell(
              "checkmark.shield.fill",
              "纯净评分",
              purity.score + "分",
              purityColor
            ),

            footerCell(
              "shield.lefthalf.filled",
              "风险等级",
              risk,
              riskColor
            ),

            footerCell(
              "arrow.clockwise",
              "更新时间",
              timeLabel(now),
              C.purple
            )
          ],
          {
            height: 30,
            padding: [0, 0],
            gap: 0,
            alignItems: "center"
          }
        )
      ],
      {
        height: 40,
        padding: [4, 5],
        gap: 0
      }
    );
  }

  // 主界面
  const dashboard = col(
    [
      header(),
      proxyCard(),
      row(
        [
          serviceCard("流媒体解锁", "play.rectangle.fill", media, C.blue),
          serviceCard("AI 解锁检测", "sparkles", ai, C.purple)
        ],
        {
          height: 133,
          gap: 6,
          alignItems: "start"
        }
      ),
      footer()
    ],
    {
      padding: [8, 8],
      gap: 6
    }
  );

  return {
    type: "widget",
    padding: S(8),
    gap: 0,
    backgroundColor: C.root,
    refreshAfter: new Date(
      Date.now() + REFRESH_MINUTES * 60 * 1000
    ).toISOString(),
    children: [
      dashboard,
      spacer()
    ]
  };
}

// ===================== 辅助与工具函数 =====================

function palette() {
  const adaptive = (light, dark) => ({
    light: light,
    dark: dark
  });

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

function servicePolicyCandidates(serviceId, category) {
  const id = clean(serviceId).toLowerCase();
  const type = clean(category).toLowerCase();

  const commonLMT = [
    "LMT", "流媒体", "流媒体解锁", "流媒体服务", "流媒体策略", "流媒体节点",
    "全球流媒体", "国际流媒体", "国外流媒体", "海外流媒体", "全球媒体",
    "国际媒体", "国外媒体", "海外媒体", "媒体", "媒体服务", "媒体解锁",
    "影音", "影音娱乐", "影音解锁", "视频", "视频服务", "视频解锁", "串流",
    "串流媒体", "串流媒體", "流媒體", "解锁", "解鎖", "国际解锁", "海外解锁",
    "Global Media", "International Media", "Overseas Media", "Media",
    "Media Unlock", "Unlock Media", "Streaming", "Streaming Media",
    "Streaming Unlock", "Global Streaming", "International Streaming",
    "Overseas Streaming", "Proxy Media", "Stream", "Video", "Video Streaming",
    "TV", "Movie", "Movies", "Entertainment", "NETFLIX", "Netflix", "Disney",
    "Disney+", "YouTube", "Spotify", "Prime", "Prime Video", "TikTok", "HBO",
    "Max", "Hulu", "Apple TV", "Apple TV+", "Emby", "Plex", "動畫瘋", "动画疯",
    "Bahamut", "Bilibili 港澳台", "哔哩哔哩港澳台", "港台番剧", "港台"
  ];

  const commonAI = [
    "AI", "Ai", "ai", "人工智能", "人工智能服务", "AI服务", "AI 服务", "AI解锁",
    "AI 解锁", "AI平台", "AI 平台", "AI工具", "AI 工具", "AI策略", "AI 策略",
    "AI节点", "AI 节点", "AI專用", "AI专用", "AI国外", "AI海外", "全球AI",
    "国际AI", "国外AI", "海外AI", "AIGC", "AGI", "LLM", "OpenAI", "Open AI",
    "ChatGPT", "Chat GPT", "GPT", "GPT4", "GPT-4", "GPT-5", "Claude", "Anthropic",
    "Gemini", "Google AI", "Bard", "DeepSeek", "Grok", "xAI", "XAI", "Perplexity",
    "Copilot", "Microsoft Copilot", "Poe", "Notion AI", "Midjourney", "Sora",
    "Cursor", "AI Proxy", "AI Services", "AI Unlock", "AI Global"
  ];

  const serviceMap = {
    netflix: ["Netflix", "NETFLIX", "NetFlix", "NF", "奈飞", "奈飛", "网飞", "網飛"],
    disney: ["Disney+", "Disney", "Disney Plus", "DisneyPlus", "D+", "DPlus", "迪士尼"],
    spotify: ["Spotify", "SPOTIFY", "声破天", "聲破天", "音乐", "Music"],
    tiktok: ["TikTok", "Tik Tok", "TIKTOK", "TK", "抖音国际版", "国际抖音"],
    youtube: ["YouTube", "Youtube", "YOUTUBE", "YT", "油管", "Google"],
    prime: ["Prime", "Prime Video", "PrimeVideo", "Amazon Prime", "Amazon Video"],
    chatgpt: ["ChatGPT", "Chat GPT", "OpenAI", "Open AI", "GPT", "GPT4", "GPT-4"],
    claude: ["Claude", "Anthropic", "Claude AI"],
    gemini: ["Gemini", "Google AI", "Bard", "Google Bard"],
    deepseek: ["DeepSeek", "Deepseek", "DEEPSEEK", "深度求索"],
    grok: ["Grok", "grok", "GROK", "xAI", "XAI", "X AI"],
    perplexity: ["Perplexity", "PERPLEXITY", "Perplexity AI", "PPLX"]
  };

  const serviceCandidates = serviceMap[id] || [];
  return type === "ai" ? serviceCandidates.concat(commonAI) : serviceCandidates.concat(commonLMT);
}

function dedupeCandidates(values) {
  const seen = {};
  const output = [];

  (values || []).forEach(function (value) {
    const raw = clean(value);
    const key = raw.toLowerCase();

    if (!raw || seen[key]) return;
    seen[key] = true;
    output.push(raw);
  });

  return output;
}

function getLocalNetworkName(device) {
  const wifi = (device && device.wifi) || {};
  const cellular = (device && device.cellular) || {};

  const wifiName = firstMeaningful(
    wifi.ssid,
    wifi.name,
    wifi.networkName,
    getAt(device, "network.ssid"),
    getAt(device, "wifiSSID")
  );

  if (wifiName) return wifiName;

  const carrierName = firstMeaningful(
    cellular.carrier,
    cellular.carrierName,
    cellular.operator,
    cellular.operatorName,
    cellular.network,
    cellular.networkName,
    cellular.provider,
    cellular.serviceProvider,
    getAt(device, "carrier"),
    getAt(device, "carrierName"),
    getAt(device, "operator"),
    getAt(device, "operatorName")
  );

  if (carrierName) return normalizeCarrierName(carrierName);

  const code = firstMeaningful(
    cellular.mccmnc,
    cellular.mccMnc,
    cellular.plmn,
    cellular.operatorCode
  );

  const byCode = carrierByMCCMNC(code);
  if (byCode) return byCode;

  return "";
}

function firstMeaningful() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = clean(arguments[index]);
    if (value && value.toLowerCase() !== "unknown" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function normalizeCarrierName(name) {
  if (!name) return "";

  const text = name.trim();
  const lower = text.toLowerCase();

  const rules = [
    { match: ["cmcc", "chinamobile", "china mobile"], replace: "中国移动" },
    { match: ["cucc", "chinaunicom", "china unicom"], replace: "中国联通" },
    { match: ["ctcc", "chinatelecom", "china telecom"], replace: "中国电信" },
    { match: ["cbn", "chinabroadnet", "china broadnet"], replace: "中国广电" },
    { match: ["csl"], replace: "CSL" },
    { match: ["smartone"], replace: "SmarTone" },
    { match: ["3hk", "3 hk", "three hk", "hutchison"], replace: "3 HK" },
    { match: ["hkcsl", "csl hk"], replace: "CSL" },
    { match: ["cmhk", "china mobile hk"], replace: "CMHK" },
    { match: ["cht", "chunghwa"], replace: "中华电信" },
    { match: ["taiwan mobile", "twm"], replace: "台湾大哥大" },
    { match: ["fet", "fareastone"], replace: "远传电信" },
    { match: ["t star", "tstar"], replace: "台湾之星" }
  ];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    for (let k = 0; k < rule.match.length; k += 1) {
      if (lower.includes(rule.match[k]) || lower === rule.match[k]) {
        return rule.replace;
      }
    }
  }

  return text;
}

function carrierByMCCMNC(code) {
  if (!code) return "";
  const match = String(code).replace(/[^0-9]/g, "");

  const lookup = {
    "46000": "中国移动",
    "46001": "中国联通",
    "46002": "中国移动",
    "46003": "中国电信",
    "46004": "中国移动",
    "46005": "中国电信",
    "46006": "中国联通",
    "46007": "中国移动",
    "46008": "中国移动",
    "46009": "中国联通",
    "46011": "中国电信",
    "46015": "中国广电",
    "45400": "CSL",
    "45401": "CITIC",
    "45402": "CSL",
    "45403": "3 HK",
    "45404": "3 HK",
    "45405": "3 HK",
    "45406": "SmarTone",
    "45407": "China Unicom HK",
    "45408": "Truphone",
    "45409": "China Unicom HK",
    "45410": "CSL",
    "45411": "China Unicom HK",
    "45412": "CMHK",
    "45413": "CMHK",
    "45414": "Hutchison",
    "45415": "SmarTone",
    "45416": "PCCW",
    "45417": "SmarTone",
    "45418": "CSL",
    "45419": "PCCW",
    "45420": "PCCW",
    "45428": "CMHK",
    "45429": "CMHK",
    "45431": "CMHK",
    "46601": "远传电信",
    "46602": "亚太电信",
    "46603": "远传电信",
    "46605": "亚太电信",
    "46609": "亚太电信",
    "46611": "中华电信",
    "46688": "远传电信",
    "46689": "台湾之星",
    "46692": "中华电信",
    "46693": "中华电信",
    "46697": "台湾大哥大",
    "46699": "台湾大哥大"
  };

  return lookup[match] || "";
}

function carrierFromISP(text) {
  if (!text) return "";
  const lower = text.toLowerCase();

  const rules = [
    { match: ["chinamobile", "china mobile", "cmcc"], replace: "中国移动" },
    { match: ["chinaunicom", "china unicom", "cucc"], replace: "中国联通" },
    { match: ["chinatelecom", "china telecom", "ctcc"], replace: "中国电信" },
    { match: ["chinabroadnet", "china broadnet", "cbn"], replace: "中国广电" },
    { match: ["csl"], replace: "CSL" },
    { match: ["smartone"], replace: "SmarTone" },
    { match: ["3hk", "3 hk", "three hk", "hutchison"], replace: "3 HK" },
    { match: ["hkcsl", "csl hk"], replace: "CSL" },
    { match: ["cmhk", "china mobile hk"], replace: "CMHK" },
    { match: ["chunghwa", "cht"], replace: "中华电信" },
    { match: ["taiwan mobile", "twm"], replace: "台湾大哥大" },
    { match: ["fareastone", "fet"], replace: "远传电信" },
    { match: ["t star", "tstar"], replace: "台湾之星" }
  ];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    for (let k = 0; k < rule.match.length; k += 1) {
      if (lower.includes(rule.match[k])) {
        return rule.replace;
      }
    }
  }

  return "";
}

function detectDNSProvider(ips) {
  if (!ips || ips.length === 0) return { full: "", short: "" };

  for (let index = 0; index < ips.length; index += 1) {
    const ip = clean(ips[index]);

    const rules = [
      { prefix: ["223.5.5.5", "223.6.6.6", "2400:3200::1", "2400:3200:baba::1"], full: "AliDNS (阿里)", short: "阿里" },
      { prefix: ["119.29.29.29", "119.28.28.28", "2402:4e00::"], full: "DNSPod (腾讯)", short: "腾讯" },
      { prefix: ["180.76.76.76", "2400:da00::6666"], full: "BaiduDNS (百度)", short: "百度" },
      { prefix: ["114.114.114.114", "114.114.115.115"], full: "114DNS (南京信风)", short: "114" },
      { prefix: ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"], full: "Cloudflare (1.1.1.1)", short: "CF" },
      { prefix: ["8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"], full: "Google DNS (8.8.8.8)", short: "Google" },
      { prefix: ["208.67.222.222", "208.67.220.220", "2620:119:35::35", "2620:119:53::53"], full: "OpenDNS", short: "OpenDNS" },
      { prefix: ["9.9.9.9", "149.112.112.112", "2620:fe::fe", "2620:fe::9"], full: "Quad9", short: "Quad9" },
      { prefix: ["94.140.14.14", "94.140.15.15", "2a10:50c0::ad1:ff", "2a10:50c0::ad2:ff"], full: "AdGuard", short: "AdGuard" }
    ];

    for (let k = 0; k < rules.length; k += 1) {
      const rule = rules[k];
      for (let j = 0; j < rule.prefix.length; j += 1) {
        if (ip.startsWith(rule.prefix[j])) {
          return { full: rule.full, short: rule.short };
        }
      }
    }

    if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
      return { full: "Local Router (" + ip + ")", short: "路由" };
    }
  }

  return { full: "Unknown (" + clean(ips[0]) + ")", short: "" };
}

function providerFromText(text) {
  if (!text) return { full: "", short: "" };
  const lower = text.toLowerCase();

  const rules = [
    { match: ["aliyun", "alibaba", "taobao", "alipay"], full: "AliDNS (阿里)", short: "阿里" },
    { match: ["tencent", "dnspod", "wechat"], full: "DNSPod (腾讯)", short: "腾讯" },
    { match: ["baidu"], full: "BaiduDNS (百度)", short: "百度" },
    { match: ["114dns", "xinnet", "xinfeng"], full: "114DNS (南京信风)", short: "114" },
    { match: ["cloudflare"], full: "Cloudflare (1.1.1.1)", short: "CF" },
    { match: ["google"], full: "Google DNS (8.8.8.8)", short: "Google" },
    { match: ["opendns", "cisco"], full: "OpenDNS", short: "OpenDNS" },
    { match: ["quad9"], full: "Quad9", short: "Quad9" },
    { match: ["adguard"], full: "AdGuard", short: "AdGuard" },
    { match: ["telecom", "chinatelecom", "ctcc"], full: "China Telecom (中国电信)", short: "电信" },
    { match: ["unicom", "chinaunicom", "cucc"], full: "China Unicom (中国联通)", short: "联通" },
    { match: ["mobile", "chinamobile", "cmcc"], full: "China Mobile (中国移动)", short: "移动" },
    { match: ["broadnet", "cbn"], full: "China Broadnet (中国广电)", short: "广电" },
    { match: ["amazon", "aws"], full: "AWS DNS", short: "AWS" },
    { match: ["microsoft", "azure"], full: "Azure DNS", short: "Azure" }
  ];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    for (let k = 0; k < rule.match.length; k += 1) {
      if (lower.includes(rule.match[k])) {
        return { full: rule.full, short: rule.short };
      }
    }
  }

  return { full: "", short: "" };
}

function isWeakDNSLabel(label) {
  const weak = {
    "电信": true,
    "联通": true,
    "移动": true,
    "广电": true
  };
  return Boolean(weak[label]);
}

function compactDNSProviderName(text) {
  if (!text) return "未识别";
  const name = String(text);

  if (name.length <= 4) return name;
  if (name.toLowerCase().includes("telecom")) return "电信";
  if (name.toLowerCase().includes("unicom")) return "联通";
  if (name.toLowerCase().includes("mobile")) return "移动";
  if (name.toLowerCase().includes("broadnet")) return "广电";

  return name.substring(0, 4);
}

function chooseDNSProvider(base, verified) {
  if (!verified.ok || !verified.short) {
    return {
      full: base.full || "未识别 DNS",
      short: base.short || "未知"
    };
  }

  if (base.short && !isWeakDNSLabel(base.short)) {
    return {
      full: base.full,
      short: base.short
    };
  }

  return {
    full: verified.full,
    short: verified.short
  };
}

function dnsTinyLabel(text) {
  if (!text) return "未知";
  const str = String(text);

  const rules = {
    "阿里": "ALI",
    "腾讯": "TX",
    "百度": "BD",
    "电信": "TC",
    "联通": "UC",
    "移动": "MB",
    "广电": "BN",
    "路由": "LAN",
    "CF": "CF",
    "Google": "GOOG",
    "OpenDNS": "ODNS",
    "Quad9": "Q9",
    "AdGuard": "ADG",
    "AWS": "AWS",
    "Azure": "AZ"
  };

  if (rules[str]) return rules[str];
  return str.substring(0, 3).toUpperCase();
}

function protocolFromXY(value) {
  const v = clean(value);
  if (!v) return "";

  const match = String(v).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

  const rules = {
    "VLESS": "VLESS",
    "VMESS": "VMess",
    "TROJAN": "Trojan",
    "SHADOWSOCKS": "Shadowsocks",
    "SS": "Shadowsocks",
    "SHADOWSOCKSR": "ShadowsocksR",
    "SSR": "ShadowsocksR",
    "HYSTERIA": "Hysteria",
    "HYSTERIA2": "Hysteria2",
    "HY2": "Hysteria2",
    "WIREGUARD": "WireGuard",
    "WG": "WireGuard",
    "TUIC": "TUIC",
    "SNELL": "Snell",
    "HTTP": "HTTP",
    "HTTPS": "HTTPS",
    "SOCKS": "SOCKS",
    "SOCKS5": "SOCKS5",
    "ANYTLS": "AnyTLS",
    "DIRECT": "直连",
    "REJECT": "拒绝"
  };

  if (rules[match]) return rules[match];

  if (match.length <= 6) return String(v).toUpperCase();
  return String(v).substring(0, 6) + "...";
}

function parseLocalExit(data, forceMainland) {
  if (!data || typeof data !== "object") return {};

  let ip = clean(data.query) || clean(data.ip) || clean(data.ip_address);
  if (!ip) return {};

  let countryCode = countryCode(data.countryCode) || countryCode(data.country_code);

  if (forceMainland && countryCode && countryCode !== "CN") {
    countryCode = "CN";
  }

  return {
    ip: ip,
    city: clean(data.city),
    region: clean(data.regionName) || clean(data.region),
    country: clean(data.country) || clean(data.country_name),
    countryCode: countryCode,
    isp: clean(data.isp),
    org: clean(data.org),
    asname: clean(data.asname),
    as: clean(data.as)
  };
}

function parseExitSource(data, sourceName) {
  if (!data || typeof data !== "object") return {};

  let ip = "";
  let city = "";
  let region = "";
  let country = "";
  let cc = "";
  let isp = "";
  let org = "";
  let asname = "";
  let as = "";
  let proxy = false;
  let hosting = false;

  if (sourceName === "ipapi.is") {
    ip = clean(data.ip);
    const loc = data.location || {};
    const orgData = data.company || {};
    const asnData = data.asn || {};

    city = clean(loc.city);
    region = clean(loc.state);
    country = clean(loc.country);
    cc = countryCode(loc.country_code);

    isp = clean(asnData.descr);
    org = clean(orgData.name);
    asname = clean(asnData.descr);
    as = asnData.asn ? "AS" + asnData.asn : "";

    proxy = data.is_vpn || data.is_proxy || data.is_tor || data.is_abuser || data.is_bogon;
    hosting = data.is_datacenter;
  } else if (sourceName === "ip-api") {
    ip = clean(data.query);
    city = clean(data.city);
    region = clean(data.regionName);
    country = clean(data.country);
    cc = countryCode(data.countryCode);
    isp = clean(data.isp);
    org = clean(data.org);
    asname = clean(data.asname);
    as = clean(data.as);
    proxy = Boolean(data.proxy);
    hosting = Boolean(data.hosting);
  } else if (sourceName === "ipwho.is") {
    ip = clean(data.ip);
    city = clean(data.city);
    region = clean(data.region);
    country = clean(data.country);
    cc = countryCode(data.country_code);

    const con = data.connection || {};
    isp = clean(con.isp);
    org = clean(con.org);
    asname = clean(con.domain);
    as = con.asn ? "AS" + con.asn : "";

    const sec = data.security || {};
    proxy = sec.vpn || sec.proxy || sec.tor || sec.relay;
    hosting = sec.hosting;
  } else if (sourceName === "ipinfo") {
    ip = clean(data.ip);
    city = clean(data.city);
    region = clean(data.region);
    country = clean(data.country);
    cc = countryCode(data.country);
    isp = clean(data.org);
    org = clean(data.org);
    asname = "";
    as = "";

    const priv = data.privacy || {};
    proxy = priv.vpn || priv.proxy || priv.tor || priv.relay;
    hosting = priv.hosting;
  }

  return {
    ip: ip,
    city: city,
    region: region,
    country: country,
    countryCode: cc,
    isp: isp,
    org: org,
    asname: asname,
    as: as,
    flags: {
      proxy: proxy,
      hosting: hosting
    }
  };
}

function mergeExitSources(sources) {
  if (!sources || sources.length === 0) return {};
  if (sources.length === 1) return finalizeExit(sources[0]);

  const result = {
    ip: sources[0].ip,
    city: "",
    region: "",
    country: "",
    countryCode: "",
    isp: "",
    org: "",
    asname: "",
    as: "",
    flags: {
      proxy: false,
      hosting: false,
      residential: false,
      mobile: false
    }
  };

  const scoreMap = {
    city: {},
    region: {},
    country: {},
    countryCode: {},
    isp: {},
    org: {},
    asname: {},
    as: {}
  };

  sources.forEach(function (src) {
    if (src.ip !== result.ip) return;

    if (src.city) scoreMap.city[src.city] = (scoreMap.city[src.city] || 0) + 1;
    if (src.region) scoreMap.region[src.region] = (scoreMap.region[src.region] || 0) + 1;
    if (src.country) scoreMap.country[src.country] = (scoreMap.country[src.country] || 0) + 1;
    if (src.countryCode) scoreMap.countryCode[src.countryCode] = (scoreMap.countryCode[src.countryCode] || 0) + 1;
    if (src.isp) scoreMap.isp[src.isp] = (scoreMap.isp[src.isp] || 0) + 1;
    if (src.org) scoreMap.org[src.org] = (scoreMap.org[src.org] || 0) + 1;
    if (src.asname) scoreMap.asname[src.asname] = (scoreMap.asname[src.asname] || 0) + 1;
    if (src.as) scoreMap.as[src.as] = (scoreMap.as[src.as] || 0) + 1;

    if (src.flags) {
      if (src.flags.proxy) result.flags.proxy = true;
      if (src.flags.hosting) result.flags.hosting = true;
      if (src.flags.residential) result.flags.residential = true;
      if (src.flags.mobile) result.flags.mobile = true;
    }
  });

  const getBest = function (map) {
    let best = "";
    let max = 0;
    Object.keys(map).forEach(function (key) {
      if (map[key] > max) {
        best = key;
        max = map[key];
      }
    });
    return best;
  };

  result.city = getBest(scoreMap.city);
  result.region = getBest(scoreMap.region);
  result.country = getBest(scoreMap.country);
  result.countryCode = getBest(scoreMap.countryCode);
  result.isp = getBest(scoreMap.isp);
  result.org = getBest(scoreMap.org);
  result.asname = getBest(scoreMap.asname);
  result.as = getBest(scoreMap.as);

  return finalizeExit(result);
}

function finalizeExit(exit) {
  let kind = "出口网络";
  let cloudProvider = "";

  const ispInfo = [
    exit.isp,
    exit.org,
    exit.asname,
    exit.as
  ].join(" ").toLowerCase();

  const hostingKeywords = [
    "cloud", "hosting", "datacenter", "data center", "server", "vps", "host",
    "compute", "network", "technologies", "llc", "ltd", "inc", "corp",
    "alibaba", "aliyun", "tencent", "amazon", "aws", "google", "gcp", "azure",
    "microsoft", "digitalocean", "linode", "vultr", "hetzner", "ovh",
    "oracle", "ibm", "akamai", "cloudflare", "fastly", "cdn", "leaseweb",
    "dedibox", "online.net", "scaleway", "upcloud", "kamatera", "kamatera",
    "softlayer", "rackspace", "layer", "packet", "equinix", "coreweave",
    "dmit", "bwg", "bandwagon", "gigsgigs", "misaka", "kurun", "xtom",
    "x-tom", "kirino", "moack", "sharktech", "psychz", "kdatacenter",
    "kddi", "softbank", "ntt", "pccw", "hkt", "hbn", "hkbn", "wtt",
    "hkcsl", "csl", "smartone", "cmhk", "china mobile", "china telecom",
    "china unicom", "bgp", "transit", "exchange"
  ];

  const cloudMap = {
    "aliyun": "阿里云",
    "alibaba": "阿里云",
    "tencent": "腾讯云",
    "aws": "AWS",
    "amazon": "AWS",
    "google": "GCP",
    "gcp": "GCP",
    "azure": "Azure",
    "microsoft": "Azure",
    "oracle": "Oracle",
    "digitalocean": "DO",
    "linode": "Linode",
    "vultr": "Vultr",
    "hetzner": "Hetzner",
    "ovh": "OVH",
    "cloudflare": "CF",
    "akamai": "Akamai",
    "dmit": "DMIT",
    "bandwagon": "搬瓦工",
    "xtom": "xTom",
    "misaka": "Misaka",
    "kurun": "Kurun"
  };

  let isHosting = exit.flags && exit.flags.hosting;

  if (!isHosting) {
    for (let index = 0; index < hostingKeywords.length; index += 1) {
      if (ispInfo.includes(hostingKeywords[index])) {
        isHosting = true;
        break;
      }
    }
  }

  Object.keys(cloudMap).forEach(function (key) {
    if (ispInfo.includes(key)) {
      cloudProvider = cloudMap[key];
    }
  });

  if (exit.flags && exit.flags.mobile) {
    kind = "移动网络";
  } else if (exit.flags && exit.flags.residential) {
    kind = "住宅 IP";
  } else if (isHosting || cloudProvider) {
    kind = "商业机房";
  }

  exit.kind = kind;
  exit.cloudProvider = cloudProvider;

  return exit;
}

function parseProxyCheck(data, ip) {
  if (!data || typeof data !== "object") return {};
  const ipData = data[ip] || {};

  return {
    ip: ip,
    city: clean(ipData.city),
    region: clean(ipData.region),
    country: clean(ipData.country),
    countryCode: countryCode(ipData.isocode),
    isp: clean(ipData.provider),
    as: ipData.asn ? "AS" + ipData.asn.replace(/^AS/i, "") : "",
    flags: {
      proxy: ipData.proxy === "yes",
      residential: ipData.type === "Residential",
      mobile: ipData.type === "Cellular"
    }
  };
}

function parseTrace(text) {
  if (!text) return {};

  const result = {};
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const parts = line.split("=");
    if (parts.length >= 2) {
      const key = parts.shift().trim();
      const value = parts.join("=").trim();
      result[key] = value;
    }
  }

  return result;
}

function detectNAT(localIP, exitIP) {
  if (!localIP || localIP === "未识别" || !exitIP || exitIP === "未识别") {
    return {
      type: "Unknown",
      label: "未知",
      tone: "amber"
    };
  }

  const isIPv6 = function (ip) {
    return ip.indexOf(":") !== -1;
  };

  const isRFC1918 = function (ip) {
    if (isIPv6(ip)) return false;
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);

    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  };

  const isRFC6598 = function (ip) {
    if (isIPv6(ip)) return false;
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);

    return first === 100 && second >= 64 && second <= 127;
  };

  if (isIPv6(exitIP)) {
    return {
      type: "IPv6",
      label: "IPv6",
      tone: "green"
    };
  }

  if (isRFC1918(exitIP)) {
    return {
      type: "Intranet",
      label: "内网",
      tone: "amber"
    };
  }

  if (isRFC6598(exitIP)) {
    return {
      type: "CGNAT",
      label: "CGNAT",
      tone: "amber"
    };
  }

  if (localIP === exitIP) {
    return {
      type: "Open",
      label: "公网",
      tone: "green"
    };
  }

  return {
    type: "NAT",
    label: "公网",
    tone: "green"
  };
}

function purityScore(exit) {
  let score = 100;
  const reasons = [];

  const penalize = function (amount, reason) {
    score -= amount;
    reasons.push(reason);
  };

  if (!exit.ip || exit.ip === "未识别") {
    return { score: 0, reasons: ["出口未识别"] };
  }

  if (exit.flags) {
    if (exit.flags.proxy) penalize(30, "代理 IP");
    if (exit.flags.hosting) penalize(15, "数据中心 IP");
  }

  if (exit.kind === "商业机房") {
    penalize(10, "机房出口");
  } else if (exit.kind === "住宅 IP") {
    score += 5;
  } else if (exit.kind === "移动网络") {
    score += 10;
  }

  if (exit.cloudProvider) {
    penalize(5, "云厂商 (" + exit.cloudProvider + ")");
  }

  if (score > 100) score = 100;
  if (score < 0) score = 0;

  return {
    score: score,
    reasons: reasons
  };
}

function riskLevel(exit, purity) {
  if (!exit.ip || exit.ip === "未识别") return "未知";

  if (purity.score < 50) return "高风险";
  if (purity.score < 80) return "中风险";

  return "低风险";
}

function shortISP(text) {
  if (!text) return "未知厂商";

  const name = String(text);
  const parts = name.split(",");
  let str = parts[0];

  str = str.replace(/( LLC| Ltd| Inc| Corp| Corporation| Limited)$/i, "");

  if (str.length > 15) {
    str = str.substring(0, 14) + "…";
  }

  return str;
}

function toneColor(tone, C) {
  if (tone === "green") return C.green;
  if (tone === "amber") return C.amber;
  if (tone === "red") return C.red;
  if (tone === "blue") return C.blue;
  if (tone === "purple") return C.purple;
  return C.text;
}

// 缺失的工具函数实现

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
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
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    if (current === undefined || current === null) return undefined;
    current = current[parts[i]];
  }
  return current;
}

function getScreenMetric(ctx, prop) {
  if (ctx && ctx.device && ctx.device.screen) {
    return ctx.device.screen[prop];
  }
  return undefined;
}

function numberInRange(val, min, max, fallback) {
  if (typeof val !== "number" || isNaN(val)) return fallback;
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

function clamp(val, min, max) {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

function randomAlphaNum(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function maskIP(ip) {
  if (!ip || ip === "未识别" || ip === "未获取") return ip;
  const parts = ip.split(".");
  if (parts.length === 4) {
    return parts[0] + "." + parts[1] + ".*.*";
  }
  if (ip.indexOf(":") !== -1) {
    const v6Parts = ip.split(":");
    if (v6Parts.length > 4) {
      return v6Parts[0] + ":" + v6Parts[1] + ":*:*";
    }
  }
  return "***";
}

function countryCode(cc) {
  if (!cc) return "";
  const code = String(cc).trim().toUpperCase();
  if (code.length === 2) return code;
  return "";
}

function flag(cc) {
  if (!cc) return "🌐";
  const code = String(cc).trim().toUpperCase();
  if (code.length !== 2) return "🌐";

  const map = {
    "TW": "🇹🇼", "HK": "🇭🇰", "MO": "🇲🇴", "CN": "🇨🇳",
    "US": "🇺🇸", "UK": "🇬🇧", "GB": "🇬🇧", "JP": "🇯🇵",
    "KR": "🇰🇷", "SG": "🇸🇬", "MY": "🇲🇾", "TH": "🇹🇭",
    "VN": "🇻🇳", "IN": "🇮🇳", "ID": "🇮🇩", "PH": "🇵🇭",
    "RU": "🇷🇺", "DE": "🇩🇪", "FR": "🇫🇷", "IT": "🇮🇹",
    "ES": "🇪🇸", "PT": "🇵🇹", "NL": "🇳🇱", "PL": "🇵🇱",
    "SE": "🇸🇪", "CH": "🇨🇭", "TR": "🇹🇷", "CA": "🇨🇦",
    "AU": "🇦🇺", "NZ": "🇳🇿", "BR": "🇧🇷", "AR": "🇦🇷",
    "MX": "🇲🇽", "ZA": "🇿🇦", "EG": "🇪🇬", "SA": "🇸🇦",
    "AE": "🇦🇪", "IL": "🇮🇱", "IR": "🇮🇷"
  };

  if (map[code]) return map[code];

  const magic = 127397;
  return String.fromCodePoint(code.charCodeAt(0) + magic, code.charCodeAt(1) + magic);
}

function detectScheme(ctx) {
  if (ctx && ctx.device && ctx.device.scheme) {
    return ctx.device.scheme;
  }
  return "light";
}

function resolveAdaptiveColor(color, scheme) {
  if (!color || typeof color !== "object") return color;
  if (scheme === "dark" && color.dark) return color.dark;
  return color.light || color;
}

function getCurrentProxyInfo(ctx) {
  return { protocol: "Unknown" }; // 模拟的当前代理获取逻辑
}

function timeLabel(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return h + ":" + m;
}

function dateLabel(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return m + "-" + d;
}

function purityGaugeSVG(score, colors) {
  return `<svg width="68" height="52" viewBox="0 0 68 52" xmlns="http://www.w3.org/2000/svg">
    <path d="M 10 40 A 25 25 0 1 1 58 40" fill="none" stroke="${colors.track}" stroke-width="6" stroke-linecap="round"/>
    <path d="M 10 40 A 25 25 0 0 1 ${10 + (48 * score / 100)} ${40 - (30 * score / 100)}" fill="none" stroke="${score >= 75 ? colors.left : score >= 45 ? colors.glow : colors.right}" stroke-width="6" stroke-linecap="round"/>
    <text x="34" y="32" font-family="system-ui" font-size="14" font-weight="bold" fill="${colors.text}" text-anchor="middle">${score}</text>
  </svg>`;
}

function svgDataURI(svg) {
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
