/**
 * Xcleaner V2
 * X / Twitter 评论区垃圾与机器人过滤
 *
 * 适配：
 *   Egern JavaScript API
 *   http_response
 *
 * 设计目标：
 *   1. 只过滤高置信度垃圾评论
 *   2. 不破坏 X Conversation Timeline
 *   3. 不删除 Cursor / Pagination
 *   4. 不删除整个 Timeline Module
 *   5. 未知 JSON 结构默认放行
 *   6. 尽量降低正常评论误杀
 */

(function XcleanerV2() {

    /* =========================================================
     * 0. 基础检查
     * ======================================================= */

    if (
        typeof $response === "undefined" ||
        !$response ||
        typeof $response.body !== "string" ||
        !$response.body
    ) {
        $done({});
        return;
    }

    const rawBody = $response.body;


    /* =========================================================
     * 1. JSON 解析
     *
     * 非 JSON / 无法解析：
     *     原样返回
     *
     * 这是非常重要的保护机制。
     * ======================================================= */

    let obj;

    try {
        obj = JSON.parse(rawBody);
    } catch (e) {
        $done({
            body: rawBody
        });
        return;
    }


    /* =========================================================
     * 2. 垃圾文本规则
     *
     * 原脚本部分规则过于宽泛。
     *
     * 这里改为：
     *   高置信度关键词优先
     *   尽量避免单个普通词直接误杀
     * ======================================================= */

    const strongSpamRegexes = [

        // 色情 / 色情引流
        /约炮|约\s*炮|自慰|自\s*慰|裸聊|裸\s*聊|色情|成人视频|黄片|淫秽|成人视频|成人视频/i,

        // 色情推广
        /探花|换妻|高潮|色情直播|裸照|私房照|福利姬|成人视频|成人视频/i,

        // Telegram / TG 引流
        /t\.me\/[a-z0-9_]+/i,
        /telegram\s*[:：]?\s*@?[a-z0-9_]+/i,
        /tg\s*[:：]\s*@/i,
        /电报\s*[:：]?\s*@/i,

        // 微信 / 联系方式引流
        /加我微信|添加微信|联系微信|微信号|微信\s*[:：]/i,
        /vx\s*[:：]\s*[a-z0-9_-]{4,}/i,
        /v信|微\s*信\s*[:：]/i,

        // QQ / QQ群
        /qq群|QQ群|加群|进群\s*[:：]?\s*[0-9]{5,}/i,

        // 博彩
        /博彩|赌博|赌场|投注平台|博彩网|棋牌下注|下注送彩金|返水|送彩金/i,

        // 刷单 / 诈骗 / 兼职
        /刷单|刷单返利|兼职日结|日赚[0-9]+|轻松月入|在家兼职|稳赚不赔/i,

        // 虚拟币诈骗 / 投资诱导
        /稳赚|保本高收益|高收益|投资返利|USDT.*(?:返|赚|收益)/i,

        // 明确广告联系方式
        /(?:联系|咨询|添加|私聊).{0,8}(?:微信|TG|telegram|电报|QQ)/i,

        // 色情 Emoji 组合
        /🔞.*(?:加|私|联系|微信|tg|telegram)/i,
        /(?:👙|💦|🍑).*(?:加|私|联系|微信|tg|telegram)/i
    ];


    /* =========================================================
     * 3. 中等风险规则
     *
     * 单独出现不一定删除。
     *
     * 必须与：
     *   联系方式 / 引流 / 色情 / 推广
     *
     * 等信号组合后才过滤。
     * ======================================================= */

    const promotionWords = [
        "福利",
        "私信",
        "主页",
        "联系方式",
        "加我",
        "加v",
        "加V",
        "电报",
        "telegram",
        "tg",
        "微信",
        "QQ群",
        "进群"
    ];


    const adultWords = [
        "裸",
        "黄片",
        "偷拍",
        "色情",
        "高潮",
        "约炮",
        "自慰",
        "换妻",
        "探花",
        "福利姬"
    ];


    const gamblingWords = [
        "博彩",
        "赌博",
        "棋牌",
        "下注",
        "返水",
        "刷单",
        "返利",
        "稳赚",
        "日赚"
    ];


    /* =========================================================
     * 4. 极短灌水词
     *
     * 原脚本把：
     *   good / nice / yes / no
     *
     * 直接判定为垃圾。
     *
     * 这个误杀风险太高。
     *
     * 因此这里只保留明显的无意义重复灌水。
     * ======================================================= */

    const spamShortTexts = new Set([
        "哈哈哈哈",
        "哈哈哈哈哈",
        "666666",
        "111111",
        "顶顶顶",
        "支持支持",
        "牛逼牛逼",
        "卧槽卧槽"
    ]);


    /* =========================================================
     * 5. 文本标准化
     * ======================================================= */

    function normalizeText(text) {
        return String(text || "")
            .replace(/@[a-zA-Z0-9_]+/g, "")
            .replace(/\s+/g, "")
            .replace(/[\p{P}\p{S}]/gu, "")
            .toLowerCase();
    }


    /* =========================================================
     * 6. 安全获取 Tweet
     *
     * X 不同版本可能出现：
     *
     *   tweet_results.result
     *   TweetWithVisibilityResults
     *   tweet_results
     *
     * 所以统一在这里处理。
     * ======================================================= */

    function getTweetResult(tweetResult) {

        if (!tweetResult || typeof tweetResult !== "object") {
            return null;
        }

        try {

            const result = tweetResult.result;

            if (
                result &&
                result.typeName === "TweetWithVisibilityResults"
            ) {
                return result.tweet || null;
            }

            if (result && typeof result === "object") {
                return result;
            }

            return tweetResult;

        } catch (e) {
            return null;
        }
    }


    /* =========================================================
     * 7. 获取 Tweet 文本
     * ======================================================= */

    function getTweetText(tweetResult) {

        const tweet = getTweetResult(tweetResult);

        if (!tweet) {
            return "";
        }

        try {
            return String(
                tweet?.legacy?.full_text ||
                tweet?.note_tweet?.note_tweet_results?.result?.text ||
                ""
            ).trim();
        } catch (e) {
            return "";
        }
    }


    /* =========================================================
     * 8. 获取用户信息
     * ======================================================= */

    function getUserLegacy(tweetResult) {

        const tweet = getTweetResult(tweetResult);

        if (!tweet) {
            return null;
        }

        try {
            return tweet?.core?.user_results?.result?.legacy || null;
        } catch (e) {
            return null;
        }
    }


    /* =========================================================
     * 9. 判断是否包含数组中的关键词
     * ======================================================= */

    function containsAny(text, words) {

        if (!text) {
            return false;
        }

        const lower = text.toLowerCase();

        for (const word of words) {

            if (lower.includes(word.toLowerCase())) {
                return true;
            }
        }

        return false;
    }


    /* =========================================================
     * 10. URL / 联系方式检测
     * ======================================================= */

    function hasContactSignal(text) {

        if (!text) {
            return false;
        }

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


    /* =========================================================
     * 11. 高置信度垃圾判断
     *
     * 核心原则：
     *
     *   不因为一个普通关键词删除。
     *
     *   不因为默认头像删除。
     *
     *   不因为粉丝少删除。
     *
     *   不因为 URL 单独存在删除。
     *
     * ======================================================= */

    function isSpamTweet(tweetResult) {

        if (!tweetResult) {
            return false;
        }

        try {

            const tweet = getTweetResult(tweetResult);

            if (!tweet) {
                return false;
            }

            const legacy = tweet.legacy;

            if (!legacy) {
                return false;
            }

            const text = getTweetText(tweetResult);

            if (!text) {
                return false;
            }

            const lowerText = text.toLowerCase();


            /* -------------------------------------------------
             * A. 明确垃圾正则
             * ------------------------------------------------ */

            for (const regex of strongSpamRegexes) {

                if (regex.test(text)) {
                    return true;
                }
            }


            /* -------------------------------------------------
             * B. 明显无意义重复灌水
             * ------------------------------------------------ */

            if (spamShortTexts.has(lowerText)) {
                return true;
            }


            /* -------------------------------------------------
             * C. 色情词 + 引流信号
             * ------------------------------------------------ */

            if (
                containsAny(text, adultWords) &&
                hasContactSignal(text)
            ) {
                return true;
            }


            /* -------------------------------------------------
             * D. 推广词 + 联系方式
             * ------------------------------------------------ */

            if (
                containsAny(text, promotionWords) &&
                hasContactSignal(text)
            ) {
                return true;
            }


            /* -------------------------------------------------
             * E. 博彩 / 刷单词 + 联系方式
             * ------------------------------------------------ */

            if (
                containsAny(text, gamblingWords) &&
                hasContactSignal(text)
            ) {
                return true;
            }


            /* -------------------------------------------------
             * F. 用户资料辅助判断
             *
             * 注意：
             *   默认头像本身绝不删除。
             *   粉丝少本身绝不删除。
             *
             * 只有“低质量账号 + 明确引流文本”
             * 才过滤。
             * ------------------------------------------------ */

            const userLegacy = getUserLegacy(tweetResult);

            if (userLegacy) {

                const followersCount =
                    Number(userLegacy.followers_count || 0);

                const description =
                    String(userLegacy.description || "");

                const defaultProfileImage =
                    userLegacy.default_profile_image === true;


                const profileHasPromotion =
                    containsAny(
                        description,
                        promotionWords.concat(
                            adultWords,
                            gamblingWords
                        )
                    );


                const textHasPromotion =
                    containsAny(
                        text,
                        promotionWords.concat(
                            adultWords,
                            gamblingWords
                        )
                    );


                /*
                 * 只有同时满足：
                 *
                 *   粉丝极少
                 *   + 默认头像
                 *   + 资料/评论存在明显推广信号
                 *   + 评论存在联系方式
                 *
                 * 才判定垃圾。
                 */
                if (
                    followersCount <= 1 &&
                    defaultProfileImage &&
                    profileHasPromotion &&
                    (textHasPromotion || hasContactSignal(text))
                ) {
                    return true;
                }
            }

        } catch (e) {

            /*
             * 任何异常：
             *
             *   不过滤
             *
             * 这是防止脚本破坏 X 评论加载的关键。
             */
            return false;
        }

        return false;
    }


    /* =========================================================
     * 12. 判断一个 Entry 是否为可过滤 Tweet
     *
     * 如果无法确认：
     *   返回 null
     *
     * null = 不处理
     * ======================================================= */

    function getTweetFromEntry(entry) {

        if (!entry || typeof entry !== "object") {
            return null;
        }

        try {

            const content = entry.content;

            if (!content) {
                return null;
            }


            /*
             * TimelineTimelineItem
             */
            if (
                content.entryType === "TimelineTimelineItem"
            ) {

                return (
                    content?.itemContent?.tweet_results ||
                    null
                );
            }


            /*
             * TimelineTimelineModule
             *
             * Module 内部由 filterModuleItems()
             * 单独处理。
             */
            return null;

        } catch (e) {
            return null;
        }
    }


    /* =========================================================
     * 13. 过滤普通 Timeline Item
     *
     * 只有确定是 Tweet 并且明确垃圾：
     *
     *   删除 Entry
     *
     * Cursor / 非 Tweet Entry：
     *   原样保留
     * ======================================================= */

    function filterTimelineItem(entry) {

        try {

            const tweetResult = getTweetFromEntry(entry);

            if (!tweetResult) {
                return entry;
            }

            if (isSpamTweet(tweetResult)) {
                return null;
            }

            return entry;

        } catch (e) {

            return entry;
        }
    }


    /* =========================================================
     * 14. 过滤 Module 内的 Tweet
     *
     * 非 Tweet item：
     *   永远保留
     *
     * 垃圾 Tweet：
     *   删除
     *
     * 正常 Tweet：
     *   保留
     *
     * Module 本身：
     *   永远保留
     *
     * 即使 items 最后为空：
     *   也不删除 Module。
     *
     * 这是修复评论分页的重要变化。
     * ======================================================= */

    function filterModuleItems(moduleItems) {

        if (!Array.isArray(moduleItems)) {
            return moduleItems;
        }

        const result = [];

        for (const item of moduleItems) {

            try {

                const tweetResult =
                    item?.item?.itemContent?.tweet_results;

                /*
                 * 不是 Tweet：
                 *   直接保留。
                 */
                if (!tweetResult) {
                    result.push(item);
                    continue;
                }


                /*
                 * Tweet 是垃圾：
                 *   只删除这个 item。
                 */
                if (isSpamTweet(tweetResult)) {
                    continue;
                }


                /*
                 * 正常 Tweet：
                 *   保留。
                 */
                result.push(item);

            } catch (e) {

                /*
                 * 出现异常：
                 *   保留原 item。
                 */
                result.push(item);
            }
        }

        return result;
    }


    /* =========================================================
     * 15. 处理 TimelineAddEntries
     *
     * 注意：
     *
     * 不重新构造 instructions。
     * 不移动 entry。
     * 不修改 cursor。
     * 只删除确定的垃圾 Tweet Entry。
     * ======================================================= */

    function processAddEntries(inst) {

        if (
            !inst ||
            !Array.isArray(inst.entries)
        ) {
            return;
        }

        const originalEntries = inst.entries;
        const filteredEntries = [];

        for (const entry of originalEntries) {

            const result = filterTimelineItem(entry);

            if (result !== null) {
                filteredEntries.push(result);
            }
        }

        /*
         * 即使过滤结果为空：
         *
         * 保持 entries 数组。
         *
         * 不删除 instruction。
         */
        inst.entries = filteredEntries;
    }


    /* =========================================================
     * 16. 处理 TimelineAddToModule
     * ======================================================= */

    function processAddToModule(inst) {

        if (
            !inst ||
            !Array.isArray(inst.moduleItems)
        ) {
            return;
        }

        inst.moduleItems =
            filterModuleItems(inst.moduleItems);
    }


    /* =========================================================
     * 17. 递归寻找 Conversation Timeline
     *
     * X GraphQL 返回结构经常变化。
     *
     * 优先使用已知路径。
     *
     * 不对未知结构进行大规模递归修改。
     * ======================================================= */

    function getKnownInstructionArrays(root) {

        const arrays = [];

        try {

            const a =
                root?.data
                    ?.threaded_conversation_with_injections_v2
                    ?.instructions;

            if (Array.isArray(a)) {
                arrays.push(a);
            }

        } catch (e) {}


        try {

            const b =
                root?.data
                    ?.tweetResult
                    ?.result
                    ?.timeline
                    ?.instructions;

            if (
                Array.isArray(b) &&
                !arrays.includes(b)
            ) {
                arrays.push(b);
            }

        } catch (e) {}


        return arrays;
    }


    /* =========================================================
     * 18. 主处理
     * ======================================================= */

    try {

        const instructionArrays =
            getKnownInstructionArrays(obj);


        /*
         * 找不到已知 Timeline：
         *
         * 原样返回。
         *
         * 不尝试猜测 X 的其他 GraphQL 结构。
         */
        if (instructionArrays.length === 0) {

            $done({
                body: rawBody
            });

            return;
        }


        for (const instructions of instructionArrays) {

            if (!Array.isArray(instructions)) {
                continue;
            }


            for (const inst of instructions) {

                if (!inst || typeof inst !== "object") {
                    continue;
                }


                /*
                 * TimelineAddEntries
                 */
                if (
                    inst.type === "TimelineAddEntries" &&
                    Array.isArray(inst.entries)
                ) {

                    processAddEntries(inst);
                    continue;
                }


                /*
                 * TimelineAddToModule
                 */
                if (
                    inst.type === "TimelineAddToModule" &&
                    Array.isArray(inst.moduleItems)
                ) {

                    processAddToModule(inst);
                    continue;
                }


                /*
                 * 其他 instruction：
                 *
                 * 完全不处理。
                 *
                 * 包括：
                 *   TimelineClearEntries
                 *   TimelineTerminateTimeline
                 *   TimelinePinEntry
                 *   Cursor
                 *   Pagination
                 *   未知类型
                 */
            }
        }


        /* =====================================================
         * 19. 返回修改后的 JSON
         * =================================================== */

        $done({
            body: JSON.stringify(obj)
        });

    } catch (e) {

        /*
         * 最终保险：
         *
         * 任何异常均原样返回。
         *
         * 宁可这次不进行过滤，
         * 也不能影响 X 评论正常加载。
         */
        $done({
            body: rawBody
        });
    }

})();
