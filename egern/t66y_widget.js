export default async function(ctx) {
  const baseURL = 'https://t66y.com/';
  // 从环境变量中读取配置
  const isRandom = ctx.env.IS_RANDOM === 'true';

  try {
    // 1. 获取帖子列表
    const postList = await getPosts(ctx, baseURL);
    if (!postList || postList.length === 0) {
      return renderError('未获取到相关帖子');
    }

    // 2. 获取有效帖子及内容
    const { post, postContent } = await findValidPost(ctx, postList, isRandom);

    // 3. 根据尺寸 (ctx.widgetFamily) 进行适配渲染
    
    // 适配锁屏矩形小组件 (accessoryRectangular)
    if (ctx.widgetFamily === 'accessoryRectangular') {
      return {
        type: 'widget',
        url: post.href,
        children: [
          {
            type: 'text',
            text: post.title,
            font: { size: 'headline', weight: 'bold' },
            maxLines: 2
          }
        ]
      };
    }

    // 主屏幕小组件布局 (systemSmall / systemMedium / systemLarge / systemExtraLarge)
    return {
      type: 'widget',
      url: post.href, // 点击小组件直接打开帖子链接
      padding: 14,
      gap: 8,
      backgroundColor: '#1C1C1E',
      children: [
        // 头部 Stack (标题 + 品牌图标/标识)
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 6,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:newspaper.fill',
              color: '#34C759',
              width: 16,
              height: 16
            },
            {
              type: 'text',
              text: '草榴技術討論區',
              font: { size: 'caption1', weight: 'bold' },
              textColor: '#34C759'
            },
            { type: 'spacer' },
            {
              type: 'date',
              date: new Date(post.date).toISOString(),
              format: 'relative',
              font: { size: 'caption2' },
              textColor: '#8E8E93'
            }
          ]
        },

        // 帖子标题
        {
          type: 'text',
          text: post.title,
          font: { size: 'subheadline', weight: 'bold' },
          textColor: '#FFFFFF',
          maxLines: ctx.widgetFamily === 'systemSmall' ? 2 : 1
        },

        // 帖子正文摘要（如果是小尺寸小组件，尽量精简）
        {
          type: 'text',
          text: postContent,
          font: { size: 'caption1' },
          textColor: '#D1D1D6',
          maxLines: ctx.widgetFamily === 'systemSmall' ? 3 : (ctx.widgetFamily === 'systemMedium' ? 4 : 8),
          minScale: 0.9
        }
      ]
    };
  } catch (err) {
    return renderError(`加载失败: ${err.message || err}`);
  }
}

// 错误提示界面构建
function renderError(reason) {
  return {
    type: 'widget',
    padding: 16,
    backgroundColor: '#1C1C1E',
    children: [
      {
        type: 'text',
        text: '❌ 某榴技術推送',
        font: { size: 'caption1', weight: 'bold' },
        textColor: '#FF3B30'
      },
      { type: 'spacer', length: 6 },
      {
        type: 'text',
        text: String(reason),
        font: { size: 'footnote' },
        textColor: '#EBEBF599',
        maxLines: 3
      }
    ]
  };
}

// 筛选并读取帖子内容
async function findValidPost(ctx, postList, isRandom) {
  const random = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
  let randomIdx = random(0, postList.length - 1);
  let post = !isRandom ? postList[0] : postList[randomIdx];
  let postContent = '';
  
  // 限制最大尝试次数，防止死循环
  let attempts = 0;
  while (postContent.length < 100 && attempts < 5) {
    if (attempts > 0) {
      randomIdx = random(0, postList.length - 1);
      post = postList[randomIdx];
    }
    postContent = await getPostContent(ctx, post);
    attempts++;
  }
  return { post, postContent };
}

// 获取帖子列表
async function getPosts(ctx, baseURL) {
  const url = baseURL + 'thread0806.php?fid=7&search=today';
  // 使用 Egern 原生 ctx.http API
  const resp = await ctx.http.get(url);
  const html = await resp.text();

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
        return { href: baseURL + href, title, date: date * 1e3 };
      } catch (e) {
        return null;
      }
    })
    .filter((item) => item !== null && !/[\d+P]/.test(item.title));

  return posts;
}

// 获取帖子正文
async function getPostContent(ctx, obj) {
  const { href } = obj;
  const resp = await ctx.http.get(href);
  const html = await resp.text();

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
}
