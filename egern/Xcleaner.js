/**
 * Xcleaner for Egern (评论区专用)
 * 仅处理评论相关 GraphQL API，不影响其他请求
 * 规则：高置信度垃圾检测，兼容未知结构，原样返回未知响应
 */

(function() {
    // 安全获取响应体
    if (typeof $response === 'undefined' || !$response || typeof $response.body !== 'string' || !$response.body) {
        $done({});
        return;
    }

    const rawBody = $response.body;

    // 解析 JSON
    let obj;
    try {
        obj = JSON.parse(rawBody);
    } catch (e) {
        // 非 JSON 原样返回
        $done({ body: rawBody });
        return;
    }

    // ----------------------------------------------
    // 1. 垃圾文本规则（高置信度）
    // ----------------------------------------------
    const spamPatterns = [
        // 色情 / 引流
        /约炮|约\s*炮|自慰|自\s*慰|裸聊|裸\s*聊|色情|成人视频|黄片|淫秽/i,
        /探花|换妻|高潮|色情直播|裸照|私房照|福利姬/i,
        /t\.me\/[a-z0-9_]+/i,
        /telegram\s*[:：]?\s*@?[a-z0-9_]+/i,
        /tg\s*[:：]\s*@/i,
        /电报\s*[:：]?\s*@/i,
        /加我微信|添加微信|联系微信|微信号|微信\s*[:：]/i,
        /vx\s*[:：]\s*[a-z0-9_-]{4,}/i,
        /v信|微\s*信\s*[:：]/i,
        /qq群|QQ群|加群|进群\s*[:：]?\s*[0-9]{5,}/i,
        /博彩|赌博|赌场|投注平台|博彩网|棋牌下注|下注送彩金|返水|送彩金/i,
        /刷单|刷单返利|兼职日结|日赚[0-9]+|轻松月入|在家兼职|稳赚不赔/i,
        /稳赚|保本高收益|高收益|投资返利|USDT.*(?:返|赚|收益)/i,
        /(?:联系|咨询|添加|私聊).{0,8}(?:微信|TG|telegram|电报|QQ)/i,
        /🔞.*(?:加|私|联系|微信|tg|telegram)/i,
        /(?:👙|💦|🍑).*(?:加|私|联系|微信|tg|telegram)/i,

        // 新增：固定文案垃圾评论（您提供的样本）
        /比她好看的没她骚比她骚的没她好看\s*@\S+/i,
        /比[她我]好看的没[她我]骚|比[她我]骚的没[她我]好看/i,
        // 可继续追加其他重复文案
        /加我微信领取福利\s*@\S+/i,
        /点击主页有惊喜/i
    
    ];

    // ----------------------------------------------
    // 2. 辅助函数
    // ----------------------------------------------
    function normalizeText(text) {
        return String(text || "")
            .replace(/@[a-zA-Z0-9_]+/g, "")
            .replace(/\s+/g, "")
            .replace(/[\p{P}\p{S}]/gu, "")
            .toLowerCase();
    }

    // 获取 tweet 结果对象（兼容各种嵌套）
    function getTweetResult(tweetResult) {
        if (!tweetResult || typeof tweetResult !== 'object') return null;
        try {
            const result = tweetResult.result;
            if (result && result.typeName === 'TweetWithVisibilityResults') {
                return result.tweet || null;
            }
            return result || tweetResult;
        } catch (e) {
            return null;
        }
    }

    // 获取 tweet 文本
    function getTweetText(tweetResult) {
        const tweet = getTweetResult(tweetResult);
        if (!tweet) return '';
        try {
            return String(
                tweet?.legacy?.full_text ||
                tweet?.note_tweet?.note_tweet_results?.result?.text ||
                ''
            ).trim();
        } catch (e) {
            return '';
        }
    }

    // 获取用户信息
    function getUserLegacy(tweetResult) {
        const tweet = getTweetResult(tweetResult);
        if (!tweet) return null;
        try {
            return tweet?.core?.user_results?.result?.legacy || null;
        } catch (e) {
            return null;
        }
    }

    // 文本是否包含任一关键词
    function containsAny(text, words) {
        if (!text) return false;
        const lower = text.toLowerCase();
        for (const w of words) {
            if (lower.includes(w.toLowerCase())) return true;
        }
        return false;
    }

    // 是否存在联系方式信号
    function hasContactSignal(text) {
        if (!text) return false;
        return (
            /https?:\/\/\S+/i.test(text) ||
            /t\.me\/\S+/i.test(text) ||
            /telegram/i.test(text) ||
            /微信\s*[:：]/i.test(text) ||
            /vx\s*[:：]/i.test(text) ||
            /qq\s*[:：]?\s*[0-9]{5,}/i.test(text) ||
            /@[a-zA-Z0-9_]{4,}/.test(text)
        );
    }

    // ----------------------------------------------
    // 3. 垃圾判断核心
    // ----------------------------------------------
    function isSpamTweet(tweetResult) {
        if (!tweetResult) return false;
        try {
            const tweet = getTweetResult(tweetResult);
            if (!tweet) return false;
            const legacy = tweet.legacy;
            if (!legacy) return false;

            const text = getTweetText(tweetResult);
            if (!text) return false;
            const lowerText = text.toLowerCase();

            // A. 强规则正则
            for (const regex of spamPatterns) {
                if (regex.test(text)) return true;
            }

            // B. 短文本重复（可根据需要增加）
            const shortSpam = new Set(['哈哈哈哈', '哈哈哈哈哈', '666666', '111111']);
            if (shortSpam.has(lowerText)) return true;

            // C. 组合判断（色情/推广/博彩 + 联系方式）
            const adultWords = ['裸','黄片','偷拍','色情','高潮','约炮','自慰','换妻','探花','福利姬'];
            const promotionWords = ['福利','私信','主页','联系方式','加我','加v','加V','电报','telegram','tg','微信','QQ群','进群'];
            const gamblingWords = ['博彩','赌博','棋牌','下注','返水','刷单','返利','稳赚','日赚'];

            if (containsAny(text, adultWords) && hasContactSignal(text)) return true;
            if (containsAny(text, promotionWords) && hasContactSignal(text)) return true;
            if (containsAny(text, gamblingWords) && hasContactSignal(text)) return true;

            // D. 用户资料辅助（极低质量 + 推广文本 + 联系方式）
            const userLegacy = getUserLegacy(tweetResult);
            if (userLegacy) {
                const followers = Number(userLegacy.followers_count || 0);
                const defaultProfile = userLegacy.default_profile_image === true;
                const desc = String(userLegacy.description || '');
                const profileHasPromo = containsAny(desc, [...adultWords, ...promotionWords, ...gamblingWords]);
                const textHasPromo = containsAny(text, [...adultWords, ...promotionWords, ...gamblingWords]);
                if (followers <= 1 && defaultProfile && profileHasPromo && (textHasPromo || hasContactSignal(text))) {
                    return true;
                }
            }

            return false;
        } catch (e) {
            // 任何异常都视为非垃圾，保证稳定性
            return false;
        }
    }

    // ----------------------------------------------
    // 4. 处理 TimelineAddEntries
    // ----------------------------------------------
    function processAddEntries(inst) {
        if (!inst || !Array.isArray(inst.entries)) return;
        const filtered = [];
        for (const entry of inst.entries) {
            try {
                // 获取 tweet 结果
                const content = entry?.content;
                if (!content || content.entryType !== 'TimelineTimelineItem') {
                    filtered.push(entry);
                    continue;
                }
                const tweetResult = content?.itemContent?.tweet_results;
                if (!tweetResult) {
                    filtered.push(entry);
                    continue;
                }
                if (isSpamTweet(tweetResult)) {
                    continue; // 删除该条目
                }
                filtered.push(entry);
            } catch (e) {
                // 出错则保留
                filtered.push(entry);
            }
        }
        inst.entries = filtered;
    }

    // ----------------------------------------------
    // 5. 处理 TimelineAddToModule
    // ----------------------------------------------
    function processAddToModule(inst) {
        if (!inst || !Array.isArray(inst.moduleItems)) return;
        const filtered = [];
        for (const item of inst.moduleItems) {
            try {
                const tweetResult = item?.item?.itemContent?.tweet_results;
                if (!tweetResult) {
                    filtered.push(item);
                    continue;
                }
                if (isSpamTweet(tweetResult)) {
                    continue;
                }
                filtered.push(item);
            } catch (e) {
                filtered.push(item);
            }
        }
        inst.moduleItems = filtered;
    }

    // ----------------------------------------------
    // 6. 递归查找所有包含 instructions 的对象
    // ----------------------------------------------
    function findAllInstructionArrays(root) {
        const result = [];
        const stack = [root];
        while (stack.length) {
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            // 检查是否有 instructions 数组
            if (current.instructions && Array.isArray(current.instructions)) {
                const hasTarget = current.instructions.some(inst =>
                    inst.type === 'TimelineAddEntries' || inst.type === 'TimelineAddToModule'
                );
                if (hasTarget) {
                    result.push(current.instructions);
                }
            }
            // 遍历所有属性
            for (const key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    const val = current[key];
                    if (val && typeof val === 'object') {
                        stack.push(val);
                    }
                }
            }
        }
        return result;
    }

    // ----------------------------------------------
    // 7. 主处理
    // ----------------------------------------------
    try {
        const instructionsArrays = findAllInstructionArrays(obj);
        if (instructionsArrays.length === 0) {
            // 没有找到目标指令，原样返回
            $done({ body: rawBody });
            return;
        }

        for (const instructions of instructionsArrays) {
            if (!Array.isArray(instructions)) continue;
            for (const inst of instructions) {
                if (!inst || typeof inst !== 'object') continue;
                if (inst.type === 'TimelineAddEntries') {
                    processAddEntries(inst);
                } else if (inst.type === 'TimelineAddToModule') {
                    processAddToModule(inst);
                }
                // 其他类型（如 TimelineClearEntries、Cursor 等）不做任何修改
            }
        }

        // 返回修改后的 JSON
        $done({ body: JSON.stringify(obj) });
    } catch (e) {
        // 任何异常都返回原始内容
        $done({ body: rawBody });
    }
})();
