// 监听插件图标点击事件
chrome.action.onClicked.addListener((tab) => {
  // 向当前标签页发送消息
  chrome.tabs.sendMessage(tab.id, { action: "extractContent" })
    .catch(error => {
      console.log("Error sending message to content script:", error);
      
      // 如果发送消息失败，尝试通过执行脚本直接触发提取
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          // 在页面上创建并触发自定义事件
          document.dispatchEvent(new CustomEvent('WEBPAGE_EXTRACTOR_EXTRACT'));
        }
      });
    });
});

// 百度NLP API配置
const BAIDU_NLP_API = {
  tokenUrl: 'https://aip.baidubce.com/oauth/2.0/token',
  segmentUrl: 'https://aip.baidubce.com/rpc/2.0/nlp/v1/lexer',
  apiKey: 'DpDNKZcyqoRwzcU3IpJ5em3H',
  secretKey: 'z7JvXKy9JrApI2l02CIrU1Gmz8x4QAdN'
};

// 触发内容提取的函数
function triggerContentExtraction() {
  // 由于content.js已经通过manifest注入到页面中，直接发送消息即可
  chrome.tabs.sendMessage(chrome.devtools?.inspectedWindow?.tabId || chrome.runtime?.id, { action: "extractContent" });
  
  // 直接在页面上执行代码，确保消息能被正确接收
  document.dispatchEvent(new CustomEvent('WEBPAGE_EXTRACTOR_EXTRACT'));
}

// 简单的缓存实现
const apiCache = {
  // 分词结果缓存
  segmentResults: {},
  
  // 设置缓存
  setSegmentResult(text, result) {
    // 使用文本的哈希作为键
    const key = this.hashText(text);
    this.segmentResults[key] = {
      result: result,
      timestamp: Date.now()
    };
    console.log('缓存分词结果，文本长度:', text.length);
  },
  
  // 获取缓存的结果
  getSegmentResult(text) {
    const key = this.hashText(text);
    const cached = this.segmentResults[key];
    
    // 检查缓存是否存在且未过期（30分钟有效期）
    if (cached && (Date.now() - cached.timestamp < 30 * 60 * 1000)) {
      console.log('使用缓存的分词结果');
      return cached.result;
    }
    
    return null;
  },
  
  // 简单的文本哈希函数
  hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return hash.toString();
  }
};

// 最后一次API调用的时间戳
let lastApiCallTime = 0;
// API调用间隔（毫秒）
const API_CALL_INTERVAL = 1000; // 1秒

// 监听来自content.js的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getAccessToken") {
    console.log("接收到获取访问令牌的请求");
    getAccessToken()
      .then(token => {
        console.log("成功获取访问令牌，发送回content.js");
        sendResponse({ success: true, token: token });
      })
      .catch(error => {
        console.error("获取访问令牌失败:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 表示将异步发送响应
  } else if (request.action === "segmentText") {
    console.log("接收到分词请求");
    
    // 检查缓存
    const cachedResult = apiCache.getSegmentResult(request.text);
    if (cachedResult) {
      console.log("返回缓存的分词结果");
      sendResponse({ success: true, result: cachedResult });
      return true;
    }
    
    // 计算需要等待的时间
    const now = Date.now();
    const timeElapsed = now - lastApiCallTime;
    const waitTime = Math.max(0, API_CALL_INTERVAL - timeElapsed);
    
    console.log(`距离上次API调用已过去 ${timeElapsed}ms，需要等待 ${waitTime}ms`);
    
    // 添加延迟，避免触发QPS限制
    setTimeout(() => {
      segmentText(request.text, request.token)
        .then(result => {
          console.log("分词成功，发送结果回content.js");
          // 更新上次调用时间
          lastApiCallTime = Date.now();
          // 缓存结果
          apiCache.setSegmentResult(request.text, result);
          sendResponse({ success: true, result: result });
        })
        .catch(error => {
          console.error("分词请求失败:", error);
          
          // 如果是QPS限制错误，提供更友好的提示
          if (error.message && error.message.includes("qps")) {
            sendResponse({ 
              success: false, 
              error: "API调用频率超过限制，请稍后再试（建议等待几秒钟）",
              isQpsLimit: true 
            });
          } else {
            sendResponse({ success: false, error: error.message });
          }
        });
    }, waitTime);
    
    return true; // 表示将异步发送响应
  }
});

// 获取百度API的访问令牌
async function getAccessToken() {
  try {
    console.log('开始获取百度API Token...');
    
    const response = await fetch(BAIDU_NLP_API.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=client_credentials&client_id=${BAIDU_NLP_API.apiKey}&client_secret=${BAIDU_NLP_API.secretKey}`
    });
    
    if (!response.ok) {
      console.error('百度API响应状态异常:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('错误响应内容:', errorText);
      throw new Error(`获取Token失败: HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.access_token) {
      console.error('百度API返回数据中没有access_token:', data);
      throw new Error('API返回的数据格式异常');
    }
    
    console.log('成功获取百度API Token');
    return data.access_token;
  } catch (error) {
    console.error('获取百度API Token失败详情:', error);
    throw error;
  }
}

// 调用百度NLP分词API
async function segmentText(text, accessToken) {
  try {
    // 根据百度API文档，支持处理最多20000字节的文本，这里设为15000字符，保留一些安全余量
    const MAX_LENGTH = 15000;
    
    // 如果文本超长，截取前MAX_LENGTH个字符
    const processText = text.length > MAX_LENGTH ? text.substring(0, MAX_LENGTH) : text;
    
    console.log('发送分词请求，文本长度:', processText.length);
    
    const response = await fetch(`${BAIDU_NLP_API.segmentUrl}?charset=UTF-8&access_token=${accessToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: processText
      })
    });
    
    if (!response.ok) {
      console.error('分词API响应状态异常:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('错误响应内容:', errorText);
      
      // 检查是否是QPS限制错误
      if (errorText.includes('qps') || response.status === 429) {
        throw new Error(`Open api qps request limit reached`);
      }
      
      throw new Error(`分词请求失败: HTTP ${response.status}`);
    }
    
    const result = await response.json();
    
    // 详细记录API返回的数据结构
    console.log('百度分词API返回数据:', JSON.stringify(result));
    console.log('返回数据类型:', typeof result);
    console.log('返回数据是否有items字段:', result.hasOwnProperty('items'));
    
    if (result.error_code) {
      console.error('百度API返回错误码:', result.error_code, '错误信息:', result.error_msg);
      
      // 检查是否是QPS限制错误
      if (result.error_code === 17 || (result.error_msg && result.error_msg.includes('qps'))) {
        throw new Error(`Open api qps request limit reached`);
      }
      
      throw new Error(`API错误: ${result.error_msg || '未知错误'}`);
    }
    
    if (!result.items && !result.lexical_analysis) {
      console.error('API返回数据结构异常，没有找到items或lexical_analysis字段');
      throw new Error('分词结果格式异常');
    }
    
    // 兼容可能的不同API响应格式
    const items = result.items || (result.lexical_analysis ? result.lexical_analysis : []);
    
    if (items.length === 0) {
      console.warn('分词结果为空数组');
    } else {
      console.log('成功获取分词结果，条目数:', items.length);
    }
    
    // 返回标准化的结果格式
    return { 
      items: items,
      raw_result: result // 保留原始结果以便调试
    };
  } catch (error) {
    console.error('分词请求失败:', error);
    throw error;
  }
}