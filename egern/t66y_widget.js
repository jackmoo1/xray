/**
 * Egern Widget Script: 草榴最新技術推送
 */

const baseURL = 'https://t66y.com/';

// 主执行入口
(async () => {
    try {
        const postList = await getPosts();
        if (!postList || postList.length === 0) {
            throw new Error('未获取到帖子列表');
        }
        
        // 默认获取最新第一条，可根据需求自行修改逻辑
        const post = postList[0];
        const postContent = await getPostContent(post);

        // 格式化日期 (获取 MM-DD HH:mm 格式)
        const dateObj = new Date(post.date);
        const dateStr = `${(dateObj.getMonth() + 1).toString().padStart(2, '0')}-${dateObj.getDate().toString().padStart(2, '0')} ${dateObj.getHours().toString().padStart(2, '0')}:${dateObj.getMinutes().toString().padStart(2, '0')}`;

        // 渲染 Egern Widget 页面
        $widget.done({
            type: "stack",
            direction: "vertical",
            gap: 6,
            padding: 12,
            url: post.href, // 点击小组件直接跳转到对应帖子
            items: [
                {
                    type: "text",
                    text: "🔔 草榴技術討論區",
                    font: { size: 13, weight: "bold" },
                    textColor: "#333333"
                },
                {
                    type: "text",
                    text: post.title,
                    font: { size: 15, weight: "bold" },
                    lineLimit: 2,
                    textColor: "#000000"
                },
                {
                    type: "text",
                    text: postContent,
                    font: { size: 12 },
                    lineLimit: 3,
                    textColor: "#666666"
                },
                {
                    type: "text",
                    text: `发布时间: ${dateStr}`,
                    font: { size: 10 },
                    textColor: "#999999"
                }
            ]
        });
    } catch (error) {
        // 异常捕获并在小组件展示错误信息
        $widget.done({
            type: "stack",
            direction: "vertical",
            padding: 12,
            items: [
                {
                    type: "text",
                    text: "⚠️ 获取数据失败",
                    font: { size: 14, weight: "bold" },
                    textColor: "#FF3B30"
                },
                {
                    type: "text",
                    text: String(error.message || error),
                    font: { size: 11 },
                    textColor: "#666666",
                    lineLimit: 3
                }
            ]
        });
    }
})();

/**
 * 获取帖子列表
 */
async function getPosts() {
    const url = baseURL + 'thread0806.php?fid=7&search=today';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP 错误 ${response.status}`);
    
    const html = await response.text();
    
    try {
        const posts = html
            .replace(/\n|\s|\r/g, '')
            .match(/<tbody.*?id=\"tbody\">(.*?)<\/tbody>/g)[0]
            .match(/<tbodystyle=\"table-layout:fixed;\"id=\"tbody\">(.*?)<\/tbody>/)[1]
            .match(/<trclass=\"tr3t_onetac"\>(.*?)<\/tr>/g)
            .map((item) => {
                try {
                    let [, href, title, date] = item.match(
                        /<h3><ahref=\"(.*?)\".*?>(.*?)<\/a><\/h3>.*?data-timestamp=\"(.*?)\"/
                    );
                    title = title.replace(/<.*?>/g, '');
                    date = Number(date.slice(-1)) ? date : date.slice(0, -1);
                    return { href: baseURL + href, title, date: Number(date) * 1000 };
                } catch (e) {
                    return null;
                }
            })
            .filter((item) => item && !/[\d+P]/.test(item.title));
            
        return posts;
    } catch (e) {
        throw new Error('解析帖子列表失败');
    }
}

/**
 * 获取帖子正文
 */
async function getPostContent(obj) {
    const response = await fetch(obj.href);
    if (!response.ok) throw new Error(`HTTP 错误 ${response.status}`);
    
    const html = await response.text();
    
    try {
        const postContent = html
            .replace(/\n|\s|\r/g, '')
            .match(/<tdbgcolor.*?valign=\"top\">(.*?)<\/td>/)[0]
            .match(/<div.*?id=\"conttpc\">(.*?)<\/div>/)[1]
            .replace(/<br><br>/g, '\n')
            .replace(/<br>/g, '\n')
            .replace(/&nbsp;/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/<.*?>/g, '');
            
        return postContent;
    } catch (e) {
        throw new Error('解析帖子内容失败');
    }
}
