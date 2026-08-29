/**
 * X/Twitter 评论区垃圾与机器人过滤脚本 (Egern JavaScript Response Script)
 * 
 * 升级版功能：
 * 1. 过滤常见黄推、黑产、TG引流。
 * 2. 动态检测上下文重复文本（自动剔除批量控评/水军）。
 * 3. 正则匹配高频同质化擦边引流句式。
 */

function cleanTwitterComments() {
    let body = $response.body;
    if (!body) {
        $done({});
        return;
    }

    try {
        let obj = JSON.parse(body);

        // 1. 垃圾文本与擦边引流正则黑名单（包含截图中高频特征）
        const botTextRegexes = [
            // 截图中的高频重复黄推/引流句式及其变体
            /比[她我]好看的没[她我]骚|比[她我]骚的没[她我]好看/i,

            // 黄推与色情引流
            /看[主主]页|私[信信]|加[微微]|约[炮炮]|自[慰慰]|裸[聊聊]|高潮|门槛|福利|黑料|探花|换妻|黄片|偷拍|视频|国产|精选|反差|爆料/i,
            /🔞|🔞+|👙|💦|🍑/i,
            
            // TG/微信/社交账号引流
            /t\.me\/|telegram|加[tgTG]|电报|联系方式|➕[vV]|➕[qQ]|微信|企鹅|QQ群/i,
            /tg[:：]\s*@/i,

            // 赌博、彩票、黑产、代充
            /博彩|棋牌|菠菜|返利|刷单|兼职|出海|卡密|USDT|虚拟币|接单|稳赚|日进|提现|开挂/i,
            
            // 常见同质化引流/无意义字符组合
            /^[\s\.\,\!\?~～]+$/
        ];

        // 2. 静态灌水词集
        const spamShortTexts = new Set([
            "haha", "hahaha", "lmao", "lol", "nice", "good", "cool", "yes", "no",
            "哈哈", "哈哈哈", "哈哈哈哈", "支持", "好", "对", "确实", "牛逼", "卧槽", "转发了", "666", "111", "顶"
        ]);

        // 动态重复文本计数统计表（基于当前 JSON 响应上下文，超过 2 次相同去标点文本即判定为水军）
        const textOccurrences = new Map();

        // 提取核心纯文本（去除表情符号、空格、提及的 @ 账号，方便计算文本相似度）
        function normalizeText(text) {
            return (text || "")
                .replace(/@[a-zA-Z0-9_]+/g, "") // 移除 @账号
                .replace(/[\s\p{P}\p{S}]/gu, "")  // 移除空格、标点符号与 Emoji
                .toLowerCase();
        }

        // 第一次遍历：预统计整页评论的文本出现频率
        function scanOccurrences(entries) {
            if (!Array.isArray(entries)) return;
            for (let entry of entries) {
                const tweetResult = entry?.content?.itemContent?.tweet_results;
                const realResult = tweetResult?.result?.typeName === "TweetWithVisibilityResults" 
                    ? tweetResult.result.tweet 
                    : (tweetResult?.result || tweetResult);
                
                const rawText = realResult?.legacy?.full_text;
                if (rawText) {
                    const norm = normalizeText(rawText);
                    if (norm.length >= 4) { // 只统计 4 字以上的短句
                        textOccurrences.set(norm, (textOccurrences.get(norm) || 0) + 1);
                    }
                }
            }
        }

        // 3. 核心判断逻辑
        function isSpamTweet(tweetResult) {
            if (!tweetResult) return false;

            const realResult = tweetResult.result?.typeName === "TweetWithVisibilityResults" 
                ? tweetResult.result.tweet 
                : (tweetResult.result || tweetResult);

            const legacy = realResult?.legacy;
            const userLegacy = realResult?.core?.user_results?.result?.legacy;

            if (!legacy) return false;

            const text = (legacy.full_text || "").trim();
            const lowerText = text.toLowerCase();

            // 特征 A：直接匹配正则库（包含图片中的“比她好看的没她骚...”）
            for (let reg of botTextRegexes) {
                if (reg.test(text)) {
                    return true;
                }
            }

            // 特征 B：静态简单灌水词
            if (spamShortTexts.has(lowerText)) {
                return true;
            }

            // 特征 C：上下文动态重复检测（当同屏/同一批加载中，重复出现 ≥ 2 次的文本）
            const normText = normalizeText(text);
            if (normText.length >= 4 && (textOccurrences.get(normText) || 0) >= 2) {
                return true;
            }

            // 特征 D：账号特征判定
            if (userLegacy) {
                const followersCount = userLegacy.followers_count || 0;
                const defaultProfileImage = userLegacy.default_profile_image || false;
                const description = userLegacy.description || "";

                if (defaultProfileImage && /https?:\/\//i.test(text)) {
                    return true;
                }

                if (followersCount < 2 && (/(t\.me|微信|加|福利)/i.test(description) || /(t\.me|微信|加|福利)/i.test(text))) {
                    return true;
                }
            }

            return false;
        }

        // 4. 清洗 Entry 结构
        function filterEntries(entries) {
            if (!Array.isArray(entries)) return entries;

            // 预扫描计数
            scanOccurrences(entries);

            return entries.filter(entry => {
                const entryType = entry?.content?.entryType;

                if (entryType === "TimelineTimelineItem") {
                    const tweetResult = entry?.content?.itemContent?.tweet_results;
                    if (isSpamTweet(tweetResult)) {
                        return false;
                    }
                }

                if (entryType === "TimelineTimelineModule") {
                    const items = entry?.content?.items;
                    if (Array.isArray(items)) {
                        entry.content.items = items.filter(item => {
                            const tweetResult = item?.item?.itemContent?.tweet_results;
                            return !isSpamTweet(tweetResult);
                        });
                        if (entry.content.items.length === 0) {
                            return false;
                        }
                    }
                }

                return true;
            });
        }

        // 5. 解析并清洗 GraphQL 指令集
        const instructions = obj?.data?.threaded_conversation_with_injections_v2?.instructions 
                           || obj?.data?.tweetResult?.result?.timeline?.instructions;

        if (Array.isArray(instructions)) {
            for (let inst of instructions) {
                if (inst.type === "TimelineAddEntries" && Array.isArray(inst.entries)) {
                    inst.entries = filterEntries(inst.entries);
                } else if (inst.type === "TimelineAddToModule" && Array.isArray(inst.moduleItems)) {
                    inst.moduleItems = inst.moduleItems.filter(item => {
                        const tweetResult = item?.item?.itemContent?.tweet_results;
                        return !isSpamTweet(tweetResult);
                    });
                }
            }
        }

        $done({ body: JSON.stringify(obj) });
    } catch (e) {
        $done({ body });
    }
}

cleanTwitterComments();
