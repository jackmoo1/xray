/**
 * X/Twitter 评论区垃圾与机器人过滤脚本
 * 适配 Egern JavaScript API (http_response)
 */

(function cleanTwitterComments() {
    // 官方 API 校验：如果获取不到 response 或 body，直接退出并释放请求
    if (typeof $response === "undefined" || !$response || !$response.body) {
        $done({});
        return;
    }

    const rawBody = $response.body;

    try {
        let obj = JSON.parse(rawBody);

        // 1. 垃圾文本与正则黑名单
        const botTextRegexes = [
            /比[她我]好看的没[她我]骚|比[她我]骚的没[她我]好看/i,
            /看[主主]页|私[信信]|加[微微]|约[炮炮]|自[慰慰]|裸[聊聊]|高潮|门槛|福利|黑料|探花|换妻|黄片|偷拍|视频|国产|精选|反差|爆料/i,
            /🔞|👙|💦|🍑/i,
            /t\.me\/|telegram|加[tgTG]|电报|联系方式|➕[vV]|➕[qQ]|微信|企鹅|QQ群/i,
            /tg[:：]\s*@/i,
            /博彩|棋牌|菠菜|返利|刷单|兼职|出海|卡密|USDT|虚拟币|接单|稳赚|日进|提现|开挂/i,
            /^[\s\.\,\!\?~～]+$/
        ];

        // 2. 静态灌水黑名单
        const spamShortTexts = new Set([
            "haha", "hahaha", "lmao", "lol", "nice", "good", "cool", "yes", "no",
            "哈哈", "哈哈哈", "哈哈哈哈", "支持", "好", "对", "确实", "牛逼", "卧槽", "转发了", "666", "111", "顶"
        ]);

        // 3. 上下文去重统计
        const textOccurrences = new Map();

        function normalizeText(text) {
            return (text || "")
                .replace(/@[a-zA-Z0-9_]+/g, "")
                .replace(/[\s\p{P}\p{S}]/gu, "")
                .toLowerCase();
        }

        function scanOccurrences(entries) {
            if (!Array.isArray(entries)) return;
            for (let entry of entries) {
                try {
                    const tweetResult = entry?.content?.itemContent?.tweet_results;
                    const realResult = tweetResult?.result?.typeName === "TweetWithVisibilityResults" 
                        ? tweetResult.result.tweet 
                        : (tweetResult?.result || tweetResult);
                    
                    const rawText = realResult?.legacy?.full_text;
                    if (rawText) {
                        const norm = normalizeText(rawText);
                        if (norm.length >= 4) {
                            textOccurrences.set(norm, (textOccurrences.get(norm) || 0) + 1);
                        }
                    }
                } catch (e) {}
            }
        }

        function isSpamTweet(tweetResult) {
            if (!tweetResult) return false;

            try {
                const realResult = tweetResult.result?.typeName === "TweetWithVisibilityResults" 
                    ? tweetResult.result.tweet 
                    : (tweetResult.result || tweetResult);

                const legacy = realResult?.legacy;
                const userLegacy = realResult?.core?.user_results?.result?.legacy;

                if (!legacy) return false;

                const text = (legacy.full_text || "").trim();
                const lowerText = text.toLowerCase();

                // 规则 A: 正则匹配
                for (let reg of botTextRegexes) {
                    if (reg.test(text)) return true;
                }

                // 规则 B: 静态极短词
                if (spamShortTexts.has(lowerText)) return true;

                // 规则 C: 同屏重复出现 ≥ 2 次
                const normText = normalizeText(text);
                if (normText.length >= 4 && (textOccurrences.get(normText) || 0) >= 2) {
                    return true;
                }

                // 规则 D: 账号特征
                if (userLegacy) {
                    const followersCount = userLegacy.followers_count || 0;
                    const defaultProfileImage = userLegacy.default_profile_image || false;
                    const description = userLegacy.description || "";

                    if (defaultProfileImage && /https?:\/\//i.test(text)) return true;
                    if (followersCount < 2 && (/(t\.me|微信|加|福利)/i.test(description) || /(t\.me|微信|加|福利)/i.test(text))) {
                        return true;
                    }
                }
            } catch (err) {
                return false;
            }

            return false;
        }

        function filterEntries(entries) {
            if (!Array.isArray(entries)) return entries;
            scanOccurrences(entries);

            return entries.filter(entry => {
                try {
                    const entryType = entry?.content?.entryType;

                    if (entryType === "TimelineTimelineItem") {
                        const tweetResult = entry?.content?.itemContent?.tweet_results;
                        if (isSpamTweet(tweetResult)) return false;
                    }

                    if (entryType === "TimelineTimelineModule") {
                        const items = entry?.content?.items;
                        if (Array.isArray(items)) {
                            entry.content.items = items.filter(item => {
                                const tweetResult = item?.item?.itemContent?.tweet_results;
                                return !isSpamTweet(tweetResult);
                            });
                            if (entry.content.items.length === 0) return false;
                        }
                    }
                } catch (e) {
                    return true;
                }
                return true;
            });
        }

        // 提取并清洗评论区指令集
        const instructions = obj?.data?.threaded_conversation_with_injections_v2?.instructions 
                           || obj?.data?.tweetResult?.result?.timeline?.instructions;

        if (Array.isArray(instructions)) {
            for (let inst of instructions) {
                if (inst?.type === "TimelineAddEntries" && Array.isArray(inst.entries)) {
                    inst.entries = filterEntries(inst.entries);
                } else if (inst?.type === "TimelineAddToModule" && Array.isArray(inst.moduleItems)) {
                    inst.moduleItems = inst.moduleItems.filter(item => {
                        const tweetResult = item?.item?.itemContent?.tweet_results;
                        return !isSpamTweet(tweetResult);
                    });
                }
            }
        }

        // 官方 API 规约：成功处理后以对象形式提交 JSON 字符串
        $done({ body: JSON.stringify(obj) });

    } catch (globalError) {
        // 兜底策略：遇到无法解析的非 JSON 或执行崩溃时，原样退回 rawBody
        $done({ body: rawBody });
    }
})();
